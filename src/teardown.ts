import { Console, Effect, Schema } from "effect";
import { capture, runExit } from "./process.ts";
import { markStopped } from "./tracking.ts";

// `githog kill` — the inverse of implement-issues/setup. For a branch it: closes
// the herdr worktree workspace (which also removes the git worktree), reconciles
// any leftover git worktree, then deletes the branch. All steps are best-effort
// and idempotent: anything already gone is skipped, so re-running is safe.

// herdr normalizes worktree paths to their realpath (/tmp -> /private/tmp), so we
// match the herdr-side worktree by BRANCH, not path.
const HerdrWorktrees = Schema.Struct({
  result: Schema.Struct({
    worktrees: Schema.Array(
      Schema.Struct({
        branch: Schema.optional(Schema.NullOr(Schema.String)),
        open_workspace_id: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  }),
});
const decodeHerdrWorktrees = Schema.decodeUnknownEffect(Schema.fromJsonString(HerdrWorktrees));

// The git worktree path checked out on `branch` (porcelain), or undefined.
const worktreePathForBranch = Effect.fn("githog/worktree-path")(function* (
  primaryRoot: string,
  branch: string,
) {
  const out = yield* capture("git", ["worktree", "list", "--porcelain"], primaryRoot);
  let current: string | undefined;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = line.slice("worktree ".length).trim();
    } else if (line.startsWith("branch ") && line.slice("branch ".length).trim() === `refs/heads/${branch}`) {
      return current;
    }
  }
  return undefined;
});

// The herdr workspace id whose worktree is on `branch`, or undefined when no herdr
// worktree is open for it (or herdr isn't reachable — best-effort).
const herdrWorkspaceForBranch = Effect.fn("githog/herdr-workspace")(function* (
  primaryRoot: string,
  branch: string,
) {
  const json = yield* capture("herdr", ["worktree", "list", "--cwd", primaryRoot, "--json"]).pipe(
    Effect.catchCause(() => Effect.succeed("")),
  );
  if (json === "") return undefined;
  const list = yield* decodeHerdrWorktrees(json).pipe(Effect.catchCause(() => Effect.succeed(undefined)));
  if (list === undefined) return undefined;
  return list.result.worktrees.find((wt) => wt.branch === branch)?.open_workspace_id ?? undefined;
});

export const killBranch = Effect.fn("githog/kill-branch")(function* (
  primaryRoot: string,
  repoName: string,
  branch: string,
) {
  yield* Console.log(`\n▸ Killing '${branch}'`);

  // 0. reverse any GitHub issue signals githog applied at launch (opt-in; reads a
  // state file, so config-free and a no-op when nothing was tracked).
  yield* markStopped(repoName, branch);

  // 1. herdr: remove the worktree workspace. This closes the workspace AND removes
  // the git worktree (but not the branch). Best-effort: herdr may not be running.
  const wsId = yield* herdrWorkspaceForBranch(primaryRoot, branch);
  if (wsId !== undefined) {
    yield* Console.log(`  herdr worktree remove --workspace ${wsId} --force`);
    yield* capture("herdr", ["worktree", "remove", "--workspace", wsId, "--force", "--json"]).pipe(
      Effect.catchCause(() => Console.log(`  ⚠ herdr remove failed (continuing)`)),
    );
  } else {
    yield* Console.log(`  (no open herdr worktree for '${branch}')`);
  }

  // 2. reconcile git: if the worktree is still registered (herdr wasn't open, or
  // didn't remove it), remove it ourselves; then prune stale entries.
  const path = yield* worktreePathForBranch(primaryRoot, branch);
  if (path !== undefined) {
    yield* Console.log(`  git worktree remove --force ${path}`);
    yield* runExit("git", ["worktree", "remove", "--force", path], { cwd: primaryRoot });
  }
  yield* runExit("git", ["worktree", "prune"], { cwd: primaryRoot });

  // 3. delete the branch (worktree removal leaves it behind).
  const branchExists =
    (yield* runExit("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
      cwd: primaryRoot,
    })) === 0;
  if (branchExists) {
    const code = yield* runExit("git", ["branch", "-D", branch], { cwd: primaryRoot });
    if (code !== 0) {
      yield* Console.log(`  ⚠ git branch -D ${branch} failed (exit ${code}) — is it checked out elsewhere?`);
    }
  } else {
    yield* Console.log(`  (branch '${branch}' already gone)`);
  }

  // 4. delete the remote branch too. A leftover origin/<branch> from a prior run
  // has unrelated history, so a re-run's `git push` is rejected non-fast-forward —
  // and (until the runner blocks on that) a PR gets opened against the stale
  // remote, missing the real work. Best-effort: no remote / already gone is fine.
  yield* runExit("git", ["push", "origin", "--delete", branch], { cwd: primaryRoot }).pipe(
    Effect.catchCause(() => Effect.succeed(1)),
  );

  yield* Console.log(`  ✓ killed '${branch}'`);
});
