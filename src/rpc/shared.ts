import { Rpc, RpcClient, RpcGroup } from "effect/unstable/rpc"
import type { Rpcs } from "effect/unstable/rpc/RpcGroup"
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError"
import { Effect, Schema } from "effect"
import * as os from "node:os"
import * as path from "node:path"
import {
  InvalidInput,
  ProvisionFailure,
  RepositoryNotFound,
  RequestIdConflict,
  WorktreeAlreadyExists,
  WorktreeNotFound,
  WorktreeRemovalRefused,
  WorkspaceAlreadyExists,
  WorkspaceNotFound,
  WorkspacePersistenceFailure,
  WorkspaceRemovalRefused,
} from "../errors.ts"
import {
  RemoveWorkspaceResult,
  RemoveWorktreeResult,
  WorkspaceInfo,
  WorktreeInfo,
} from "../types.ts"

export const getDefaultSocketPath = (): string => {
  if (process.env.HOMESTEAD_SOCKET_PATH) {
    return process.env.HOMESTEAD_SOCKET_PATH
  }
  return path.join(os.homedir(), ".homestead", "run", "daemon.sock")
}

export class Ping extends Rpc.make("v1/daemon/ping", {
  success: Schema.Struct({ timestamp: Schema.Finite }),
}) {}

export class Shutdown extends Rpc.make("v1/daemon/shutdown", {
  success: Schema.Void,
}) {}

export class CreateWorktree extends Rpc.make("v1/worktree/create", {
  payload: {
    requestId: Schema.String,
    repoRoot: Schema.String,
    name: Schema.String,
    from: Schema.optional(Schema.String),
  },
  success: WorktreeInfo,
  error: Schema.Union([
    InvalidInput,
    RepositoryNotFound,
    WorktreeAlreadyExists,
    RequestIdConflict,
    ProvisionFailure,
  ]),
}) {}

export class ListWorktrees extends Rpc.make("v1/worktree/list", {
  payload: {
    repoRoot: Schema.optional(Schema.String),
  },
  success: Schema.Array(WorktreeInfo),
  error: Schema.Union([InvalidInput, RepositoryNotFound, ProvisionFailure]),
}) {}

export class RemoveWorktree extends Rpc.make("v1/worktree/remove", {
  payload: {
    requestId: Schema.String,
    repoRoot: Schema.String,
    name: Schema.String,
    force: Schema.optional(Schema.Boolean),
  },
  success: RemoveWorktreeResult,
  error: Schema.Union([
    InvalidInput,
    RepositoryNotFound,
    WorktreeNotFound,
    WorktreeRemovalRefused,
    RequestIdConflict,
    ProvisionFailure,
  ]),
}) {}

export class CreateWorkspace extends Rpc.make("v1/workspace/create", {
  payload: {
    requestId: Schema.String,
    projectRoot: Schema.String,
    name: Schema.String,
    from: Schema.optional(Schema.String),
  },
  success: WorkspaceInfo,
  error: Schema.Union([
    InvalidInput,
    RepositoryNotFound,
    WorkspaceAlreadyExists,
    RequestIdConflict,
    ProvisionFailure,
    WorkspacePersistenceFailure,
  ]),
}) {}

export class GetWorkspace extends Rpc.make("v1/workspace/get", {
  payload: {
    projectRoot: Schema.String,
    name: Schema.String,
  },
  success: WorkspaceInfo,
  error: Schema.Union([
    InvalidInput,
    RepositoryNotFound,
    WorkspaceNotFound,
    WorkspacePersistenceFailure,
  ]),
}) {}

export class ListWorkspaces extends Rpc.make("v1/workspace/list", {
  payload: {
    projectRoot: Schema.optional(Schema.String),
  },
  success: Schema.Array(WorkspaceInfo),
  error: Schema.Union([InvalidInput, RepositoryNotFound, WorkspacePersistenceFailure]),
}) {}

export class RemoveWorkspace extends Rpc.make("v1/workspace/remove", {
  payload: {
    requestId: Schema.String,
    projectRoot: Schema.String,
    name: Schema.String,
    force: Schema.optional(Schema.Boolean),
  },
  success: RemoveWorkspaceResult,
  error: Schema.Union([
    InvalidInput,
    RepositoryNotFound,
    WorkspaceNotFound,
    WorkspaceRemovalRefused,
    RequestIdConflict,
    ProvisionFailure,
    WorkspacePersistenceFailure,
  ]),
}) {}

export class ReconcileWorkspaces extends Rpc.make("v1/workspace/reconcile", {
  payload: {
    projectRoot: Schema.optional(Schema.String),
  },
  success: Schema.Void,
  error: Schema.Union([InvalidInput, RepositoryNotFound, WorkspacePersistenceFailure]),
}) {}

