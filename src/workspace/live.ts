import { BunServices } from "@effect/platform-bun"
import { Layer } from "effect"
import { GitLive } from "../git/service.ts"
import { PortAllocator } from "../worktree/ports.ts"
import { layerWithoutDependencies as workspaceManagerLayer } from "./manager.ts"
import {
  layerWithoutDependencies as commandRuntimeLayer,
  type CommandRuntimeOptions,
} from "./commands.ts"
import {
  layerWithoutDependencies as workspaceRegistryLayer,
  type WorkspaceRegistryOptions,
} from "./registry.ts"
import { layerWithoutDependencies as worktreeProviderLayer } from "./providers/worktree.ts"

export interface WorkspaceLiveOptions {
  readonly registry?: WorkspaceRegistryOptions | undefined
  readonly commands?: CommandRuntimeOptions | undefined
}

export const makeWorkspaceManagerLayer = (options: WorkspaceLiveOptions = {}) => {
  const PlatformLive = BunServices.layer
  const GitServiceLive = GitLive.pipe(Layer.provide(PlatformLive))
  const ProviderLive = worktreeProviderLayer.pipe(
    Layer.provide(GitServiceLive),
    Layer.provide(PlatformLive),
  )
  const RegistryLive = workspaceRegistryLayer(options.registry).pipe(Layer.provide(PlatformLive))
  const PortAllocatorLive = PortAllocator.layer
  const CommandRuntimeLive = commandRuntimeLayer(options.commands)

  const ManagerLive = workspaceManagerLayer.pipe(
    Layer.provide(CommandRuntimeLive),
    Layer.provide(ProviderLive),
    Layer.provide(RegistryLive),
    Layer.provide(PortAllocatorLive),
    Layer.provide(GitServiceLive),
    Layer.provide(PlatformLive),
  )

  return Layer.merge(CommandRuntimeLive, ManagerLive)
}

export const WorkspaceManagerLive = makeWorkspaceManagerLayer()
