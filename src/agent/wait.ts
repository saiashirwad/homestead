import { Effect, FileSystem, Option, Path, Schema } from "effect";
import { loadTrackingState, type TrackingState } from "../tracking.ts";
import { resolveTargetDir } from "../worktree/plan.ts";
import { slugify } from "../text.ts";
import { Herdr } from "../herdr/service.ts";
import type { HomesteadConfig } from "../types.ts";
import { AGENT_STATUS_RELPATH, AgentStatusFileSchema, type AgentStatusFile } from "./status.ts";

// What `wait` concluded: either the agent left a valid sentinel (the only
// positive signal, carrying its own outcome), or there was no trustworthy
// signal at all (backstop tripped or the timeout elapsed).
export type WaitOutcome =
  | { readonly _tag: "status"; readonly file: AgentStatusFile }
  | { readonly _tag: "no-signal"; readonly reason: "timeout" | "idle-pane" };

// done → 0 (Unix success), failed → 1 (retry/inspect), blocked → 2 (needs a
// human), no-signal → 3 (no trustworthy signal — investigate). 0/1/2/3 is the
// whole point: an orchestrator branches differently on each.
export const exitCodeFor = (outcome: WaitOutcome): 0 | 1 | 2 | 3 => {
  if (outcome._tag === "no-signal") return 3;
  switch (outcome.file.status) {
    case "done":
      return 0;
    case "failed":
      return 1;
    case "blocked":
      return 2;
  }
};

// Tracking state wins (homestead's own record of where it put the worktree);
// otherwise the caller's fallback (the ~/worktrees/<repo>/<slug> convention).
export const pickWorktreeDir = (
  state: Option.Option<TrackingState>,
  fallback: string,
): string => {
  if (Option.isSome(state) && state.value.worktreeDir !== undefined) {
    return state.value.worktreeDir;
  }
  return fallback;
};

export const resolveWorktreeDir = Effect.fn("homestead/resolve-worktree-dir")(function* (
  repoName: string,
  branch: string,
  config: HomesteadConfig | undefined,
) {
  const path = yield* Path.Path;
  const state = yield* loadTrackingState(repoName, branch);
  const fallback = resolveTargetDir({
    dirFlag: undefined,
    config: config ?? {},
    repoName,
    slug: slugify(branch),
    branch,
    path,
  });
  return pickWorktreeDir(state, fallback);
});

const DURATION_UNITS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
};

// Parse the compact duration form used by `--timeout`/`--poll` (`30m`, `2s`,
// `500ms`, `1h`). Effect's own Duration parser wants `"30 minutes"`, which is
// not what the CLI accepts. Returns ms, or undefined for anything malformed.
export const parseCompactDuration = (input: string): number | undefined => {
  const match = input.trim().toLowerCase().match(/^(\d+)(ms|s|m|h)$/);
  if (match === null) return undefined;
  const value = Number(match[1]);
  const unit = DURATION_UNITS[match[2]!];
  return unit === undefined ? undefined : value * unit;
};

export interface WaitOptions {
  readonly worktreeDir: string;
  readonly paneId?: string | undefined;
  readonly timeoutMs: number;
  readonly pollMs: number;
  // Ignore the idle backstop for this long after start — herdr can briefly read
  // `idle` before the agent gets going, so we only trust the signal once it has
  // had time to start. Default 15s.
  readonly graceMs?: number | undefined;
  // How many consecutive idle/done reads (after the grace window) count as
  // "stopped without a sentinel". Default 3.
  readonly consecutiveIdle?: number | undefined;
}

// Read + decode the sentinel. Absent, unreadable, or malformed/partial all map
// to None ("no status yet") — never an error, so the loop just keeps polling.
const readStatus = (statusPath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(statusPath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) return Option.none<AgentStatusFile>();
    const content = yield* fs.readFileString(statusPath).pipe(Effect.orElseSucceed(() => ""));
    if (content === "") return Option.none<AgentStatusFile>();
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(AgentStatusFileSchema))(content).pipe(
      Effect.map(Option.some),
      Effect.orElseSucceed(() => Option.none<AgentStatusFile>()),
    );
  });

// What herdr's `agent_status` reports when the agent has stopped working. A
// stopped agent that left no sentinel is the backstop's whole concern; `working`
// (and `blocked`, a transient permission prompt) must NOT count. Crucially this
// no longer greps pane text for `❯` — Claude Code's TUI always draws it, so the
// text signal fired against working agents.
const STOPPED_STATUSES = new Set(["idle", "done"]);

// Poll: status file is primary, herdr's idle/done agent_status is the backstop.
// The whole loop is raced against the timeout by the caller, so it can recurse
// unbounded.
export const waitForAgent = Effect.fn("homestead/agent-wait")(function* (opts: WaitOptions) {
  const path = yield* Path.Path;
  const statusPath = path.join(opts.worktreeDir, AGENT_STATUS_RELPATH);
  const pollMs = opts.pollMs;
  const graceMs = opts.graceMs ?? 15_000;
  const consecutiveIdle = opts.consecutiveIdle ?? 3;
  const herdr = yield* Herdr;

  const step = (tick: number, idle: number): Effect.Effect<WaitOutcome, never, FileSystem.FileSystem> =>
    Effect.gen(function* () {
      const found = yield* readStatus(statusPath);
      if (Option.isSome(found)) return { _tag: "status", file: found.value } as const;

      let nextIdle = idle;
      if (opts.paneId !== undefined && tick * pollMs >= graceMs) {
        const status = yield* herdr.pane
          .get(opts.paneId)
          .pipe(Effect.orElseSucceed(() => undefined));
        nextIdle = status !== undefined && STOPPED_STATUSES.has(status) ? idle + 1 : 0;
        if (nextIdle >= consecutiveIdle) {
          return { _tag: "no-signal", reason: "idle-pane" } as const;
        }
      }

      yield* Effect.sleep(`${pollMs} millis`);
      return yield* step(tick + 1, nextIdle);
    });

  return yield* step(0, 0).pipe(
    Effect.timeoutOrElse({
      duration: `${opts.timeoutMs} millis`,
      orElse: () => Effect.succeed<WaitOutcome>({ _tag: "no-signal", reason: "timeout" }),
    }),
  );
});
