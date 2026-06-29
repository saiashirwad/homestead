import { Schema } from "effect";

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
