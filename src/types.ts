import type { Effect } from "effect";
import type { FileSystem, Path } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import type { HomesteadEvent } from "./events.ts";
import type { Herdr } from "./herdr/service.ts";
import type {
  AgentConfigData,
  EnvConfigData,
  IssuesConfigData,
  PortSpec as PortSpecData,
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
  PrConfigData,
  ServiceSpec,
  SetupStep,
} from "./config-schema.ts";

export interface PortSpec extends Omit<PortSpecData, "base"> {
  readonly base: number | ((ctx: HomesteadContext) => number);
}

export type { WorkItem } from "./work-item.ts";
export type { HomesteadContext } from "./context.ts";
export type { HomesteadEvent } from "./events.ts";

export type HomesteadServices =
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
  | Herdr;

export type WorktreeContext = HomesteadContext & {
  readonly targetDir: string;
  readonly primaryRoot: string;
};

export interface EnvConfig extends EnvConfigData {
  readonly derive?: ((ctx: WorktreeContext) => Record<string, string>) | undefined;
}

export type AgentPromptContext = HomesteadContext & {
  readonly args: ReadonlyArray<string>;
};

export interface AgentConfig extends Omit<AgentConfigData, "command"> {
  readonly command?:
    | ReadonlyArray<string>
    | ((ctx: HomesteadContext & { args: ReadonlyArray<string> }) => ReadonlyArray<string>)
    | undefined;
  readonly prompt?: ((ctx: AgentPromptContext) => string) | undefined;
  readonly surfaceLabel?: ((ctx: HomesteadContext & { kind: "issue" | "pr" }) => string) | undefined;
}

export type TrackingContext = HomesteadContext & {
  readonly host: string;
};

export interface IssuesConfig extends Omit<IssuesConfigData, "comment" | "labelColor" | "label" | "reviewLabel" | "assign"> {
  readonly label?: string | ((item: WorkItem) => string) | undefined;
  readonly reviewLabel?: string | ((item: WorkItem) => string) | undefined;
  readonly assign?: boolean | string | ((item: WorkItem) => string | ReadonlyArray<string>) | undefined;
  readonly branch?: ((item: WorkItem) => string) | undefined;
  readonly comment?: boolean | ((ctx: TrackingContext) => string);
  readonly stopComment?: boolean | ((ctx: TrackingContext) => string);
  readonly reviewComment?: boolean | ((ctx: TrackingContext) => string);
  readonly closeComment?: boolean | ((ctx: TrackingContext) => string);
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

export interface PrConfig extends Omit<PrConfigData, "checks"> {
  readonly checks?: string | ((ctx: PrPromptContext) => string) | undefined;
  readonly reviewPrompt?: ((ctx: PrPromptContext) => string) | undefined;
  readonly workPrompt?: ((ctx: PrPromptContext) => string) | undefined;
  readonly prBranch?: ((ctx: { pr: PrView; kind: "fork" | "same-repo" }) => string) | undefined;
}

export interface HomesteadConfig {
  /** `ctx.worktreeDir` is always empty inside this callback — the path is what you're defining. */
  readonly worktreeDir?: ((ctx: HomesteadContext) => string) | undefined;
  readonly ports?: ReadonlyArray<PortSpec>;
  readonly env?: EnvConfig;
  readonly services?: ReadonlyArray<ServiceSpec>;
  readonly setup?:
    | ReadonlyArray<SetupStep>
    | ((ctx: HomesteadContext & { plan: Plan }) => ReadonlyArray<SetupStep>)
    | undefined;
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
