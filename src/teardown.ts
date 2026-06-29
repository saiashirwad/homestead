import { Console, Effect, Option } from "effect";
import { emit, teardownEvents } from "./events.ts";
import { worktreePathForBranch } from "./git/porcelain.ts";
import { Herdr } from "./herdr/service.ts";
import { runAfterTeardown, runBeforeTeardown, type TeardownVerb } from "./hooks.ts";
import { capture, runExit } from "./process.ts";
import { refExists } from "./worktree/base-ref.ts";
import { makeContext } from "./context.ts";
import {
  loadTrackingState,
  markCompleted,
  markFinished,
  markStopped,
  resolveReviewLabel,
  type TrackingState,
} from "./tracking.ts";
import type { HomesteadConfig, HomesteadContext, HomesteadServices } from "./types.ts";

// `homestead kill` / `homestead close` — the inverse of `issue`/`worktree`.
// Branch args are git branch names (issue flow uses `String(item.number)` as the branch).
// herdr normalizes worktree paths to realpath (/tmp -> /private/tmp), so we match the
// herdr-side worktree by branch, not path.

// Ask herdr to remove the worktree's pane/workspace. A herdr failure must NOT
// abort the git-side teardown, but it also must not be swallowed: when herdr
// can't remove the worktree, the pane and every dev server inside it keep
// running (orphaned), so we name the real failure (op + cause) and tell the user
// how to find the leftover pane instead of logging a generic "continuing".
export const removeHerdrWorktree = Effect.fn("homestead/remove-herdr-worktree")(function* (
  primaryRoot: string,
  branch: string,
) {
  const herdr = yield* Herdr;
  const wsId = yield* herdr.worktree.findOpenWorkspaceId(primaryRoot, branch).pipe(
    Effect.catchTag("HerdrError", () => Effect.void),
  );
  if (wsId === undefined) {
    yield* Console.log(`  (no open herdr worktree for '${branch}')`);
    return;
  }
  yield* Console.log(`  herdr worktree remove --workspace ${wsId} --force --json`);
  yield* herdr.worktree.remove(wsId).pipe(
    Effect.catchTag("HerdrError", (e) =>
      Console.log(
        `  ⚠ herdr remove failed (op=${e.op}): ${String(e.cause)} — pane and its dev servers may ` +
          `still be running; run 'herdr worktree list' to check.`,
      ),
    ),
  );
});

const teardownWorktree = Effect.fn("homestead/teardown-worktree")(function* (
  primaryRoot: string,
  branch: string,
  tracking: Effect.Effect<void, never, HomesteadServices>,
) {
  yield* tracking;

  yield* removeHerdrWorktree(primaryRoot, branch);

  const porcelain = yield* capture("git", ["worktree", "list", "--porcelain"], primaryRoot);
  const path = worktreePathForBranch(porcelain, branch);
  if (path !== undefined) {
    yield* Console.log(`  git worktree remove --force ${path}`);
    const removeCode = yield* runExit("git", ["worktree", "remove", "--force", path], { cwd: primaryRoot });
    if (removeCode !== 0) {
      yield* Console.log(`  ⚠ git worktree remove failed (exit ${removeCode})`);
    }
  }
  const pruneCode = yield* runExit("git", ["worktree", "prune"], { cwd: primaryRoot });
  if (pruneCode !== 0) {
    yield* Console.log(`  ⚠ git worktree prune failed (exit ${pruneCode})`);
  }
});

// Delete the remote branch, with two guards:
//   1. Hard floor: only ever delete branches we own (issue flow writes tracking
//      state; PR review never does). No flag overrides this — we must not delete
//      a PR author's remote head branch.
//   2. Opt-out: `--keep-remote` skips deletion even for our own branches.
const deleteRemoteBranch = Effect.fn("homestead/delete-remote-branch")(function* (
  primaryRoot: string,
  branch: string,
  tracked: Option.Option<TrackingState>,
  keepRemote: boolean,
) {
  if (keepRemote) {
    yield* Console.log(`  (keeping remote '${branch}' — --keep-remote)`);
    return;
  }
  if (Option.isNone(tracked)) return;
  yield* runExit("git", ["push", "origin", "--delete", branch], { cwd: primaryRoot }).pipe(
    Effect.catchDefect(() => Effect.void),
  );
});

