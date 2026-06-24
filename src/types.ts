import type { Effect } from "effect";
import { Schema } from "effect";
import type { FileSystem, Path } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import type { Herdr } from "./herdr/service.ts";
import type {
  AgentConfigData,
  EnvConfigData,
  IssuesConfigData,
  PortSpec,
  ServiceSpec,
  SetupStep,
} from "./config-schema.ts";

export type {
  AgentConfigData,
  EnvConfigData,
  IssuesConfigData,
  PortSpec,
  ServiceSpec,
  SetupStep,
} from "./config-schema.ts";

export type HomesteadServices =
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
  | Herdr;

export const WorkItemSchema = Schema.Struct({
  number: Schema.Number,
  url: Schema.String,
  title: Schema.String,
});
export type WorkItem = typeof WorkItemSchema.Type;

export const DEFAULT_ENV_SOURCE = ".env";
export const DEFAULT_ENV_FALLBACK = ".env.example";
export const DEFAULT_REVIEW_LABEL = "agent:review";
export const DEFAULT_SERVICE_TIMEOUT_MS = 15_000;
export const DEFAULT_AGENT_COMMAND = ["claude"] as const;
export const DEFAULT_AGENT_READY_MARKER = "❯";
export const DEFAULT_CLAUDE_TRUST_PROMPT = {
  marker: "trust this folder",
  confirm: ["Enter"],
} as const;
export interface WorktreeContext {
  readonly slug: string;
  readonly branch: string;
  readonly targetDir: string;
  readonly primaryRoot: string;
  readonly repoName: string;
  readonly env: (key: string) => string | undefined;
}

export interface EnvConfig extends EnvConfigData {
  readonly derive?: ((ctx: WorktreeContext) => Record<string, string>) | undefined;
}

export interface AgentPromptContext {
  readonly item: WorkItem;
  readonly branch: string;
  readonly worktreeDir: string;
  readonly repoName: string;
  readonly args: ReadonlyArray<string>;
}

export interface AgentConfig extends AgentConfigData {
  readonly prompt?: ((ctx: AgentPromptContext) => string) | undefined;
}

export const defaultAgentPrompt = (ctx: AgentPromptContext): string =>
  `We're working on GitHub issue #${ctx.item.number}: "${ctx.item.title}".\n${ctx.item.url}\n\n` +
  `Use the superpowers workflow to take this from idea to shipped code: start with the brainstorming ` +
  `skill to turn the issue into an approved design and spec, then writing-plans, then ` +
  `subagent-driven-development. I'll be here in this pane to approve at each gate.`;

export const resolveAgentDefaults = (agent: AgentConfig): AgentConfig & {
  readonly prompt: (ctx: AgentPromptContext) => string;
} => {
  const command = agent.command ?? DEFAULT_AGENT_COMMAND;
  const binary = command[0] ?? "claude";
  const trustPrompt =
    agent.trustPrompt !== undefined
      ? agent.trustPrompt
      : binary === "claude"
        ? DEFAULT_CLAUDE_TRUST_PROMPT
        : undefined;

  return {
    ...agent,
    command,
    trustPrompt,
    prompt: agent.prompt ?? defaultAgentPrompt,
  };
};

export interface TrackingContext extends WorkItem {
  readonly branch: string;
  readonly worktreeDir: string;
  readonly host: string;
}

export interface IssuesConfig extends Omit<IssuesConfigData, "comment"> {
  readonly branch?: ((item: WorkItem) => string) | undefined;
  readonly comment?: boolean | ((ctx: TrackingContext) => string);
}

export interface HomesteadConfig {
  readonly worktreeDir?:
    | ((ctx: { readonly repoName: string; readonly slug: string; readonly branch: string }) => string)
    | undefined;
  readonly ports?: ReadonlyArray<PortSpec>;
  readonly env?: EnvConfig;
  readonly services?: ReadonlyArray<ServiceSpec>;
  readonly setup?: ReadonlyArray<SetupStep>;
  readonly agent?: AgentConfig;
  readonly issues?: IssuesConfig;
  readonly afterSetup?:
    | ((ctx: WorktreeContext & { readonly plan: Plan }) => Effect.Effect<void, never, HomesteadServices>)
    | undefined;
}

export interface WorktreeOptions {
  readonly create?: string;
  readonly from?: string;
  readonly dir?: string;
  readonly noSetup?: boolean;
  readonly dryRun?: boolean;
}

export interface Plan {
  readonly targetDir: string;
  readonly branch: string;
  readonly slug: string;
  readonly envPath: string;
  readonly sourcePath: string;
  readonly sourceContent: string;
  readonly reusedExistingEnv: boolean;
  readonly fellBackToExample: boolean;
  readonly envEdits: ReadonlyArray<readonly [string, string]>;
}
