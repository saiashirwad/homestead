import type { Layer } from "effect"
import { WorktreeManagerLive } from "./worktree/manager.ts"

export const AppLayer = WorktreeManagerLive

export type AppServices = Layer.Success<typeof AppLayer>
