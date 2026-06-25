import { Console, Effect } from "effect";
import { worktreePathForBranch } from "./git/porcelain.ts";
import { Herdr } from "./herdr/service.ts";
import { capture, runExit } from "./process.ts";
import { refExists } from "./worktree/base-ref.ts";
import { markCompleted, markFinished, markStopped } from "./tracking.ts";
import type { HomesteadServices } from "./types.ts";

// `homestead kill` / `homestead close` — the inverse of `issue`/`worktree`.
// Branch args are git branch names (issue flow uses `String(item.number)` as the branch).
// herdr normalizes worktree paths to realpath (/tmp -> /private/tmp), so we match the
// herdr-side worktree by branch, not path.

const teardownWorktree = Effect.fn("homestead/teardown-worktree")(function* (
  primaryRoot: string,
  branch: string,
  tracking: Effect.Effect<void, never, HomesteadServices>,
) {
  yield* tracking;

  const herdr = yield* Herdr;
  const wsId = yield* herdr.worktree.findOpenWorkspaceId(primaryRoot, branch).pipe(
    Effect.catchTag("HerdrError", () => Effect.succeed(undefined)),
  );
  if (wsId !== undefined) {
    yield* Console.log(`  herdr worktree remove --workspace ${wsId} --force --json`);
    const removed = yield* herdr.worktree.remove(wsId).pipe(
      Effect.as(true),
      Effect.catchTag("HerdrError", () => Effect.succeed(false)),
    );
    if (removed === false) {
      yield* Console.log(`  ⚠ herdr remove failed (continuing)`);
    }
  } else {
    yield* Console.log(`  (no open herdr worktree for '${branch}')`);
  }

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

export const killBranch = Effect.fn("homestead/kill-branch")(function* (
  primaryRoot: string,
  repoName: string,
  branch: string,
) {
  yield* Console.log(`\n▸ Killing '${branch}'`);

  yield* teardownWorktree(primaryRoot, branch, markStopped(repoName, branch));

  if (yield* refExists(primaryRoot, `refs/heads/${branch}`)) {
    const code = yield* runExit("git", ["branch", "-D", branch], { cwd: primaryRoot });
    if (code !== 0) {
      yield* Console.log(`  ⚠ git branch -D ${branch} failed (exit ${code}) — is it checked out elsewhere?`);
    }
  } else {
    yield* Console.log(`  (branch '${branch}' already gone)`);
  }

  yield* runExit("git", ["push", "origin", "--delete", branch], { cwd: primaryRoot }).pipe(
    Effect.catchDefect(() => Effect.succeed(undefined)),
  );

  yield* Console.log(`  ✓ killed '${branch}'`);
});

export const closeBranch = Effect.fn("homestead/close-branch")(function* (
  primaryRoot: string,
  repoName: string,
  branch: string,
  reviewLabel: string,
) {
  yield* Console.log(`\n▸ Closing '${branch}'`);

  yield* teardownWorktree(primaryRoot, branch, markFinished(repoName, branch, reviewLabel));

  yield* Console.log(`  ✓ closed '${branch}' (branch kept, issue → ${reviewLabel})`);
});

export const completeBranch = Effect.fn("homestead/complete-branch")(function* (
  primaryRoot: string,
  repoName: string,
  branch: string,
) {
  yield* Console.log(`\n▸ Completing '${branch}'`);

  yield* teardownWorktree(primaryRoot, branch, markCompleted(repoName, branch));

  if (yield* refExists(primaryRoot, `refs/heads/${branch}`)) {
    const code = yield* runExit("git", ["branch", "-D", branch], { cwd: primaryRoot });
    if (code !== 0) {
      yield* Console.log(`  ⚠ git branch -D ${branch} failed (exit ${code}) — is it checked out elsewhere?`);
    }
  } else {
    yield* Console.log(`  (branch '${branch}' already gone)`);
  }

  yield* runExit("git", ["push", "origin", "--delete", branch], { cwd: primaryRoot }).pipe(
    Effect.catchDefect(() => Effect.succeed(undefined)),
  );

  yield* Console.log(`  ✓ completed '${branch}' (issue closed, branch removed)`);
});
