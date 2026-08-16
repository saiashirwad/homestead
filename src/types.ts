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
