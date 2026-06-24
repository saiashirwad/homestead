import { Effect, Path } from "effect";
import { capture } from "../process.ts";

export interface Repo {
  readonly startCwd: string;
  readonly primaryRoot: string;
  readonly repoName: string;
}

// Locate the primary checkout (where the shared services + canonical .env + the
// homestead config live). git-common-dir is "<primary>/.git" for every worktree.
export const resolveRepo = Effect.fn("homestead/resolve-repo")(function* () {
  const path = yield* Path.Path;
  const startCwd = process.cwd();
  const gitCommonDirRaw = yield* capture("git", ["rev-parse", "--git-common-dir"], startCwd);
  const gitCommonDir = path.isAbsolute(gitCommonDirRaw)
    ? gitCommonDirRaw
    : path.resolve(startCwd, gitCommonDirRaw);
  const primaryRoot = path.dirname(gitCommonDir);
  return { startCwd, primaryRoot, repoName: path.basename(primaryRoot) } satisfies Repo;
});
