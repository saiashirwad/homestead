import { Console, Effect, Schedule } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as childProcess from "node:child_process";
import * as net from "node:net";

// Subprocess + probe primitives, ported from worktree-setup.ts to Effect 4. The
// v3 `Command.make(...).pipe(Command.string)` builder became `ChildProcess.make`
// (the command) + the `ChildProcessSpawner` service (the runner: .string /
// .exitCode). Spawn/IO failures are demoted to defects — this is dev tooling.

interface RunOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string>;
}

// NOTE: v4 ChildProcess REPLACES the child env when `env` is set (unlike v3's
// Command.env, which merged). So we merge process.env underneath the injected
// vars — otherwise injecting e.g. DATABASE_URL would drop PATH and the command
// (pnpm, docker, …) wouldn't be found. Injected vars still win.
const makeOptions = (options: RunOptions | undefined) => ({
  ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
  ...(options?.env === undefined ? {} : { env: { ...process.env, ...options.env } }),
});

// Run a subprocess and return its exit code. Inherits stdio.
export const runExit = Effect.fn("homestead/run-exit")(function* (
  command: string,
  args: ReadonlyArray<string>,
  options?: RunOptions,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  yield* Console.log(`  $ ${command} ${args.join(" ")}`);

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
export const run = Effect.fn("homestead/run")(function* (
  label: string,
  command: string,
  args: ReadonlyArray<string>,
  options?: RunOptions,
) {
  const code = yield* runExit(command, args, options);
  if (code !== 0) {
    return yield* Effect.die(
      new Error(`[homestead] ${label} failed: ${command} ${args.join(" ")} (exit ${code})`),
    );
  }
});

// Run a subprocess and capture its trimmed stdout (for git / gh / herdr plumbing).
export const capture = Effect.fn("homestead/capture")(function* (
  command: string,
  args: ReadonlyArray<string>,
  cwd?: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const cmd = ChildProcess.make(command, args, cwd === undefined ? {} : { cwd });
  const out = yield* spawner.string(cmd).pipe(Effect.orDie);
  return out.trim();
});

// Spawn a long-lived background process detached from homestead's own lifetime
// and return its PID. Unlike runExit/capture (whose children die with the Effect
// scope via ChildProcessSpawner), this uses node:child_process with
// `detached: true` + `unref()` so the child keeps running after homestead exits.
// A hook starts a per-worktree dev server this way, then hands the PID to
// recordServerPid so teardown can kill it later. stdio is "ignore" so the
// detached child doesn't tie up homestead's pipes.
export const spawnDetached = (
  command: string,
  args: ReadonlyArray<string>,
  options?: RunOptions,
): Effect.Effect<number> =>
  Effect.sync(() => {
    const child = childProcess.spawn(command, [...args], {
      ...makeOptions(options),
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    if (child.pid === undefined) {
      throw new Error(`[homestead] spawnDetached: ${command} produced no pid`);
    }
    return child.pid;
  });

// Send `signal` (default SIGTERM) to `pid`, swallowing ESRCH — i.e. a PID that's
// already gone is a no-op. Other errors (e.g. EPERM) propagate. Reused by
// killServers.
export const killPid = (pid: number, signal: NodeJS.Signals | number = "SIGTERM"): void => {
  try {
    process.kill(pid, signal);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
  }
};

// TCP liveness probe (no platform equivalent) — tells whether a shared service
// (e.g. docker Postgres) is up before we lean on it.
export const probeTcp = (host: string, port: number, timeoutMs: number) =>
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
    return Effect.sync(() => socket.destroy());
  });

// One-second poll, capped at `retries`. v3's `Schedule.intersect` is `Schedule.both`
// in v4 — continue only while BOTH (always-spaced AND recurs-N) want to recur.
export const pollSchedule = (retries: number) =>
  Schedule.spaced("1 second").pipe(Schedule.both(Schedule.recurs(retries)));
