import { Effect, FileSystem, Path, Schema } from "effect";

// The sentinel the *agent* writes inside its own worktree when it stops. This is
// distinct from homestead's tracking state (~/.homestead/state/...): that is
// homestead's record of what it provisioned; this is the agent reporting on
// itself. Lives at <worktree>/.homestead/agent-status.json and must never be
// committed (the setup docs add `.homestead/` to .gitignore).
export const AGENT_STATUS_RELPATH = ".homestead/agent-status.json";

export const AgentStatusValue = Schema.Literals(["done", "blocked", "failed"]);
export type AgentStatusValue = typeof AgentStatusValue.Type;

export const AgentStatusFileSchema = Schema.Struct({
  status: AgentStatusValue,
  summary: Schema.String,
  details: Schema.optional(Schema.String),
  at: Schema.optional(Schema.String), // ISO-8601, best-effort, written by the agent
});
export type AgentStatusFile = typeof AgentStatusFileSchema.Type;

// Remove the sentinel so a *new* turn's `agent wait` blocks instead of reading
// the previous turn's stale `done`. Missing file is a no-op (orElseSucceed) —
// same forgiving pattern as tracking.ts's teardown removals. `relpath` defaults
// to AGENT_STATUS_RELPATH but honors a marker's recorded statusFile path.
export const clearAgentStatus = Effect.fn("homestead/clear-agent-status")(function* (
  worktreeDir: string,
  relpath: string = AGENT_STATUS_RELPATH,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.remove(path.join(worktreeDir, relpath)).pipe(Effect.orElseSucceed(() => undefined));
});
