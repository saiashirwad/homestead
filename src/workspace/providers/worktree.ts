import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Layer, Option, Path } from "effect"
import * as nodePath from "node:path"
import { ProvisionFailure, WorkspaceAlreadyExists } from "../../errors.ts"
import { Git, GitLive } from "../../git/service.ts"
import { ProviderCapabilities, type WorkspaceInfo } from "../../types.ts"
import { resolveDefaultBaseRef } from "../../worktree/base-ref.ts"
import { WorkspaceProvider, type ProviderWorkspace } from "../provider.ts"

const capabilities = ProviderCapabilities.make({
  filesystemIsolation: "rooted",
  networkIsolation: "host",
  survivesHostDisconnect: false,
  supportsPortals: true,
})

const fromInfo = (workspace: WorkspaceInfo): ProviderWorkspace => ({
  id: workspace.id,
  projectRoot: workspace.projectRoot,
  name: workspace.name,
  branch: workspace.branch,
  baseRevision: workspace.baseRevision,
  rootPath: workspace.rootPath,
  metadata: workspace.providerMetadata,
})

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const git = yield* Git
  const path = yield* Path.Path

  return WorkspaceProvider.of({
    provider: "worktree",
    capabilities,

    prepare: Effect.fn("WorktreeProvider.prepare")(function* (request) {
      const slug = nodePath.basename(request.targetPath)
      const existing = yield* git.worktree.list(request.projectRoot)
      if (
        existing.some(
          (worktree) => worktree.branch === request.name || path.basename(worktree.path) === slug,
        )
      ) {
        return yield* WorkspaceAlreadyExists.make({
          name: request.name,
          projectRoot: request.projectRoot,
          message: `Workspace or branch "${request.name}" already exists in project "${request.projectRoot}"`,
        })
      }

      if (yield* fs.exists(request.targetPath).pipe(Effect.orDie)) {
        return yield* WorkspaceAlreadyExists.make({
          name: request.name,
          projectRoot: request.projectRoot,
          message: `Target Workspace directory already exists: ${request.targetPath}`,
        })
      }

      const branchAlreadyExists = yield* git.refExists(
        request.projectRoot,
        `refs/heads/${request.name}`,
      )
      const baseRef = branchAlreadyExists
        ? request.name
        : (request.from ??
          (yield* resolveDefaultBaseRef(request.projectRoot).pipe(
            Effect.mapError((error) =>
              ProvisionFailure.make({
                message: error.message,
              }),
            ),
            Effect.provideService(Git, git),
          )))
      const baseRevision = yield* git.revision(request.projectRoot, baseRef)

      return {
        id: request.id,
        projectRoot: request.projectRoot,
        name: request.name,
        branch: request.name,
        baseRevision,
        rootPath: request.targetPath,
        metadata: { path: request.targetPath },
        branchAlreadyExists,
      }
    }),

    create: Effect.fn("WorktreeProvider.create")(function* (prepared) {
      const rootPath = prepared.rootPath
      if (rootPath === undefined) {
        return yield* Effect.die(new Error("Worktree Provider requires a root path"))
      }

      yield* fs.makeDirectory(path.dirname(rootPath), { recursive: true }).pipe(Effect.orDie)
      if (prepared.branchAlreadyExists) {
        yield* git.worktree.add(prepared.projectRoot, {
          dir: rootPath,
          branch: prepared.branch,
        })
      } else {
        yield* git.worktree.addNew(prepared.projectRoot, {
          dir: rootPath,
          branch: prepared.branch,
          baseRef: prepared.baseRevision,
        })
      }

      return prepared
    }),

    find: Effect.fn("WorktreeProvider.find")(function* (workspace) {
      const entries = yield* git.worktree.list(workspace.projectRoot)
      const entry = entries.find(
        (candidate) =>
          candidate.branch === workspace.branch ||
          (workspace.rootPath !== undefined &&
            path.resolve(candidate.path) === path.resolve(workspace.rootPath)),
      )
      return entry === undefined
        ? Option.none<ProviderWorkspace>()
        : Option.some({
            ...fromInfo(workspace),
            rootPath: entry.path,
            metadata: { path: entry.path },
          })
    }),

    discover: Effect.fn("WorktreeProvider.discover")(function* (projectRoot) {
      const entries = yield* git.worktree.list(projectRoot)
      return entries.map((entry) => {
        const name = entry.branch ?? path.basename(entry.path)
        return {
          projectRoot,
          name,
          branch: entry.branch ?? "HEAD",
          rootPath: entry.path,
          metadata: { path: entry.path },
        }
      })
    }),

    destroy: Effect.fn("WorktreeProvider.destroy")(function* (workspace) {
      const rootPath = workspace.rootPath
      if (rootPath !== undefined) {
        yield* git.worktree.remove(workspace.projectRoot, rootPath)
      }
      yield* git.worktree.prune(workspace.projectRoot).pipe(Effect.ignore)
      if (workspace.branch !== "main" && workspace.branch !== "master") {
        yield* git.branch.delete(workspace.projectRoot, workspace.branch).pipe(Effect.ignore)
      }
    }),

    resolveRevision: (projectRoot, ref) => git.revision(projectRoot, ref),
  })
})

export const layerWithoutDependencies = Layer.effect(WorkspaceProvider, make)

const GitServiceLive = GitLive.pipe(Layer.provide(BunServices.layer))

export const layer = layerWithoutDependencies.pipe(
  Layer.provide(GitServiceLive),
  Layer.provide(BunServices.layer),
)
