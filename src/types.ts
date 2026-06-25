import type { Effect } from "effect";
import type { FileSystem, Path } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import type { HomesteadEvent } from "./events.ts";
import type { Herdr } from "./herdr/service.ts";
import type {
  AgentConfigData,
  EnvConfigData,
  IssuesConfigData,
  PortSpec,
  PrConfigData,
  ServiceSpec,
  SetupStep,
} from "./config-schema.ts";
import type { PrView } from "./pr/resolve.ts";
import type { WorkItem } from "./work-item.ts";
import type { HomesteadContext } from "./context.ts";

export type {
  AgentConfigData,
  EnvConfigData,
  IssuesConfigData,
  PortSpec,
  PrConfigData,
  ServiceSpec,
  SetupStep,
} from "./config-schema.ts";

export type { WorkItem } from "./work-item.ts";
export type { HomesteadContext } from "./context.ts";
export type { HomesteadEvent } from "./events.ts";

export type HomesteadServices =
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
  | Herdr;

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
  readonly surfaceLabel?: ((ctx: HomesteadContext & { kind: "issue" | "pr" }) => string) | undefined;
}

export interface TrackingContext extends WorkItem {
  readonly branch: string;
  readonly worktreeDir: string;
  readonly host: string;
}

export interface IssuesConfig extends Omit<IssuesConfigData, "comment" | "labelColor" | "label" | "reviewLabel" | "assign"> {
  readonly label?: string | ((item: WorkItem) => string) | undefined;
  readonly reviewLabel?: string | ((item: WorkItem) => string) | undefined;
  readonly assign?: boolean | string | ((item: WorkItem) => string | ReadonlyArray<string>) | undefined;
  readonly branch?: ((item: WorkItem) => string) | undefined;
  readonly comment?: boolean | ((ctx: TrackingContext) => string);
  readonly stopComment?: boolean | ((ctx: HomesteadContext & { host: string }) => string);
  readonly reviewComment?: boolean | ((ctx: HomesteadContext & { host: string }) => string);
  readonly closeComment?: boolean | ((ctx: HomesteadContext & { host: string }) => string);
  readonly closeReason?:
    | "completed"
    | "not planned"
    | ((ctx: HomesteadContext) => "completed" | "not planned")
    | undefined;
  readonly labelColor?: string | ((ctx: { label: string; kind: "wip" | "review" }) => string) | undefined;
}

export interface PrPromptContext {
  readonly pr: PrView;
  readonly checks?: string | undefined;
}

export interface PrConfig extends PrConfigData {
  readonly reviewPrompt?: ((ctx: PrPromptContext) => string) | undefined;
  readonly workPrompt?: ((ctx: PrPromptContext) => string) | undefined;
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
  readonly pr?: PrConfig;
  readonly afterSetup?:
    | ((ctx: WorktreeContext & { readonly plan: Plan }) => Effect.Effect<void, never, HomesteadServices>)
    | undefined;
  readonly afterLaunch?:
    | ((ctx: HomesteadContext & { readonly paneId: string }) => Effect.Effect<void, never, HomesteadServices>)
    | undefined;
  readonly beforeTeardown?:
    | ((ctx: HomesteadContext & { readonly verb: "kill" | "close" | "complete"; readonly tracked: boolean }) => Effect.Effect<void, never, HomesteadServices>)
    | undefined;
  readonly afterTeardown?:
    | ((ctx: HomesteadContext & { readonly verb: "kill" | "close" | "complete"; readonly reviewLabel?: string }) => Effect.Effect<void, never, HomesteadServices>)
    | undefined;
  readonly onEvent?:
    | ((e: HomesteadEvent) => Effect.Effect<void, never, HomesteadServices>)
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
