// homestead — config-driven git-worktree + agent provisioning, built on Effect.
//
// Public surface for authoring a homestead.config.ts and for embedding the
// provisioner in your own Effect programs. The CLI lives in src/cli.ts
// (bin: `homestead`).

export { defineConfig, loadConfig, loadConfigOrUndefined } from "./src/config.ts";
export { setupWorktree } from "./src/worktree/index.ts";
export { resolveIssue } from "./src/issues.ts";
export { launchAgent } from "./src/herdr/agent.ts";
export { Herdr } from "./src/herdr/service.ts";
export { HerdrError, HerdrNotAvailable, HerdrTimeout } from "./src/herdr/errors.ts";
export { HerdrTest } from "./src/herdr/test.ts";
export { toSpec } from "./src/herdr/launch.ts";
export { launchIssue, launchIssues } from "./src/issue/provision.ts";
export type { LaunchAgentInput } from "./src/herdr/agent.ts";
export type { LaunchIssueInput, LaunchIssuesInput } from "./src/issue/provision.ts";
export { ConfigInvalid, ConfigNotFound, ServiceUnavailable } from "./src/errors.ts";
export {
  DEFAULT_AGENT_COMMAND,
  DEFAULT_AGENT_READY_MARKER,
  DEFAULT_CLAUDE_TRUST_PROMPT,
  defaultAgentPrompt,
  resolveAgentDefaults,
} from "./src/agent/defaults.ts";
export {
  DEFAULT_ENV_FALLBACK,
  DEFAULT_ENV_SOURCE,
  DEFAULT_REVIEW_LABEL,
  DEFAULT_SERVICE_TIMEOUT_MS,
} from "./src/defaults.ts";
export { WorkItemSchema } from "./src/work-item.ts";
export type {
  AgentConfig,
  AgentPromptContext,
  EnvConfig,
  HomesteadConfig,
  HomesteadServices,
  IssuesConfig,
  Plan,
  PortSpec,
  ServiceSpec,
  SetupStep,
  TrackingContext,
  WorkItem,
  WorktreeContext,
  WorktreeOptions,
} from "./src/types.ts";
