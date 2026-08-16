import { Rpc, RpcClient, RpcGroup } from "effect/unstable/rpc"
import type { Rpcs } from "effect/unstable/rpc/RpcGroup"
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError"
import { Effect, Schema } from "effect"
import type * as Stream from "effect/Stream"
import * as os from "node:os"
import * as path from "node:path"
import {
  InvalidInput,
  CommandInputFailure,
  CommandNotFound,
  CommandStartFailure,
  ProvisionFailure,
  RepositoryNotFound,
  RequestIdConflict,
  WorktreeAlreadyExists,
  WorktreeNotFound,
  WorktreeRemovalRefused,
  WorkspaceAlreadyExists,
  WorkspaceFileError,
  WorkspaceHandleNotFound,
  WorkspaceNotFound,
  WorkspacePersistenceFailure,
  WorkspaceRemovalRefused,
} from "../errors.ts"
import {
  CommandEvent,
  CommandRun,
  RemoveWorkspaceResult,
  RemoveWorktreeResult,
  WorkspaceInfo,
  WorkspaceFileContent,
  WorkspaceFileEntry,
  WorkspaceFileStat,
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

const WorkspaceFileErrors = Schema.Union([
  WorkspaceFileError,
  WorkspaceHandleNotFound,
  WorkspacePersistenceFailure,
])

export class ReadWorkspaceFile extends Rpc.make("v1/workspace/file/read", {
  payload: {
    workspaceId: Schema.String,
    path: Schema.String,
  },
  success: WorkspaceFileContent,
  error: WorkspaceFileErrors,
}) {}

export class WriteWorkspaceFile extends Rpc.make("v1/workspace/file/write", {
  payload: {
    workspaceId: Schema.String,
    path: Schema.String,
    content: Schema.String,
  },
  success: Schema.Void,
  error: WorkspaceFileErrors,
}) {}

export class StatWorkspaceFile extends Rpc.make("v1/workspace/file/stat", {
  payload: {
    workspaceId: Schema.String,
    path: Schema.String,
  },
  success: WorkspaceFileStat,
  error: WorkspaceFileErrors,
}) {}

export class ListWorkspaceDirectory extends Rpc.make("v1/workspace/file/list", {
  payload: {
    workspaceId: Schema.String,
    path: Schema.optional(Schema.String),
  },
  success: Schema.Array(WorkspaceFileEntry),
  error: WorkspaceFileErrors,
}) {}

export class MakeWorkspaceDirectory extends Rpc.make("v1/workspace/file/mkdir", {
  payload: {
    workspaceId: Schema.String,
    path: Schema.String,
  },
  success: Schema.Void,
  error: WorkspaceFileErrors,
}) {}

export class RemoveWorkspacePath extends Rpc.make("v1/workspace/file/remove", {
  payload: {
    workspaceId: Schema.String,
    path: Schema.String,
    recursive: Schema.optional(Schema.Boolean),
  },
  success: Schema.Void,
  error: WorkspaceFileErrors,
}) {}

const CommandStartErrors = Schema.Union([
  CommandStartFailure,
  WorkspaceFileError,
  WorkspaceHandleNotFound,
  WorkspacePersistenceFailure,
])

export class StartCommand extends Rpc.make("v1/workspace/command/start", {
  payload: {
    workspaceId: Schema.String,
    command: Schema.String,
    args: Schema.Array(Schema.String),
    cwd: Schema.optional(Schema.String),
    env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  },
  success: CommandRun,
  error: CommandStartErrors,
}) {}

export class GetCommandRun extends Rpc.make("v1/workspace/command/get", {
  payload: {
    workspaceId: Schema.String,
    runId: Schema.String,
  },
  success: CommandRun,
  error: CommandNotFound,
}) {}

export class ListCommandRuns extends Rpc.make("v1/workspace/command/list", {
  payload: {
    workspaceId: Schema.String,
  },
  success: Schema.Array(CommandRun),
}) {}

export class WriteCommandInput extends Rpc.make("v1/workspace/command/input", {
  payload: {
    workspaceId: Schema.String,
    runId: Schema.String,
    data: Schema.String,
  },
  success: Schema.Void,
  error: Schema.Union([CommandNotFound, CommandInputFailure]),
}) {}

export class CancelCommand extends Rpc.make("v1/workspace/command/cancel", {
  payload: {
    workspaceId: Schema.String,
    runId: Schema.String,
  },
  success: Schema.Void,
  error: CommandNotFound,
}) {}

export class StreamCommandEvents extends Rpc.make("v1/workspace/command/events", {
  payload: {
    workspaceId: Schema.String,
    runId: Schema.String,
    since: Schema.optional(Schema.Finite),
    follow: Schema.optional(Schema.Boolean),
  },
  success: CommandEvent,
  error: CommandNotFound,
  stream: true,
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
  ReadWorkspaceFile,
  WriteWorkspaceFile,
  StatWorkspaceFile,
  ListWorkspaceDirectory,
  MakeWorkspaceDirectory,
  RemoveWorkspacePath,
  StartCommand,
  GetCommandRun,
  ListCommandRuns,
  WriteCommandInput,
  CancelCommand,
  StreamCommandEvents,
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
  readonly readWorkspaceFile: (payload: {
    readonly workspaceId: string
    readonly path: string
  }) => Effect.Effect<
    WorkspaceFileContent,
    WorkspaceFileError | WorkspaceHandleNotFound | WorkspacePersistenceFailure | RpcClientError
  >
  readonly writeWorkspaceFile: (payload: {
    readonly workspaceId: string
    readonly path: string
    readonly content: string
  }) => Effect.Effect<
    void,
    WorkspaceFileError | WorkspaceHandleNotFound | WorkspacePersistenceFailure | RpcClientError
  >
  readonly statWorkspaceFile: (payload: {
    readonly workspaceId: string
    readonly path: string
  }) => Effect.Effect<
    WorkspaceFileStat,
    WorkspaceFileError | WorkspaceHandleNotFound | WorkspacePersistenceFailure | RpcClientError
  >
  readonly listWorkspaceDirectory: (payload: {
    readonly workspaceId: string
    readonly path?: string | undefined
  }) => Effect.Effect<
    ReadonlyArray<WorkspaceFileEntry>,
    WorkspaceFileError | WorkspaceHandleNotFound | WorkspacePersistenceFailure | RpcClientError
  >
  readonly makeWorkspaceDirectory: (payload: {
    readonly workspaceId: string
    readonly path: string
  }) => Effect.Effect<
    void,
    WorkspaceFileError | WorkspaceHandleNotFound | WorkspacePersistenceFailure | RpcClientError
  >
  readonly removeWorkspacePath: (payload: {
    readonly workspaceId: string
    readonly path: string
    readonly recursive?: boolean | undefined
  }) => Effect.Effect<
    void,
    WorkspaceFileError | WorkspaceHandleNotFound | WorkspacePersistenceFailure | RpcClientError
  >
  readonly startCommand: (payload: {
    readonly workspaceId: string
    readonly command: string
    readonly args: ReadonlyArray<string>
    readonly cwd?: string | undefined
    readonly env?: Readonly<Record<string, string>> | undefined
  }) => Effect.Effect<
    CommandRun,
    | CommandStartFailure
    | WorkspaceFileError
    | WorkspaceHandleNotFound
    | WorkspacePersistenceFailure
    | RpcClientError
  >
  readonly getCommandRun: (payload: {
    readonly workspaceId: string
    readonly runId: string
  }) => Effect.Effect<CommandRun, CommandNotFound | RpcClientError>
  readonly listCommandRuns: (payload: {
    readonly workspaceId: string
  }) => Effect.Effect<ReadonlyArray<CommandRun>, RpcClientError>
  readonly writeCommandInput: (payload: {
    readonly workspaceId: string
    readonly runId: string
    readonly data: string
  }) => Effect.Effect<void, CommandNotFound | CommandInputFailure | RpcClientError>
  readonly cancelCommand: (payload: {
    readonly workspaceId: string
    readonly runId: string
  }) => Effect.Effect<void, CommandNotFound | RpcClientError>
  readonly streamCommandEvents: (payload: {
    readonly workspaceId: string
    readonly runId: string
    readonly since?: number | undefined
    readonly follow?: boolean | undefined
  }) => Stream.Stream<CommandEvent, CommandNotFound | RpcClientError>
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
    readWorkspaceFile: (payload) => raw["v1/workspace/file/read"](payload),
    writeWorkspaceFile: (payload) => raw["v1/workspace/file/write"](payload),
    statWorkspaceFile: (payload) => raw["v1/workspace/file/stat"](payload),
    listWorkspaceDirectory: (payload) => raw["v1/workspace/file/list"](payload),
    makeWorkspaceDirectory: (payload) => raw["v1/workspace/file/mkdir"](payload),
    removeWorkspacePath: (payload) => raw["v1/workspace/file/remove"](payload),
    startCommand: (payload) => raw["v1/workspace/command/start"](payload),
    getCommandRun: (payload) => raw["v1/workspace/command/get"](payload),
    listCommandRuns: (payload) => raw["v1/workspace/command/list"](payload),
    writeCommandInput: (payload) => raw["v1/workspace/command/input"](payload),
    cancelCommand: (payload) => raw["v1/workspace/command/cancel"](payload),
    streamCommandEvents: (payload) => raw["v1/workspace/command/events"](payload),
    createWorktree: (payload) => raw["v1/worktree/create"](payload),
    listWorktrees: (payload) => raw["v1/worktree/list"](payload ?? {}),
    removeWorktree: (payload) => raw["v1/worktree/remove"](payload),
  }

  return client
})
