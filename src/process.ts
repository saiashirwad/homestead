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

// What one structured agent invocation yields back to the loop runner: the exit
// code, the agent's final result TEXT (parsed for sentinels — far cleaner than
// grepping the whole noisy stream), the claude session id (for resume-mode
// continuity), and a coarse stop reason for logging.
export interface AgentInvocation {
  readonly code: number;
  readonly result: string;
  readonly sessionId: string | undefined;
  readonly stopReason: string | undefined;
}

// Run claude in `--output-format stream-json` mode and interpret its NDJSON event
// envelope (ADR-0002). Each assistant text block is re-emitted live so the run
// still scrolls watchably in the herdr pane, while the structured `result` /
// `session_id` are captured for the loop's decision + continuity — replacing the
// old "stream raw text, grep stdout for a magic string" approach. The caller
// supplies the claude args (including `-p <prompt>`, `--output-format stream-json
// --verbose`, and any `--resume <id>`); stdout carries the JSON, stderr is echoed
// raw. Non-JSON stdout lines (stray warnings) are echoed rather than dropped.
export const captureAgent = Effect.fn("githog/capture-agent")(function* (
  command: string,
  args: ReadonlyArray<string>,
  options?: RunOptions,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  yield* Console.log(`  $ ${command} ${args.join(" ")}`);

  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        // stdin: "ignore" (= /dev/null) — headless `claude -p` takes its prompt
        // from argv; without this it blocks ~3s each invocation waiting on stdin.
        ChildProcess.make(command, args, { ...makeOptions(options), stdin: "ignore", stdout: "pipe", stderr: "pipe" }),
      );

      let result = "";
      let assistantText = "";
      let sessionId: string | undefined;
      let stopReason: string | undefined;

      const onJsonLine = (line: string) =>
        Effect.gen(function* () {
          const trimmed = line.trim();
          if (trimmed === "") return;
          let evt: Record<string, unknown>;
          try {
            evt = JSON.parse(trimmed) as Record<string, unknown>;
          } catch {
            yield* Console.log(line); // not JSON (a stray warning) — show it, don't drop it
            return;
          }
          if (typeof evt["session_id"] === "string") sessionId = evt["session_id"];

          if (evt["type"] === "assistant") {
            const message = evt["message"] as { content?: ReadonlyArray<Record<string, unknown>> } | undefined;
            for (const block of message?.content ?? []) {
              if (block["type"] === "text" && typeof block["text"] === "string") {
                assistantText += `${block["text"]}\n`;
                yield* Console.log(block["text"]);
              } else if (block["type"] === "tool_use" && typeof block["name"] === "string") {
                yield* Console.log(`  ⚙ ${block["name"]}`);
              }
            }
          } else if (evt["type"] === "result") {
            if (typeof evt["result"] === "string") result = evt["result"];
            const subtype = typeof evt["subtype"] === "string" ? evt["subtype"] : undefined;
            stopReason = evt["is_error"] === true ? `error${subtype ? `:${subtype}` : ""}` : subtype;
          }
        });

      const drainOut = Stream.runForEach(Stream.splitLines(Stream.decodeText(handle.stdout)), onJsonLine);
      const drainErr = Stream.runForEach(Stream.splitLines(Stream.decodeText(handle.stderr)), (line) =>
        Console.log(line),
      );
      const [, , code] = yield* Effect.all([drainOut, drainErr, handle.exitCode], { concurrency: "unbounded" });
      // Fall back to the streamed assistant text if no result event arrived (e.g. a
      // crash mid-turn), so the runner still has something to parse for sentinels.
      return { code: Number(code), result: result === "" ? assistantText : result, sessionId, stopReason };
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
