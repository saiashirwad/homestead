import { Schema } from "effect"

export interface PortSpec {
  readonly key: string
  readonly base: number
}

export interface ServiceSpec {
  readonly name: string
  readonly host: string
  readonly port: number
  readonly start?: ReadonlyArray<string> | undefined
  readonly timeoutMs?: number | undefined
}

export interface SetupStep {
  readonly label: string
  readonly run: ReadonlyArray<string>
  readonly cwd?: string | undefined
  readonly injectEnv?: ReadonlyArray<string> | undefined
  readonly fatal?: boolean | undefined
}

export interface TeardownStep {
  readonly label: string
  readonly run: ReadonlyArray<string>
  readonly cwd?: string | undefined
}

export interface WorktreeContext {
  readonly repoName: string
  readonly slug: string
  readonly branch: string
  readonly worktreeDir: string
  readonly primaryRoot: string
  readonly env: (key: string) => string | undefined
}

export interface EnvConfig {
  readonly source?: string | undefined
  readonly fallback?: string | undefined
  readonly derive?: ((ctx: WorktreeContext) => Record<string, string>) | undefined
}

export interface HomesteadConfig {
  readonly worktreeDir?:
    | ((ctx: { repoName: string; slug: string; branch: string }) => string)
    | undefined
  readonly ports?: ReadonlyArray<PortSpec> | undefined
  readonly env?: EnvConfig | undefined
  readonly services?: ReadonlyArray<ServiceSpec> | undefined
  readonly setup?: ReadonlyArray<SetupStep> | undefined
  readonly teardown?: ReadonlyArray<TeardownStep> | undefined
}

export class WorktreeInfo extends Schema.Class<WorktreeInfo>("WorktreeInfo")({
  repoRoot: Schema.String,
  name: Schema.String,
  branch: Schema.String,
  path: Schema.String,
  ports: Schema.Record(Schema.String, Schema.Finite),
  createdAt: Schema.Finite,
}) {}

export class ProviderCapabilities extends Schema.Class<ProviderCapabilities>(
  "ProviderCapabilities",
)({
  filesystemIsolation: Schema.Literals(["rooted", "container", "vm"]),
  networkIsolation: Schema.Literals(["host", "filtered", "isolated"]),
  survivesHostDisconnect: Schema.Boolean,
  supportsPortals: Schema.Boolean,
}) {}

export const WorkspaceLifecycleState = Schema.Literals(["provisioning", "ready", "removing"])
export type WorkspaceLifecycleState = typeof WorkspaceLifecycleState.Type

export class WorkspaceInfo extends Schema.Class<WorkspaceInfo>("WorkspaceInfo")({
  id: Schema.String,
  projectRoot: Schema.String,
  name: Schema.String,
  branch: Schema.String,
  baseRevision: Schema.String,
  provider: Schema.String,
  providerCapabilities: ProviderCapabilities,
  providerMetadata: Schema.Record(Schema.String, Schema.String),
  rootPath: Schema.optional(Schema.String),
  ports: Schema.Record(Schema.String, Schema.Finite),
  state: WorkspaceLifecycleState,
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
}) {}

export class RemoveWorkspaceResult extends Schema.Class<RemoveWorkspaceResult>(
  "RemoveWorkspaceResult",
)({
  removed: Schema.Boolean,
  id: Schema.String,
  projectRoot: Schema.String,
  name: Schema.String,
}) {}

export class RemoveWorktreeResult extends Schema.Class<RemoveWorktreeResult>(
  "RemoveWorktreeResult",
)({
  removed: Schema.Boolean,
  repoRoot: Schema.String,
  name: Schema.String,
}) {}

export interface Plan {
  readonly targetDir: string
  readonly branch: string
  readonly slug: string
  readonly envPath: string
  readonly sourcePath: string
  readonly sourceContent: string
  readonly reusedExistingEnv: boolean
  readonly fellBackToExample: boolean
  readonly envEdits: ReadonlyArray<readonly [string, string]>
}
