import {
  Clock,
  Context,
  Crypto,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Ref,
  Schema,
} from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import * as nodePath from "node:path"
import { loadConfigOrUndefined } from "../config.ts"
import {
  InvalidInput,
  CommandStartFailure,
  ProvisionFailure,
  RepositoryNotFound,
  RequestIdConflict,
  WorkspaceAlreadyExists,
  WorkspaceFileError,
  WorkspaceHandleNotFound,
  WorkspaceNotFound,
  WorkspacePersistenceFailure,
  WorkspaceRemovalRefused,
} from "../errors.ts"
import { Git } from "../git/service.ts"
import { slugify } from "../text.ts"
import { RemoveWorkspaceResult, WorkspaceInfo } from "../types.ts"
import {
  CommandRun,
  WorkspaceFileContent,
  WorkspaceFileEntry,
  WorkspaceFileStat,
} from "../types.ts"
import { provisionTarget } from "../worktree/index.ts"
import { readProvisionMarker } from "../worktree/marker.ts"
import { resolveTargetDir } from "../worktree/plan.ts"
import { PortAllocator } from "../worktree/ports.ts"
import { runTeardown } from "../worktree/provision.ts"
import type { HomesteadConfig } from "../types.ts"
import { WorkspaceProvider, type ProviderWorkspace } from "./provider.ts"
import { CommandRuntime } from "./commands.ts"
import { WorkspaceRegistry } from "./registry.ts"

const DEFAULT_CONFIG: HomesteadConfig = {
  ports: [],
  services: [],
  setup: [],
  teardown: [],
}

const PROTECTED_BRANCHES = new Set(["main", "master"])
const DEFAULT_MAX_IDEMPOTENCY_ENTRIES = 1000

type PayloadRecord = Readonly<Record<string, string | number | boolean | null | undefined>>

type IdempotencyRecord =
  | {
      readonly operation: "create"
      readonly fingerprint: string
      readonly result: WorkspaceInfo
      readonly timestamp: number
    }
  | {
      readonly operation: "remove"
      readonly fingerprint: string
      readonly result: RemoveWorkspaceResult
      readonly timestamp: number
    }

export type CreateWorkspaceError =
  | InvalidInput
  | RepositoryNotFound
  | WorkspaceAlreadyExists
  | RequestIdConflict
  | ProvisionFailure
  | WorkspacePersistenceFailure

export type RemoveWorkspaceError =
  | InvalidInput
  | RepositoryNotFound
  | WorkspaceNotFound
  | WorkspaceRemovalRefused
  | RequestIdConflict
  | ProvisionFailure
  | WorkspacePersistenceFailure

export type WorkspaceHandleError =
  | WorkspaceHandleNotFound
  | WorkspaceFileError
  | WorkspacePersistenceFailure

