import { BunServices } from "@effect/platform-bun"
import {
  Context,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Path,
  Ref,
  Schema,
  Scope,
  Semaphore,
} from "effect"
import * as os from "node:os"
import * as nodePath from "node:path"
import {
  WorkspaceAlreadyExists,
  WorkspaceNotFound,
  WorkspacePersistenceFailure,
} from "../errors.ts"
import { WorkspaceInfo } from "../types.ts"

export interface WorkspaceRegistryOptions {
  readonly filePath?: string | undefined
}

const RegistryFileSchema = Schema.Struct({
  version: Schema.Literal(1),
  workspaces: Schema.Array(WorkspaceInfo),
})

interface RegistryState {
  readonly workspaces: Map<string, WorkspaceInfo>
}

interface RuntimeState {
  readonly scopes: Map<string, Scope.Closeable>
  readonly finalizers: Set<string>
}

export type WorkspaceRegistryError =
  | WorkspaceAlreadyExists
  | WorkspaceNotFound
  | WorkspacePersistenceFailure

export interface WorkspaceRegistryApi {
  readonly filePath: string
  readonly register: (
    workspace: WorkspaceInfo,
  ) => Effect.Effect<void, WorkspaceAlreadyExists | WorkspacePersistenceFailure>
  readonly update: (
    workspace: WorkspaceInfo,
  ) => Effect.Effect<void, WorkspaceNotFound | WorkspacePersistenceFailure>
  readonly get: (
    projectRoot: string,
    name: string,
  ) => Effect.Effect<WorkspaceInfo | undefined, WorkspacePersistenceFailure>
  readonly list: (
    projectRoot?: string,
  ) => Effect.Effect<ReadonlyArray<WorkspaceInfo>, WorkspacePersistenceFailure>
  readonly ensureScope: (workspaceId: string) => Effect.Effect<void>
  readonly addFinalizer: (
    workspaceId: string,
    finalizer: Effect.Effect<void>,
  ) => Effect.Effect<void>
  readonly release: (workspaceId: string) => Effect.Effect<void, WorkspacePersistenceFailure>
}

export class WorkspaceRegistry extends Context.Service<WorkspaceRegistry, WorkspaceRegistryApi>()(
  "homestead/workspace/registry/WorkspaceRegistry",
) {}

export const getDefaultWorkspaceRegistryPath = (): string => {
  const stateDirectory = process.env.HOMESTEAD_STATE_DIR
  return nodePath.join(
    stateDirectory ?? nodePath.join(os.homedir(), ".homestead", "state"),
    "workspaces.json",
  )
}

const makePersistenceFailure = (
  operation: string,
  filePath: string,
  cause: unknown,
): WorkspacePersistenceFailure =>
  WorkspacePersistenceFailure.make({
    operation,
    path: filePath,
    detail: String(cause),
  })

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    return cause instanceof Error && "code" in cause && cause.code === "EPERM"
  }
}

const LOCK_RETRY_DELAY = "25 millis"
const LOCK_MAX_ATTEMPTS = 200

