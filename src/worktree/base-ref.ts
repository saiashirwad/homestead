import { Effect } from "effect";
import { UsageError } from "../errors.ts";
import { capture, runExit } from "../process.ts";

export const branchFromOriginHead = (symbolicRef: string): string =>
  symbolicRef.startsWith("origin/") ? symbolicRef.slice("origin/".length) : symbolicRef;

export const refExists = (primaryRoot: string, ref: string) =>
  runExit("git", ["show-ref", "--verify", "--quiet", ref], { cwd: primaryRoot }).pipe(
    Effect.map((code) => code === 0),
  );

export const resolveDefaultBaseRef = Effect.fn("homestead/resolve-default-base-ref")(function* (
  primaryRoot: string,
) {
  const originHeadCode = yield* runExit(
    "git",
    ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    { cwd: primaryRoot },
  );
  if (originHeadCode === 0) {
    const symbolicRef = yield* capture("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], primaryRoot);
    return branchFromOriginHead(symbolicRef);
  }

  for (const branch of ["main", "master"] as const) {
    if (yield* refExists(primaryRoot, `refs/heads/${branch}`)) return branch;
  }

  return yield* new UsageError({
    message:
      "[homestead] could not determine default branch (no origin/HEAD, main, or master) — pass --from explicitly",
  });
});
