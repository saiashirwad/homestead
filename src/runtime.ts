import { BunServices } from "@effect/platform-bun"
import { Layer } from "effect"
import { GitLive } from "./git/service.ts"
import { layerWithoutDependencies as worktreeManagerLayer } from "./worktree/manager.ts"
import { makeWorkspaceManagerLayer, type WorkspaceLiveOptions } from "./workspace/live.ts"

export const makeAppLayer = (options: WorkspaceLiveOptions = {}) => {
  const WorkspaceLive = makeWorkspaceManagerLayer(options)
  const GitServiceLive = GitLive.pipe(Layer.provide(BunServices.layer))
  const WorktreeLive = worktreeManagerLayer.pipe(
    Layer.provide(WorkspaceLive),
    Layer.provide(GitServiceLive),
    Layer.provide(BunServices.layer),
  )
  const ManagersLive = Layer.merge(WorkspaceLive, WorktreeLive)
  return Layer.mergeAll(ManagersLive, GitServiceLive, BunServices.layer)
}

export const AppLayer = makeAppLayer()

export type AppServices = Layer.Success<typeof AppLayer>