const deleteLocalBranch = Effect.fn("homestead/delete-local-branch")(function* (primaryRoot: string, branch: string) {
  if (yield* refExists(primaryRoot, `refs/heads/${branch}`)) {
    const code = yield* runExit("git", ["branch", "-D", branch], { cwd: primaryRoot });
    if (code !== 0) {
      yield* Console.log(`  ⚠ git branch -D ${branch} failed (exit ${code}) — is it checked out elsewhere?`);
    }
  } else {
    yield* Console.log(`  (branch '${branch}' already gone)`);
  }
});

const runBranchTeardown = Effect.fn("homestead/run-branch-teardown")(function* (input: {
  readonly verb: Extract<TeardownVerb, "kill" | "complete">;
  readonly primaryRoot: string;
  readonly repoName: string;
  readonly branch: string;
  readonly keepRemote: boolean;
  readonly config: HomesteadConfig | undefined;
  readonly tracking: Effect.Effect<void, never, HomesteadServices>;
}) {
  const { verb, primaryRoot, repoName, branch, keepRemote, config, tracking } = input;

  yield* emit(config?.onEvent, teardownEvents(verb, branch, "start"));

  // Read tracking state BEFORE teardownWorktree: markStopped/markCompleted delete the file.
  // Only the issue flow writes tracking state; PR review never does — gating here
  // prevents kill/complete on a same-repo PR review from deleting the PR author's remote head.
  const tracked = yield* loadTrackingState(repoName, branch);
  const ctx = makeContext({ repoName, slug: branch, branch, worktreeDir: "" });

  yield* runBeforeTeardown(config?.beforeTeardown, ctx, verb, Option.isSome(tracked));
  yield* teardownWorktree(primaryRoot, branch, tracking);
  yield* deleteLocalBranch(primaryRoot, branch);
  yield* deleteRemoteBranch(primaryRoot, branch, tracked, keepRemote);
  yield* runAfterTeardown(config?.afterTeardown, ctx, verb);
  yield* emit(config?.onEvent, teardownEvents(verb, branch, "done"));
});

export const killBranch = Effect.fn("homestead/kill-branch")(function* (
  primaryRoot: string,
  repoName: string,
  branch: string,
  keepRemote = false,
  config?: HomesteadConfig,
) {
  yield* runBranchTeardown({
    verb: "kill",
    primaryRoot,
    repoName,
    branch,
    keepRemote,
    config,
    tracking: markStopped(repoName, branch, config?.issues),
  });
});

export const closeBranch = Effect.fn("homestead/close-branch")(function* (
  primaryRoot: string,
  repoName: string,
  branch: string,
  reviewLabel: string,
  config?: HomesteadConfig,
) {
  yield* emit(config?.onEvent, teardownEvents("close", branch, "start"));

  const trackedState = yield* loadTrackingState(repoName, branch);
  const tracked = Option.isSome(trackedState);
  const resolvedReviewLabel = resolveReviewLabel(reviewLabel, config?.issues, trackedState);
  const ctx = makeContext({ repoName, slug: branch, branch, worktreeDir: "" });

  yield* runBeforeTeardown(config?.beforeTeardown, ctx, "close", tracked);

  yield* teardownWorktree(
    primaryRoot,
    branch,
    markFinished(repoName, branch, resolvedReviewLabel, config?.issues),
  );

  yield* runAfterTeardown(config?.afterTeardown, ctx, "close", resolvedReviewLabel);
  yield* emit(config?.onEvent, teardownEvents("close", branch, "done", resolvedReviewLabel));
});

export const completeBranch = Effect.fn("homestead/complete-branch")(function* (
  primaryRoot: string,
  repoName: string,
  branch: string,
  keepRemote = false,
  config?: HomesteadConfig,
) {
  yield* runBranchTeardown({
    verb: "complete",
    primaryRoot,
    repoName,
    branch,
    keepRemote,
    config,
    tracking: markCompleted(repoName, branch, config?.issues),
  });
});
