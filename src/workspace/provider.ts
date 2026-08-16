import { Context, Effect } from "effect"
import type * as Option from "effect/Option"
import { ProvisionFailure, WorkspaceAlreadyExists } from "../errors.ts"
import type { ProviderCapabilities, WorkspaceInfo } from "../types.ts"

export interface PrepareWorkspaceRequest {
  readonly id: string
  readonly projectRoot: string
  readonly name: string
  readonly from?: string | undefined
  readonly targetPath: string
}

export interface ProviderWorkspace {
  readonly id: string
  readonly projectRoot: string
  readonly name: string
  readonly branch: string
  readonly baseRevision: string
  readonly rootPath?: string | undefined
  readonly metadata: Readonly<Record<string, string>>
}

export interface PreparedWorkspace extends ProviderWorkspace {
  readonly branchAlreadyExists: boolean
}

export interface DiscoveredWorkspace {
  readonly projectRoot: string
  readonly name: string
  readonly branch: string
  readonly rootPath?: string | undefined
  readonly metadata: Readonly<Record<string, string>>
}

export interface WorkspaceProviderApi {
  readonly provider: string
  readonly capabilities: ProviderCapabilities
  readonly prepare: (
    request: PrepareWorkspaceRequest,
  ) => Effect.Effect<PreparedWorkspace, WorkspaceAlreadyExists | ProvisionFailure>
  readonly create: (prepared: PreparedWorkspace) => Effect.Effect<ProviderWorkspace>
  readonly find: (workspace: WorkspaceInfo) => Effect.Effect<Option.Option<ProviderWorkspace>>
  readonly discover: (projectRoot: string) => Effect.Effect<ReadonlyArray<DiscoveredWorkspace>>
  readonly destroy: (workspace: ProviderWorkspace) => Effect.Effect<void>
  readonly resolveRevision: (projectRoot: string, ref: string) => Effect.Effect<string>
}

export class WorkspaceProvider extends Context.Service<WorkspaceProvider, WorkspaceProviderApi>()(
  "homestead/workspace/provider/WorkspaceProvider",
) {}
