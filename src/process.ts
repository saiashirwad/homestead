import { Console, Effect, Schedule } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as childProcess from "node:child_process";
import * as net from "node:net";

interface RunOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string>;
}

const makeOptions = (options: RunOptions | undefined) => ({
  ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
  ...(options?.env === undefined ? {} : { env: { ...process.env, ...options.env } }),
});

export const runExit = Effect.fnUntraced(function* (
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

export const run = Effect.fnUntraced(function* (
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

export const capture = Effect.fnUntraced(function* (
  command: string,
  args: ReadonlyArray<string>,
  cwd?: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const cmd = ChildProcess.make(command, args, cwd === undefined ? {} : { cwd });
  const out = yield* spawner.string(cmd).pipe(Effect.orDie);
  return out.trim();
});

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

export const killPid = (pid: number, signal: NodeJS.Signals | number = "SIGTERM"): void => {
  try {
    process.kill(pid, signal);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
  }
};

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

export const pollSchedule = (retries: number) =>
  Schedule.recurs(retries).pipe(Schedule.addDelay(() => Effect.succeed("1 second")));