export const make = (options: WorkspaceRegistryOptions = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const filePath = options.filePath ?? getDefaultWorkspaceRegistryPath()
    const lockPath = `${filePath}.lock`
    const tempPath = `${filePath}.${process.pid}.tmp`
    const mutex = yield* Semaphore.make(1)
    const runtimeMutex = yield* Semaphore.make(1)
    const stateRef = yield* Ref.make<RegistryState>({ workspaces: new Map() })
    const runtimeRef = yield* Ref.make<RuntimeState>({
      scopes: new Map(),
      finalizers: new Set(),
    })

    const readDisk = Effect.fn("WorkspaceRegistry.readDisk")(function* () {
      const exists = yield* fs
        .exists(filePath)
        .pipe(Effect.mapError((cause) => makePersistenceFailure("read", filePath, cause)))
      if (!exists) return { workspaces: new Map() } satisfies RegistryState

      const content = yield* fs
        .readFileString(filePath)
        .pipe(Effect.mapError((cause) => makePersistenceFailure("read", filePath, cause)))
      const decoded = yield* Schema.decodeEffect(Schema.fromJsonString(RegistryFileSchema))(
        content,
      ).pipe(Effect.mapError((cause) => makePersistenceFailure("decode", filePath, cause)))
      return {
        workspaces: new Map(decoded.workspaces.map((workspace) => [workspace.id, workspace])),
      } satisfies RegistryState
    })

    const writeDisk = Effect.fn("WorkspaceRegistry.writeDisk")(function* (state: RegistryState) {
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(RegistryFileSchema))({
        version: 1,
        workspaces: Array.from(state.workspaces.values()),
      }).pipe(Effect.mapError((cause) => makePersistenceFailure("encode", filePath, cause)))

      yield* fs
        .makeDirectory(path.dirname(filePath), { recursive: true })
        .pipe(Effect.mapError((cause) => makePersistenceFailure("write", filePath, cause)))
      yield* fs.writeFileString(tempPath, `${encoded}\n`).pipe(
        Effect.andThen(fs.rename(tempPath, filePath)),
        Effect.mapError((cause) => makePersistenceFailure("write", filePath, cause)),
        Effect.ensuring(fs.remove(tempPath).pipe(Effect.ignore)),
      )
    })

    const acquireLock = Effect.fn("WorkspaceRegistry.acquireLock")(function* () {
      yield* fs
        .makeDirectory(path.dirname(filePath), { recursive: true })
        .pipe(Effect.mapError((cause) => makePersistenceFailure("lock", lockPath, cause)))

      for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt++) {
        const acquired = yield* fs
          .writeFileString(lockPath, `${process.pid}\n`, { flag: "wx" })
          .pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          )
        if (acquired) return true

        const owner = yield* fs.readFileString(lockPath).pipe(Effect.orElseSucceed(() => ""))
        const ownerPid = Number(owner.trim())
        if (!Number.isInteger(ownerPid) || !isProcessAlive(ownerPid)) {
          yield* fs.remove(lockPath).pipe(Effect.ignore)
        } else {
          yield* Effect.sleep(LOCK_RETRY_DELAY)
        }
      }

      return yield* makePersistenceFailure(
        "lock",
        lockPath,
        `could not acquire registry lock after ${LOCK_MAX_ATTEMPTS} attempts`,
      )
    })

    const withFileLock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.acquireUseRelease(
        acquireLock(),
        () => effect,
        () => fs.remove(lockPath).pipe(Effect.ignore),
      )

    const refresh = mutex.withPermit(
      readDisk().pipe(Effect.tap((state) => Ref.set(stateRef, state))),
    )

    const mutate = <E>(
      operation: (state: RegistryState) => Effect.Effect<RegistryState, E>,
    ): Effect.Effect<void, E | WorkspacePersistenceFailure> =>
      mutex.withPermit(
        withFileLock(
          Effect.gen(function* () {
            const current = yield* readDisk()
            const updated = yield* operation(current)
            yield* writeDisk(updated)
            yield* Ref.set(stateRef, updated)
          }),
        ),
      )

    const ensureScopeUnlocked = (workspaceId: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const runtime = yield* Ref.get(runtimeRef)
        if (runtime.scopes.has(workspaceId)) return
        const scope = yield* Scope.make("sequential")
        yield* Ref.update(runtimeRef, (current) => {
          if (current.scopes.has(workspaceId)) {
            return current
          }
          const scopes = new Map(current.scopes)
          scopes.set(workspaceId, scope)
          return { ...current, scopes }
        })
      })

    const ensureScope = (workspaceId: string): Effect.Effect<void> =>
      runtimeMutex.withPermit(ensureScopeUnlocked(workspaceId))

    const register: WorkspaceRegistryApi["register"] = (workspace) =>
      Effect.uninterruptible(
        mutate((state) => {
          const duplicate = Array.from(state.workspaces.values()).find(
            (candidate) =>
              candidate.id === workspace.id ||
              (candidate.projectRoot === workspace.projectRoot &&
                candidate.name === workspace.name),
          )
          if (duplicate !== undefined) {
            return WorkspaceAlreadyExists.make({
              name: workspace.name,
              projectRoot: workspace.projectRoot,
              message: `Workspace "${workspace.name}" already exists in project "${workspace.projectRoot}"`,
            })
          }
          const workspaces = new Map(state.workspaces)
          workspaces.set(workspace.id, workspace)
          return Effect.succeed({ workspaces })
        }).pipe(Effect.andThen(ensureScope(workspace.id))),
      )

    const update: WorkspaceRegistryApi["update"] = (workspace) =>
      mutate((state) => {
        if (!state.workspaces.has(workspace.id)) {
          return WorkspaceNotFound.make({
            name: workspace.name,
            projectRoot: workspace.projectRoot,
            message: `Workspace "${workspace.name}" is not registered`,
          })
        }
        const workspaces = new Map(state.workspaces)
        workspaces.set(workspace.id, workspace)
        return Effect.succeed({ workspaces })
      })

    const list: WorkspaceRegistryApi["list"] = (projectRoot) =>
      refresh.pipe(
        Effect.andThen(Ref.get(stateRef)),
        Effect.map((state) => {
          const all = Array.from(state.workspaces.values())
          return projectRoot === undefined
            ? all
            : all.filter((workspace) => workspace.projectRoot === projectRoot)
        }),
      )

    const get: WorkspaceRegistryApi["get"] = (projectRoot, name) =>
      list(projectRoot).pipe(
        Effect.map((workspaces) => workspaces.find((workspace) => workspace.name === name)),
      )

    const addFinalizer: WorkspaceRegistryApi["addFinalizer"] = (workspaceId, finalizer) =>
      runtimeMutex.withPermit(
        Effect.gen(function* () {
          yield* ensureScopeUnlocked(workspaceId)
          const runtime = yield* Ref.get(runtimeRef)
          if (runtime.finalizers.has(workspaceId)) return
          const scope = runtime.scopes.get(workspaceId)
          if (scope === undefined) return
          yield* Scope.addFinalizer(scope, finalizer)
          yield* Ref.update(runtimeRef, (current) => {
            const finalizers = new Set(current.finalizers)
            finalizers.add(workspaceId)
            return { ...current, finalizers }
          })
        }),
      )

    const release: WorkspaceRegistryApi["release"] = (workspaceId) =>
      Effect.gen(function* () {
        yield* runtimeMutex.withPermit(
          Effect.gen(function* () {
            const runtime = yield* Ref.get(runtimeRef)
            const scope = runtime.scopes.get(workspaceId)
            if (scope !== undefined) {
              yield* Scope.close(scope, Exit.void)
            }
            yield* Ref.update(runtimeRef, (current) => {
              const scopes = new Map(current.scopes)
              scopes.delete(workspaceId)
              const finalizers = new Set(current.finalizers)
              finalizers.delete(workspaceId)
              return { scopes, finalizers }
            })
          }),
        )
        yield* mutate((state) => {
          const workspaces = new Map(state.workspaces)
          workspaces.delete(workspaceId)
          return Effect.succeed({ workspaces })
        })
      })

    yield* refresh

    return WorkspaceRegistry.of({
      filePath,
      register,
      update,
      get,
      list,
      ensureScope,
      addFinalizer,
      release,
    })
  })

export const layerWithoutDependencies = (options: WorkspaceRegistryOptions = {}) =>
  Layer.effect(WorkspaceRegistry, make(options))

export const layer = (options: WorkspaceRegistryOptions = {}) =>
  layerWithoutDependencies(options).pipe(Layer.provide(BunServices.layer))