export interface WorkspaceManagerApi {
  readonly validateProjectRoot: (
    projectRoot: string,
  ) => Effect.Effect<string, RepositoryNotFound | InvalidInput>
  readonly createWorkspace: (request: {
    readonly requestId: string
    readonly projectRoot: string
    readonly name: string
    readonly from?: string | undefined
  }) => Effect.Effect<WorkspaceInfo, CreateWorkspaceError>
  readonly getWorkspace: (request: {
    readonly projectRoot: string
    readonly name: string
  }) => Effect.Effect<
    WorkspaceInfo,
    InvalidInput | RepositoryNotFound | WorkspaceNotFound | WorkspacePersistenceFailure
  >
  readonly listWorkspaces: (request?: {
    readonly projectRoot?: string | undefined
  }) => Effect.Effect<
    ReadonlyArray<WorkspaceInfo>,
    InvalidInput | RepositoryNotFound | WorkspacePersistenceFailure
  >
  readonly removeWorkspace: (request: {
    readonly requestId: string
    readonly projectRoot: string
    readonly name: string
    readonly force?: boolean | undefined
  }) => Effect.Effect<RemoveWorkspaceResult, RemoveWorkspaceError>
  readonly reconcile: (request?: {
    readonly projectRoot?: string | undefined
  }) => Effect.Effect<void, InvalidInput | RepositoryNotFound | WorkspacePersistenceFailure>
  readonly readFile: (request: {
    readonly workspaceId: string
    readonly path: string
  }) => Effect.Effect<WorkspaceFileContent, WorkspaceHandleError>
  readonly writeFile: (request: {
    readonly workspaceId: string
    readonly path: string
    readonly content: string
  }) => Effect.Effect<void, WorkspaceHandleError>
  readonly statFile: (request: {
    readonly workspaceId: string
    readonly path: string
  }) => Effect.Effect<WorkspaceFileStat, WorkspaceHandleError>
  readonly listDirectory: (request: {
    readonly workspaceId: string
    readonly path?: string | undefined
  }) => Effect.Effect<ReadonlyArray<WorkspaceFileEntry>, WorkspaceHandleError>
  readonly makeDirectory: (request: {
    readonly workspaceId: string
    readonly path: string
  }) => Effect.Effect<void, WorkspaceHandleError>
  readonly removePath: (request: {
    readonly workspaceId: string
    readonly path: string
    readonly recursive?: boolean | undefined
  }) => Effect.Effect<void, WorkspaceHandleError>
  readonly startCommand: (request: {
    readonly workspaceId: string
    readonly command: string
    readonly args: ReadonlyArray<string>
    readonly cwd?: string | undefined
    readonly env?: Readonly<Record<string, string>> | undefined
  }) => Effect.Effect<CommandRun, WorkspaceHandleError | CommandStartFailure>
}

export class WorkspaceManager extends Context.Service<WorkspaceManager, WorkspaceManagerApi>()(
  "homestead/workspace/manager/WorkspaceManager",
) {}

const computeFingerprint = (payload: PayloadRecord): string => {
  const keys = Object.keys(payload)
    .filter((key) => key !== "requestId")
    .toSorted()
  const normalized: Record<string, string | number | boolean | null> = {}
  for (const key of keys) {
    const value = payload[key]
    normalized[key] = value === undefined ? null : value
  }
  return JSON.stringify(normalized)
}

const hasControlCharacter = (value: string): boolean => {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if ((code >= 0 && code <= 31) || code === 127) return true
  }
  return false
}

export const validateWorkspaceName = (name: string): Effect.Effect<string, InvalidInput> => {
  const trimmed = name.trim()
  if (trimmed.length === 0) {
    return InvalidInput.make({
      message: "Workspace name must be a non-empty string",
      field: "name",
    })
  }
  if (
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("..") ||
    trimmed.startsWith(".") ||
    trimmed.startsWith("-") ||
    hasControlCharacter(trimmed)
  ) {
    return InvalidInput.make({
      message: `Invalid Workspace name "${trimmed}". It must not contain slashes, path traversal, control characters, or begin with . or -`,
      field: "name",
    })
  }
  return Effect.succeed(trimmed)
}

const markReady = (
  workspace: WorkspaceInfo,
  handle: ProviderWorkspace,
  ports: Readonly<Record<string, number>>,
  updatedAt: number,
): WorkspaceInfo =>
  WorkspaceInfo.make({
    id: workspace.id,
    projectRoot: workspace.projectRoot,
    name: workspace.name,
    branch: workspace.branch,
    baseRevision: workspace.baseRevision,
    provider: workspace.provider,
    providerCapabilities: workspace.providerCapabilities,
    providerMetadata: handle.metadata,
    rootPath: handle.rootPath,
    ports,
    state: "ready",
    createdAt: workspace.createdAt,
    updatedAt,
  })

const markRemoving = (workspace: WorkspaceInfo, updatedAt: number): WorkspaceInfo =>
  WorkspaceInfo.make({
    id: workspace.id,
    projectRoot: workspace.projectRoot,
    name: workspace.name,
    branch: workspace.branch,
    baseRevision: workspace.baseRevision,
    provider: workspace.provider,
    providerCapabilities: workspace.providerCapabilities,
    providerMetadata: workspace.providerMetadata,
    rootPath: workspace.rootPath,
    ports: workspace.ports,
    state: "removing",
    createdAt: workspace.createdAt,
    updatedAt,
  })

