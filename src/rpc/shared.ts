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
} from "../errors.ts"
import { RemoveWorktreeResult, WorktreeInfo } from "../types.ts"

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
  error: Schema.Union([InvalidInput, RepositoryNotFound]),
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

export const HomesteadRpcs = RpcGroup.make(
  Ping,
  Shutdown,
  CreateWorktree,
  ListWorktrees,
  RemoveWorktree,
)

export type HomesteadRpcList = Rpcs<typeof HomesteadRpcs>

export interface HomesteadClient {
  readonly ping: () => Effect.Effect<{ timestamp: number }, RpcClientError>
  readonly Ping: () => Effect.Effect<{ timestamp: number }, RpcClientError>
  readonly shutdown: () => Effect.Effect<void, RpcClientError>
  readonly Shutdown: () => Effect.Effect<void, RpcClientError>
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
  readonly CreateWorktree: (payload: {
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
    InvalidInput | RepositoryNotFound | RpcClientError
  >
  readonly ListWorktrees: (payload?: {
    readonly repoRoot?: string | undefined
  }) => Effect.Effect<
    ReadonlyArray<WorktreeInfo>,
    InvalidInput | RepositoryNotFound | RpcClientError
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
  readonly RemoveWorktree: (payload: {
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
    ping: () => raw["v1/daemon/ping"](void 0),
    Ping: () => raw["v1/daemon/ping"](void 0),
    shutdown: () => raw["v1/daemon/shutdown"](void 0),
    Shutdown: () => raw["v1/daemon/shutdown"](void 0),
    createWorktree: (payload) => raw["v1/worktree/create"](payload),
    CreateWorktree: (payload) => raw["v1/worktree/create"](payload),
    listWorktrees: (payload) => raw["v1/worktree/list"](payload ?? {}),
    ListWorktrees: (payload) => raw["v1/worktree/list"](payload ?? {}),
    removeWorktree: (payload) => raw["v1/worktree/remove"](payload),
    RemoveWorktree: (payload) => raw["v1/worktree/remove"](payload),
  }

  return client
})
