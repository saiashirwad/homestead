import { Console, Context, Effect, Layer } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

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
    };
  }),
}) {}

export const GitLive = Layer.effect(Git, Git.make);
