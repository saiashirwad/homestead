import { BunServices } from "@effect/platform-bun"
import { Clock, Context, Effect, FileSystem, Layer, Path } from "effect"
import {
  InvalidInput,
  ProvisionFailure,
  RepositoryNotFound,
  RequestIdConflict,
  WorktreeAlreadyExists,
  WorktreeNotFound,
  WorktreeRemovalRefused,
} from "../errors.ts"
import { Git, GitLive } from "../git/service.ts"
import { RemoveWorktreeResult, WorktreeInfo, type WorkspaceInfo } from "../types.ts"
import { makeWorkspaceManagerLayer, type WorkspaceLiveOptions } from "../workspace/live.ts"
import { WorkspaceManager } from "../workspace/manager.ts"

export interface WorktreeManagerApi {
  readonly validateRepoRoot: (
    repoRoot: string,
  ) => Effect.Effect<string, RepositoryNotFound | InvalidInput>
  readonly createWorktree: (payload: {
    readonly requestId: string
    readonly repoRoot: string
    readonly name: string
    readonly from?: string | undefined
  }) => Effect.Effect<
    WorktreeInfo,
    InvalidInput | RepositoryNotFound | WorktreeAlreadyExists | RequestIdConflict | ProvisionFailure
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
  >
  readonly listWorktrees: (payload?: {
    readonly repoRoot?: string | undefined
  }) => Effect.Effect<
    ReadonlyArray<WorktreeInfo>,
    InvalidInput | RepositoryNotFound | ProvisionFailure
  >
}

export class WorktreeManager extends Context.Service<WorktreeManager, WorktreeManagerApi>()(
  "homestead/worktree/manager/WorktreeManager",
) {}

const toWorktreeInfo = (workspace: WorkspaceInfo): WorktreeInfo =>
  WorktreeInfo.make({
    repoRoot: workspace.projectRoot,
    name: workspace.name,
    branch: workspace.branch,
    path: workspace.rootPath ?? workspace.providerMetadata.path ?? "",
    ports: workspace.ports,
    createdAt: workspace.createdAt,
  })

export const make = Effect.gen(function* () {
  const manager = yield* WorkspaceManager
  const fs = yield* FileSystem.FileSystem
  const git = yield* Git
  const path = yield* Path.Path

  const readPorts = (worktreePath: string) =>
    Effect.gen(function* () {
      const envPath = path.join(worktreePath, ".env")
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

  return WorktreeManager.of({
    validateRepoRoot: manager.validateProjectRoot,

    createWorktree: (payload) =>
      manager
        .createWorkspace({
          requestId: payload.requestId,
          projectRoot: payload.repoRoot,
          name: payload.name,
          from: payload.from,
        })
        .pipe(
          Effect.map(toWorktreeInfo),
          Effect.catchTags({
            WorkspaceAlreadyExists: (error) =>
              WorktreeAlreadyExists.make({
                name: error.name,
                repoRoot: error.projectRoot,
                message: error.message,
              }),
            WorkspacePersistenceFailure: (error) =>
              ProvisionFailure.make({
                message: `Workspace registry ${error.operation} failed: ${error.detail}`,
              }),
          }),
        ),

    removeWorktree: (payload) =>
      manager
        .removeWorkspace({
          requestId: payload.requestId,
          projectRoot: payload.repoRoot,
          name: payload.name,
          force: payload.force,
        })
        .pipe(
          Effect.map((result) =>
            RemoveWorktreeResult.make({
              removed: result.removed,
              repoRoot: result.projectRoot,
              name: result.name,
            }),
          ),
          Effect.catchTags({
            WorkspaceNotFound: (error) =>
              WorktreeNotFound.make({
                name: error.name,
                repoRoot: error.projectRoot,
                message: error.message,
              }),
            WorkspaceRemovalRefused: (error) =>
              WorktreeRemovalRefused.make({
                name: error.name,
                repoRoot: error.projectRoot,
                reason: error.reason,
                message: error.message,
              }),
            WorkspacePersistenceFailure: (error) =>
              ProvisionFailure.make({
                message: `Workspace registry ${error.operation} failed: ${error.detail}`,
              }),
          }),
        ),

    listWorktrees: (payload) => {
      const requestedRepoRoot = payload?.repoRoot
      return (
        requestedRepoRoot === undefined
          ? manager
              .listWorkspaces()
              .pipe(Effect.map((workspaces) => workspaces.map(toWorktreeInfo)))
          : Effect.gen(function* () {
              const repoRoot = yield* manager.validateProjectRoot(requestedRepoRoot)
              const managed = yield* manager.listWorkspaces({ projectRoot: repoRoot })
              const entries = yield* git.worktree.list(repoRoot)
              const now = yield* Clock.currentTimeMillis
              return yield* Effect.forEach(entries, (entry) => {
                const workspace = managed.find(
                  (candidate) =>
                    candidate.branch === entry.branch || candidate.rootPath === entry.path,
                )
                if (workspace !== undefined) return Effect.succeed(toWorktreeInfo(workspace))
                const name = entry.branch ?? path.basename(entry.path)
                return readPorts(entry.path).pipe(
                  Effect.map((ports) =>
                    WorktreeInfo.make({
                      repoRoot,
                      name,
                      branch: entry.branch ?? "HEAD",
                      path: entry.path,
                      ports,
                      createdAt: now,
                    }),
                  ),
                )
              })
            })
      ).pipe(
        Effect.catchTag("WorkspacePersistenceFailure", (error) =>
          ProvisionFailure.make({
            message: `Workspace registry ${error.operation} failed: ${error.detail}`,
          }),
        ),
      )
    },
  })
})

export const layerWithoutDependencies = Layer.effect(WorktreeManager, make)

export const makeWorktreeManagerLayer = (options: WorkspaceLiveOptions = {}) =>
  layerWithoutDependencies.pipe(
    Layer.provide(makeWorkspaceManagerLayer(options)),
    Layer.provide(GitLive.pipe(Layer.provide(BunServices.layer))),
    Layer.provide(BunServices.layer),
  )

export const WorktreeManagerLive = makeWorktreeManagerLayer()
