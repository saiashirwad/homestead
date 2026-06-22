import { Console, Context, Effect, Schedule, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as net from "node:net";

// When true (provided under the TUI scope), runExit/run CAPTURE subprocess output
// and re-emit it line-by-line via Console.log — so a custom Console can route it
// into the dashboard instead of letting it scribble over the rendered UI. Default
// false: subprocesses inherit stdio exactly as before (the plain CLI path).
export const OutputCapture = Context.Reference<boolean>("githog/OutputCapture", {
  defaultValue: () => false,
});

// Subprocess + probe primitives, ported from worktree-setup.ts to Effect 4. The
// v3 `Command.make(...).pipe(Command.string)` builder became `ChildProcess.make`
// (the command) + the `ChildProcessSpawner` service (the runner: .string /
// .exitCode). Spawn/IO failures are demoted to defects — this is dev tooling.

interface RunOptions {
  readonly cwd?: string | undefined;
  readonly env?: Record<string, string> | undefined;
}

// NOTE: v4 ChildProcess REPLACES the child env when `env` is set (unlike v3's
// Command.env, which merged). So we merge process.env underneath the injected
// vars — otherwise injecting e.g. DATABASE_URL would drop PATH and the command
// (pnpm, docker, …) wouldn't be found. Injected vars still win.
const makeOptions = (options: RunOptions | undefined) => ({
  ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
  ...(options?.env === undefined ? {} : { env: { ...process.env, ...options.env } }),
});

// Run a subprocess and return its exit code. Inherits stdio by default; under the
// TUI scope (OutputCapture = true) it pipes stdout+stderr and re-emits each line
// via Console.log so the dashboard can capture it.
export const runExit = Effect.fn("githog/run-exit")(function* (
  command: string,
  args: ReadonlyArray<string>,
  options?: RunOptions,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  yield* Console.log(`  $ ${command} ${args.join(" ")}`);

  if (yield* OutputCapture) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make(command, args, { ...makeOptions(options), stdout: "pipe", stderr: "pipe" }),
        );
        const drain = Stream.runForEach(Stream.splitLines(Stream.decodeText(handle.all)), (line) =>
          Console.log(line),
        );
        const [, code] = yield* Effect.all([drain, handle.exitCode], { concurrency: "unbounded" });
        return Number(code);
      }),
    ).pipe(Effect.orDie);
  }

  const cmd = ChildProcess.make(command, args, {
    ...makeOptions(options),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = yield* spawner.exitCode(cmd).pipe(Effect.orDie);
  return Number(code);
});

// Run a subprocess and die if it exits non-zero. Use when failure is fatal.
export const run = Effect.fn("githog/run")(function* (
  label: string,
  command: string,
  args: ReadonlyArray<string>,
  options?: RunOptions,
) {
  const code = yield* runExit(command, args, options);
  if (code !== 0) {
    return yield* Effect.die(new Error(`[githog] ${label} failed (exit ${code})`));
  }
  return code;
});

// Run a subprocess, streaming each output line live to our stdout (so it scrolls
// in the herdr pane the loop runs in) AND accumulating the full output, returned
// alongside the exit code. The Ralph loop needs claude -p's output BOTH watchable
// and parseable for sentinels — `capture` hides it, `runExit` discards it.
export const captureStreaming = Effect.fn("githog/capture-streaming")(function* (
  command: string,
  args: ReadonlyArray<string>,
  options?: RunOptions,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  yield* Console.log(`  $ ${command} ${args.join(" ")}`);

  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(command, args, { ...makeOptions(options), stdout: "pipe", stderr: "pipe" }),
      );
      const lines: Array<string> = [];
      const drain = Stream.runForEach(Stream.splitLines(Stream.decodeText(handle.all)), (line) =>
        Effect.gen(function* () {
          lines.push(line);
          yield* Console.log(line);
        }),
      );
      const [, code] = yield* Effect.all([drain, handle.exitCode], { concurrency: "unbounded" });
      return { code: Number(code), output: lines.join("\n") };
    }),
  ).pipe(Effect.orDie);
});

// Run a subprocess and capture its trimmed stdout (for git / gh / herdr plumbing).
export const capture = Effect.fn("githog/capture")(function* (
  command: string,
  args: ReadonlyArray<string>,
  cwd?: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const cmd = ChildProcess.make(command, args, cwd === undefined ? {} : { cwd });
  const out = yield* spawner.string(cmd).pipe(Effect.orDie);
  return out.trim();
});

// TCP liveness probe (no platform equivalent) — tells whether a shared service
// (e.g. docker Postgres) is up before we lean on it.
export const probeTcp = (host: string, port: number, timeoutMs: number): Effect.Effect<boolean> =>
  Effect.callback<boolean>((resume) => {
    const socket = new net.Socket();
    const settle = (ok: boolean) => {
      socket.destroy();
      resume(Effect.succeed(ok));
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
    socket.connect(port, host);
  });

// One-second poll, capped at `retries`. v3's `Schedule.intersect` is `Schedule.both`
// in v4 — continue only while BOTH (always-spaced AND recurs-N) want to recur.
export const pollSchedule = (retries: number) =>
  Schedule.spaced("1 second").pipe(Schedule.both(Schedule.recurs(retries)));