export const HomesteadRpcs = RpcGroup.make(
  Ping,
  Shutdown,
  CreateWorktree,
  ListWorktrees,
  RemoveWorktree,
  CreateWorkspace,
  GetWorkspace,
  ListWorkspaces,
  RemoveWorkspace,
  ReconcileWorkspaces,
)

export type HomesteadRpcList = Rpcs<typeof HomesteadRpcs>

export interface HomesteadClient {
  readonly ping: Effect.Effect<{ timestamp: number }, RpcClientError>
  readonly shutdown: Effect.Effect<void, RpcClientError>
  readonly createWorkspace: (payload: {
    readonly requestId: string
    readonly projectRoot: string
    readonly name: string
    readonly from?: string | undefined
  }) => Effect.Effect<
    WorkspaceInfo,
    | InvalidInput
    | RepositoryNotFound
    | WorkspaceAlreadyExists
    | RequestIdConflict
    | ProvisionFailure
    | WorkspacePersistenceFailure
    | RpcClientError
  >
  readonly getWorkspace: (payload: {
    readonly projectRoot: string
    readonly name: string
  }) => Effect.Effect<
    WorkspaceInfo,
    | InvalidInput
    | RepositoryNotFound
    | WorkspaceNotFound
    | WorkspacePersistenceFailure
    | RpcClientError
  >
  readonly listWorkspaces: (payload?: {
    readonly projectRoot?: string | undefined
  }) => Effect.Effect<
    ReadonlyArray<WorkspaceInfo>,
    InvalidInput | RepositoryNotFound | WorkspacePersistenceFailure | RpcClientError
  >
  readonly removeWorkspace: (payload: {
    readonly requestId: string
    readonly projectRoot: string
    readonly name: string
    readonly force?: boolean | undefined
  }) => Effect.Effect<
    RemoveWorkspaceResult,
    | InvalidInput
    | RepositoryNotFound
    | WorkspaceNotFound
    | WorkspaceRemovalRefused
    | RequestIdConflict
    | ProvisionFailure
    | WorkspacePersistenceFailure
    | RpcClientError
  >
  readonly reconcileWorkspaces: (payload?: {
    readonly projectRoot?: string | undefined
  }) => Effect.Effect<
    void,
    InvalidInput | RepositoryNotFound | WorkspacePersistenceFailure | RpcClientError
  >
  readonly createWorktree: (payload: {
    readonly requestId: string
    readonly repoRoot: string
    readonly name: string
    readonly from?: string | undefined
  }) => Effect.Effect<
    WorktreeInfo,
    | InvalidInput
    | RepositoryNotFound
    | WorktreeAlreadyExists
    | RequestIdConflict
    | ProvisionFailure
    | RpcClientError
  >
  readonly listWorktrees: (payload?: {
    readonly repoRoot?: string | undefined
  }) => Effect.Effect<
    ReadonlyArray<WorktreeInfo>,
    InvalidInput | RepositoryNotFound | ProvisionFailure | RpcClientError
  >
  readonly removeWorktree: (payload: {
    readonly requestId: string
    readonly repoRoot: string
    readonly name: string
    readonly force?: boolean | undefined
  }) => Effect.Effect<
    RemoveWorktreeResult,
    | InvalidInput
    | RepositoryNotFound
    | WorktreeNotFound
    | WorktreeRemovalRefused
    | RequestIdConflict
    | ProvisionFailure
    | RpcClientError
  >
  readonly raw: RpcClient.RpcClient<HomesteadRpcList, RpcClientError>
}

export const makeHomesteadClient = Effect.gen(function* () {
  const raw = yield* RpcClient.make(HomesteadRpcs)

  const client: HomesteadClient = {
    raw,
    ping: raw["v1/daemon/ping"](void 0),
    shutdown: raw["v1/daemon/shutdown"](void 0),
    createWorkspace: (payload) => raw["v1/workspace/create"](payload),
    getWorkspace: (payload) => raw["v1/workspace/get"](payload),
    listWorkspaces: (payload) => raw["v1/workspace/list"](payload ?? {}),
    removeWorkspace: (payload) => raw["v1/workspace/remove"](payload),
    reconcileWorkspaces: (payload) => raw["v1/workspace/reconcile"](payload ?? {}),
    createWorktree: (payload) => raw["v1/worktree/create"](payload),
    listWorktrees: (payload) => raw["v1/worktree/list"](payload ?? {}),
    removeWorktree: (payload) => raw["v1/worktree/remove"](payload),
  }

  return client
})
