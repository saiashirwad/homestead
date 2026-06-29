import { Console, Context, Effect, Layer } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

export type MergeResult =
  | { readonly _tag: "Merged" }
  | { readonly _tag: "Conflict"; readonly files: ReadonlyArray<string> };

export class Git extends Context.Service<Git>()("Git", {
  make: Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    // Capture trimmed stdout. Spawn/IO failure is a defect (dev tooling).
    const capture = (cwd: string, args: ReadonlyArray<string>) =>
      spawner
        .string(ChildProcess.make("git", args, { cwd }))
        .pipe(Effect.map((s) => s.trim()), Effect.orDie);

    // Run, inherit stdio so git's own output shows, return the exit code.
    // Mirrors process.ts runExit (logs the command, demotes spawn errors to defects).
    const exit = (cwd: string, args: ReadonlyArray<string>) =>
      Console.log(`  $ git ${args.join(" ")}`).pipe(
        Effect.andThen(
          spawner.exitCode(
            ChildProcess.make("git", args, {
              cwd,
              stdin: "inherit",
              stdout: "inherit",
              stderr: "inherit",
            }),
          ),
        ),
        Effect.map(Number),
        Effect.orDie,
      );

    // Run; die if non-zero. For mutations whose failure is fatal.
    const mutate = (cwd: string, args: ReadonlyArray<string>) =>
      exit(cwd, args).pipe(
        Effect.flatMap((code) =>
          code === 0
            ? Effect.void
            : Effect.die(new Error(`[homestead] git ${args.join(" ")} failed (exit ${code}) in ${cwd}`)),
        ),
      );

    // Run; ignore the exit code. For tolerant mutations (target may already be gone).
    const attempt = (cwd: string, args: ReadonlyArray<string>) =>
      exit(cwd, args).pipe(Effect.asVoid);

    const splitLines = (s: string) =>
      s
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);

    return {
      commonDir: (cwd: string) => capture(cwd, ["rev-parse", "--git-common-dir"]),

      refExists: (cwd: string, ref: string) =>
        exit(cwd, ["show-ref", "--verify", "--quiet", ref]).pipe(Effect.map((code) => code === 0)),

      symbolicRef: (cwd: string, name: string) =>
        exit(cwd, ["symbolic-ref", "--short", name]).pipe(
          Effect.flatMap((code) =>
            code === 0 ? capture(cwd, ["symbolic-ref", "--short", name]) : Effect.succeed(undefined),
          ),
        ),

      merge: (cwd: string, branch: string) =>
        exit(cwd, ["merge", "--no-ff", "--no-commit", branch]).pipe(
          Effect.flatMap((code): Effect.Effect<MergeResult> =>
            code === 0
              ? Effect.succeed({ _tag: "Merged" } as const)
              : capture(cwd, ["diff", "--name-only", "--diff-filter=U"]).pipe(
                  Effect.map((out) => ({ _tag: "Conflict", files: splitLines(out) }) as const),
                ),
          ),
        ),

      abortMerge: (cwd: string) => attempt(cwd, ["merge", "--abort"]),

      mergeBaseIsAncestor: (cwd: string, ref: string, base: string) =>
        exit(cwd, ["merge-base", "--is-ancestor", ref, base]).pipe(Effect.map((code) => code === 0)),

      addAll: (cwd: string) => mutate(cwd, ["add", "-A"]),

      commitNoEdit: (cwd: string) => mutate(cwd, ["commit", "--no-edit"]),

      currentBranch: (cwd: string) => capture(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),

      status: (cwd: string) => capture(cwd, ["status", "--porcelain"]),

      stash: {
        push: (cwd: string, message: string) =>
          exit(cwd, ["stash", "push", "-u", "-m", message]).pipe(Effect.map((code) => code === 0)),
        pop: (cwd: string) => exit(cwd, ["stash", "pop"]).pipe(Effect.map((code) => code === 0)),
      },
    };
  }),
}) {}

export const GitLive = Layer.effect(Git, Git.make);