export const make: Effect.Effect<
  WorkspaceManagerApi,
  WorkspacePersistenceFailure,
  | WorkspaceProvider
  | WorkspaceRegistry
  | FileSystem.FileSystem
  | Path.Path
  | Crypto.Crypto
  | Git
  | PortAllocator
  | ChildProcessSpawner.ChildProcessSpawner
  | CommandRuntime
> = Effect.gen(function* () {
  const provider = yield* WorkspaceProvider
  const registry = yield* WorkspaceRegistry
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const crypto = yield* Crypto.Crypto
  const git = yield* Git
  const portAllocator = yield* PortAllocator
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const commands = yield* CommandRuntime
  const idempotencyRef = yield* Ref.make(new Map<string, IdempotencyRecord>())

  const validateProjectRoot: WorkspaceManagerApi["validateProjectRoot"] = (projectRoot) =>
    Effect.gen(function* () {
      if (projectRoot.trim().length === 0) {
        return yield* InvalidInput.make({
          message: "Project root path must be a non-empty string",
          field: "projectRoot",
        })
      }
      const canonical = path.resolve(projectRoot)
      if (!(yield* fs.exists(canonical).pipe(Effect.orDie))) {
        return yield* RepositoryNotFound.make({
          repoRoot: canonical,
          message: `Directory does not exist: ${canonical}`,
        })
      }
      if (!(yield* fs.exists(path.join(canonical, ".git")).pipe(Effect.orDie))) {
        return yield* RepositoryNotFound.make({
          repoRoot: canonical,
          message: `Directory is not a git repository (missing .git): ${canonical}`,
        })
      }
      return canonical
    })

  const loadWorkspaceConfig = (
    projectRoot: string,
  ): Effect.Effect<HomesteadConfig, ProvisionFailure> =>
    loadConfigOrUndefined(projectRoot).pipe(
      Effect.map((config) => config ?? DEFAULT_CONFIG),
      Effect.mapError((error) =>
        ProvisionFailure.make({
          message:
            error._tag === "ConfigInvalid"
              ? `Failed to load config (${error.path}): ${error.reason}`
              : `Failed to load config: ${error.message}`,
        }),
      ),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    )

  const provideProvisionDependencies = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      | FileSystem.FileSystem
      | Path.Path
      | Git
      | PortAllocator
      | ChildProcessSpawner.ChildProcessSpawner
    >,
  ) =>
    effect.pipe(
      Effect.provideService(PortAllocator, portAllocator),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(Git, git),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    )

  const readPorts = (rootPath: string): Effect.Effect<Readonly<Record<string, number>>> =>
    Effect.gen(function* () {
      const envPath = path.join(rootPath, ".env")
      if (!(yield* fs.exists(envPath).pipe(Effect.orElseSucceed(() => false)))) return {}
      const content = yield* fs.readFileString(envPath).pipe(Effect.orElseSucceed(() => ""))
      const ports: Record<string, number> = {}
      for (const line of content.split("\n")) {
        const separator = line.indexOf("=")
        if (separator <= 0 || line.startsWith("#")) continue
        const key = line.slice(0, separator).trim()
        const value = Number(line.slice(separator + 1).trim())
        if (Number.isInteger(value) && key.includes("PORT")) ports[key] = value
      }
      return ports
    })

  const workspaceHandle = (workspaceId: string) =>
    Effect.gen(function* () {
      const workspace = yield* registry.getById(workspaceId)
      if (workspace === undefined) {
        return yield* WorkspaceHandleNotFound.make({
          workspaceId,
          message: `Workspace handle "${workspaceId}" was not found`,
        })
      }
      const found = yield* provider.find(workspace)
      if (Option.isNone(found) || found.value.rootPath === undefined) {
        return yield* WorkspaceHandleNotFound.make({
          workspaceId,
          message: `Workspace handle "${workspaceId}" is no longer available`,
        })
      }
      return { workspace, handle: found.value, rootPath: found.value.rootPath }
    })

  const scopedPath = (
    workspaceId: string,
    rootPath: string,
    requestedPath: string,
    operation: string,
  ): Effect.Effect<string, WorkspaceFileError> => {
    const relative = requestedPath.trim() === "" ? "." : requestedPath
    const absolute = nodePath.resolve(rootPath, relative)
    const withinRoot = nodePath.relative(rootPath, absolute)
    if (
      nodePath.isAbsolute(relative) ||
      relative.includes("\0") ||
      withinRoot === ".." ||
      withinRoot.startsWith(`..${nodePath.sep}`)
    ) {
      return WorkspaceFileError.make({
        workspaceId,
        path: requestedPath,
        operation,
        message: `Path must stay inside the Workspace: "${requestedPath}"`,
      })
    }
    return Effect.succeed(absolute)
  }

  const fileError = (
    workspaceId: string,
    requestedPath: string,
    operation: string,
    cause: unknown,
  ): WorkspaceFileError =>
    WorkspaceFileError.make({
      workspaceId,
      path: requestedPath,
      operation,
      message: String(cause),
    })

  const toFileType = (type: FileSystem.File.Type): WorkspaceFileStat["type"] => {
    switch (type) {
      case "File":
        return "file"
      case "Directory":
        return "directory"
      case "SymbolicLink":
        return "symlink"
      default:
        return "other"
    }
  }

  const readFile: WorkspaceManagerApi["readFile"] = (request) =>
    Effect.gen(function* () {
      const resolved = yield* workspaceHandle(request.workspaceId)
      const absolute = yield* scopedPath(
        request.workspaceId,
        resolved.rootPath,
        request.path,
        "read",
      )
      const content = yield* fs
        .readFileString(absolute)
        .pipe(
          Effect.mapError((cause) => fileError(request.workspaceId, request.path, "read", cause)),
        )
      return WorkspaceFileContent.make({
        workspaceId: request.workspaceId,
        path: request.path,
        content,
      })
    })

  const writeFile: WorkspaceManagerApi["writeFile"] = (request) =>
    Effect.gen(function* () {
      const resolved = yield* workspaceHandle(request.workspaceId)
      const absolute = yield* scopedPath(
        request.workspaceId,
        resolved.rootPath,
        request.path,
        "write",
      )
      yield* fs
        .writeFileString(absolute, request.content)
        .pipe(
          Effect.mapError((cause) => fileError(request.workspaceId, request.path, "write", cause)),
        )
    })

  const statFile: WorkspaceManagerApi["statFile"] = (request) =>
    Effect.gen(function* () {
      const resolved = yield* workspaceHandle(request.workspaceId)
      const absolute = yield* scopedPath(
        request.workspaceId,
        resolved.rootPath,
        request.path,
        "stat",
      )
      const info = yield* fs
        .stat(absolute)
        .pipe(
          Effect.mapError((cause) => fileError(request.workspaceId, request.path, "stat", cause)),
        )
      return WorkspaceFileStat.make({
        workspaceId: request.workspaceId,
        path: request.path,
        type: toFileType(info.type),
        size: Number(info.size),
        mode: info.mode,
        modifiedAt: Option.isSome(info.mtime) ? info.mtime.value.getTime() : undefined,
      })
    })

  const listDirectory: WorkspaceManagerApi["listDirectory"] = (request) =>
    Effect.gen(function* () {
      const requestedPath = request.path ?? "."
      const resolved = yield* workspaceHandle(request.workspaceId)
      const absolute = yield* scopedPath(
        request.workspaceId,
        resolved.rootPath,
        requestedPath,
        "list",
      )
      const names = yield* fs
        .readDirectory(absolute)
        .pipe(
          Effect.mapError((cause) => fileError(request.workspaceId, requestedPath, "list", cause)),
        )
      return yield* Effect.forEach(names.toSorted(), (name) =>
        Effect.gen(function* () {
          const entryPath = nodePath.join(requestedPath, name)
          const entryAbsolute = yield* scopedPath(
            request.workspaceId,
            resolved.rootPath,
            entryPath,
            "list",
          )
          const info = yield* fs
            .stat(entryAbsolute)
            .pipe(
              Effect.mapError((cause) => fileError(request.workspaceId, entryPath, "list", cause)),
            )
          return WorkspaceFileEntry.make({
            path: entryPath === "./" ? name : entryPath,
            type: toFileType(info.type),
            size: Number(info.size),
          })
        }),
      )
    })

  const makeDirectory: WorkspaceManagerApi["makeDirectory"] = (request) =>
    Effect.gen(function* () {
      const resolved = yield* workspaceHandle(request.workspaceId)
      const absolute = yield* scopedPath(
        request.workspaceId,
        resolved.rootPath,
        request.path,
        "mkdir",
      )
      yield* fs
        .makeDirectory(absolute, { recursive: true })
        .pipe(
          Effect.mapError((cause) => fileError(request.workspaceId, request.path, "mkdir", cause)),
        )
    })

  const removePath: WorkspaceManagerApi["removePath"] = (request) =>
    Effect.gen(function* () {
      if (request.path.trim() === "" || request.path === "." || request.path === "./") {
        return yield* WorkspaceFileError.make({
          workspaceId: request.workspaceId,
          path: request.path,
          operation: "remove",
          message: "Removing the Workspace root is not allowed",
        })
      }
      const resolved = yield* workspaceHandle(request.workspaceId)
      const absolute = yield* scopedPath(
        request.workspaceId,
        resolved.rootPath,
        request.path,
        "remove",
      )
      yield* fs
        .remove(absolute, { recursive: request.recursive === true, force: false })
        .pipe(
          Effect.mapError((cause) => fileError(request.workspaceId, request.path, "remove", cause)),
        )
    })

  const startCommand: WorkspaceManagerApi["startCommand"] = (request) =>
    Effect.gen(function* () {
      if (request.command.trim().length === 0) {
        return yield* CommandStartFailure.make({
          workspaceId: request.workspaceId,
          message: "Command must be a non-empty string",
        })
      }
      const resolved = yield* workspaceHandle(request.workspaceId)
      const cwd = request.cwd ?? "."
      const cwdPath = yield* scopedPath(request.workspaceId, resolved.rootPath, cwd, "command")
      return yield* commands.start({
        workspaceId: request.workspaceId,
        rootPath: resolved.rootPath,
        command: request.command,
        args: request.args,
        cwd,
        cwdPath,
        env: request.env,
      })
    })

  const attachProviderFinalizer = (workspace: WorkspaceInfo, handle: ProviderWorkspace) =>
    registry.addFinalizer(workspace.id, provider.destroy(handle))

  const runWorkspaceTeardown = (workspace: WorkspaceInfo) =>
    Effect.gen(function* () {
      const rootPath = workspace.rootPath
      if (rootPath === undefined) return
      const config = yield* loadWorkspaceConfig(workspace.projectRoot)
      const repo = {
        startCwd: workspace.projectRoot,
        primaryRoot: workspace.projectRoot,
        repoName: path.basename(workspace.projectRoot),
      }
      yield* provideProvisionDependencies(
        runTeardown(repo, rootPath, slugify(workspace.name), workspace.branch, config),
      )
    }).pipe(Effect.ignore)

  const reconcileRecord = Effect.fn("WorkspaceManager.reconcileRecord")(function* (
    workspace: WorkspaceInfo,
  ) {
    if (workspace.provider !== provider.provider) return
    const projectExists = yield* fs
      .exists(path.join(workspace.projectRoot, ".git"))
      .pipe(Effect.orElseSucceed(() => false))
    if (!projectExists) {
      yield* registry.release(workspace.id)
      return
    }
    const found = yield* provider.find(workspace)
    if (Option.isNone(found)) {
      yield* registry.release(workspace.id)
      return
    }

    yield* registry.ensureScope(workspace.id)
    yield* attachProviderFinalizer(workspace, found.value)

    if (workspace.state === "removing") {
      yield* runWorkspaceTeardown(workspace)
      yield* registry.release(workspace.id)
      return
    }

    const rootPath = found.value.rootPath
    const marker =
      rootPath === undefined
        ? Option.none()
        : yield* readProvisionMarker(rootPath).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
          )
    if (workspace.state === "provisioning" && Option.isNone(marker)) {
      yield* runWorkspaceTeardown(workspace)
      yield* registry.release(workspace.id)
      return
    }

    const now = yield* Clock.currentTimeMillis
    const ports = rootPath === undefined ? workspace.ports : yield* readPorts(rootPath)
    yield* registry
      .update(markReady(workspace, found.value, ports, now))
      .pipe(Effect.catchTag("WorkspaceNotFound", () => Effect.void))
  })

  const reconcileRegistered = (projectRoot?: string) =>
    registry
      .list(projectRoot)
      .pipe(
        Effect.flatMap((workspaces) =>
          Effect.forEach(workspaces, reconcileRecord, { concurrency: 1, discard: true }),
        ),
      )

  const importDiscovered = Effect.fn("WorkspaceManager.importDiscovered")(function* (
    projectRoot: string,
  ) {
    const registered = yield* registry.list(projectRoot)
    const keys = new Set(
      registered.map((workspace) => `${workspace.branch}\n${workspace.rootPath ?? ""}`),
    )
    const discovered = yield* provider.discover(projectRoot)

    for (const candidate of discovered) {
      const key = `${candidate.branch}\n${candidate.rootPath ?? ""}`
      if (keys.has(key) || candidate.rootPath === undefined) continue
      const marker = yield* readProvisionMarker(candidate.rootPath).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      )
      if (Option.isNone(marker)) continue

      const id = yield* crypto.randomUUIDv4.pipe(
        Effect.mapError((error) =>
          WorkspacePersistenceFailure.make({
            operation: "generate-id",
            path: registry.filePath,
            detail: String(error),
          }),
        ),
      )
      const now = yield* Clock.currentTimeMillis
      const baseRevision = yield* provider.resolveRevision(projectRoot, candidate.branch)
      const workspace = WorkspaceInfo.make({
        id,
        projectRoot,
        name: candidate.name,
        branch: candidate.branch,
        baseRevision,
        provider: provider.provider,
        providerCapabilities: provider.capabilities,
        providerMetadata: candidate.metadata,
        rootPath: candidate.rootPath,
        ports: yield* readPorts(candidate.rootPath),
        state: "ready",
        createdAt: now,
        updatedAt: now,
      })
      const registeredWorkspace = yield* registry.register(workspace).pipe(
        Effect.as(workspace),
        Effect.catchTag("WorkspaceAlreadyExists", () =>
          registry
            .get(projectRoot, candidate.name)
            .pipe(
              Effect.flatMap((existing) =>
                existing === undefined
                  ? Effect.die(new Error("Workspace disappeared during reconciliation"))
                  : Effect.succeed(existing),
              ),
            ),
        ),
      )
      yield* attachProviderFinalizer(registeredWorkspace, {
        id: registeredWorkspace.id,
        projectRoot,
        name: candidate.name,
        branch: candidate.branch,
        baseRevision: registeredWorkspace.baseRevision,
        rootPath: candidate.rootPath,
        metadata: candidate.metadata,
      })
    }
  })

  const reconcileProject = (projectRoot: string) =>
    reconcileRegistered(projectRoot).pipe(Effect.andThen(importDiscovered(projectRoot)))

  const reconcile: WorkspaceManagerApi["reconcile"] = (request) =>
    request?.projectRoot === undefined
      ? reconcileRegistered()
      : validateProjectRoot(request.projectRoot).pipe(Effect.flatMap(reconcileProject))

  function checkOrRecordIdempotency<E>(
    requestId: string,
    operation: "create",
    payload: PayloadRecord,
    computation: Effect.Effect<WorkspaceInfo, E>,
  ): Effect.Effect<WorkspaceInfo, E | RequestIdConflict>
  function checkOrRecordIdempotency<E>(
    requestId: string,
    operation: "remove",
    payload: PayloadRecord,
    computation: Effect.Effect<RemoveWorkspaceResult, E>,
  ): Effect.Effect<RemoveWorkspaceResult, E | RequestIdConflict>
  function checkOrRecordIdempotency<E>(
    requestId: string,
    operation: "create" | "remove",
    payload: PayloadRecord,
    computation: Effect.Effect<WorkspaceInfo | RemoveWorkspaceResult, E>,
  ): Effect.Effect<WorkspaceInfo | RemoveWorkspaceResult, E | RequestIdConflict> {
    return Effect.gen(function* () {
      const fingerprint = computeFingerprint(payload)
      const existing = (yield* Ref.get(idempotencyRef)).get(requestId)
      if (existing !== undefined) {
        if (existing.operation !== operation || existing.fingerprint !== fingerprint) {
          return yield* RequestIdConflict.make({
            requestId,
            message: `Request ID "${requestId}" has already been used with different parameters or operation.`,
          })
        }
        return existing.result
      }

      const result = yield* computation
      const timestamp = yield* Clock.currentTimeMillis
      yield* Ref.update(idempotencyRef, (current) => {
        const records = new Map(current)
        if (records.size >= DEFAULT_MAX_IDEMPOTENCY_ENTRIES) {
          const oldest = records.keys().next().value
          if (oldest !== undefined) records.delete(oldest)
        }
        if (operation === "create" && Schema.is(WorkspaceInfo)(result)) {
          records.set(requestId, { operation, fingerprint, result, timestamp })
        } else if (operation === "remove" && Schema.is(RemoveWorkspaceResult)(result)) {
          records.set(requestId, { operation, fingerprint, result, timestamp })
        }
        return records
      })
      return result
    })
  }

  const createWorkspace: WorkspaceManagerApi["createWorkspace"] = (request) =>
    checkOrRecordIdempotency(
      request.requestId,
      "create",
      request,
      Effect.gen(function* () {
        const projectRoot = yield* validateProjectRoot(request.projectRoot)
        const name = yield* validateWorkspaceName(request.name)
        yield* reconcileProject(projectRoot)
        const config = yield* loadWorkspaceConfig(projectRoot)
        const repoName = path.basename(projectRoot)
        const slug = slugify(name)
        const targetPath = resolveTargetDir({
          dirFlag: undefined,
          config,
          repoName,
          slug,
          branch: name,
          path,
        })
        const id = yield* crypto.randomUUIDv4.pipe(
          Effect.mapError((error) =>
            ProvisionFailure.make({
              message: `Failed to generate Workspace identity: ${String(error)}`,
            }),
          ),
        )
        const prepared = yield* provider.prepare({
          id,
          projectRoot,
          name,
          from: request.from,
          targetPath,
        })
        const createdAt = yield* Clock.currentTimeMillis
        const provisioning = WorkspaceInfo.make({
          id,
          projectRoot,
          name,
          branch: prepared.branch,
          baseRevision: prepared.baseRevision,
          provider: provider.provider,
          providerCapabilities: provider.capabilities,
          providerMetadata: prepared.metadata,
          rootPath: prepared.rootPath,
          ports: {},
          state: "provisioning",
          createdAt,
          updatedAt: createdAt,
        })

        yield* registry.register(provisioning)
        const provision = Effect.gen(function* () {
          const handle = yield* Effect.uninterruptible(
            provider
              .create(prepared)
              .pipe(Effect.tap((created) => attachProviderFinalizer(provisioning, created))),
          )
          const rootPath = handle.rootPath
          if (rootPath === undefined) {
            return yield* ProvisionFailure.make({
              message: `Provider "${provider.provider}" did not return a Workspace root`,
            })
          }
          const repo = {
            startCwd: projectRoot,
            primaryRoot: projectRoot,
            repoName,
          }
          const plan = yield* provideProvisionDependencies(
            provisionTarget(
              config,
              repo,
              { targetDir: rootPath, branch: prepared.branch, slug },
              {
                noSetup: false,
              },
            ),
          ).pipe(
            Effect.mapError((error) =>
              ProvisionFailure.make({
                message: `Workspace provisioning failed: ${String(error)}`,
              }),
            ),
            Effect.onExit((exit) =>
              exit._tag === "Failure" ? runWorkspaceTeardown(provisioning) : Effect.void,
            ),
          )
          const ports: Record<string, number> = {}
          for (const [key, value] of plan.envEdits) {
            const port = Number(value)
            if (Number.isInteger(port)) ports[key] = port
          }
          const updatedAt = yield* Clock.currentTimeMillis
          const ready = markReady(provisioning, handle, ports, updatedAt)
          yield* registry.update(ready).pipe(
            Effect.mapError((error) =>
              error._tag === "WorkspaceNotFound"
                ? ProvisionFailure.make({
                    message: `Workspace "${name}" disappeared while provisioning`,
                  })
                : error,
            ),
          )
          return ready
        })

        return yield* provision.pipe(
          Effect.onExit((exit) =>
            exit._tag === "Failure" ? registry.release(provisioning.id) : Effect.void,
          ),
        )
      }),
    )

  const getWorkspace: WorkspaceManagerApi["getWorkspace"] = (request) =>
    Effect.gen(function* () {
      const projectRoot = yield* validateProjectRoot(request.projectRoot)
      const name = yield* validateWorkspaceName(request.name)
      yield* reconcileProject(projectRoot)
      const workspace = yield* registry.get(projectRoot, name)
      if (workspace === undefined) {
        return yield* WorkspaceNotFound.make({
          name,
          projectRoot,
          message: `Workspace "${name}" not found in project "${projectRoot}"`,
        })
      }
      return workspace
    })

  const listWorkspaces: WorkspaceManagerApi["listWorkspaces"] = (request) =>
    Effect.gen(function* () {
      if (request?.projectRoot === undefined) {
        yield* reconcileRegistered()
        return yield* registry.list()
      }
      const projectRoot = yield* validateProjectRoot(request.projectRoot)
      yield* reconcileProject(projectRoot)
      return yield* registry.list(projectRoot)
    })

  const removeWorkspace: WorkspaceManagerApi["removeWorkspace"] = (request) =>
    checkOrRecordIdempotency(
      request.requestId,
      "remove",
      request,
      Effect.gen(function* () {
        const projectRoot = yield* validateProjectRoot(request.projectRoot)
        const name = yield* validateWorkspaceName(request.name)
        if (PROTECTED_BRANCHES.has(name) && request.force !== true) {
          return yield* WorkspaceRemovalRefused.make({
            name,
            projectRoot,
            reason: "protected_branch",
            message: `Refusing to remove protected branch Workspace "${name}" without force.`,
          })
        }
        yield* reconcileProject(projectRoot)
        const workspace = yield* registry.get(projectRoot, name)
        if (workspace === undefined) {
          return yield* WorkspaceNotFound.make({
            name,
            projectRoot,
            message: `Workspace "${name}" not found in project "${projectRoot}"`,
          })
        }
        const updatedAt = yield* Clock.currentTimeMillis
        yield* registry.update(markRemoving(workspace, updatedAt))
        yield* commands.cancelWorkspace(workspace.id)
        yield* runWorkspaceTeardown(workspace)
        yield* registry.release(workspace.id)
        return RemoveWorkspaceResult.make({
          removed: true,
          id: workspace.id,
          projectRoot,
          name,
        })
      }),
    )

  return WorkspaceManager.of({
    validateProjectRoot,
    createWorkspace,
    getWorkspace,
    listWorkspaces,
    removeWorkspace,
    reconcile,
    readFile,
    writeFile,
    statFile,
    listDirectory,
    makeDirectory,
    removePath,
    startCommand,
  })
})

export const layerWithoutDependencies = Layer.effect(WorkspaceManager, make)
