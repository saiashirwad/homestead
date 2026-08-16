import { Clock, Effect } from "effect"
import { WorktreeManager } from "../worktree/manager.ts"
import { WorkspaceManager } from "../workspace/manager.ts"
import { HomesteadRpcs } from "./shared.ts"

export const makeHomesteadHandlers = (onShutdown?: Effect.Effect<void>) =>
  HomesteadRpcs.toLayer(
    Effect.gen(function* () {
      const manager = yield* WorktreeManager
      const workspaces = yield* WorkspaceManager
      yield* workspaces.reconcile()

      return HomesteadRpcs.of({
        "v1/daemon/ping": () =>
          Clock.currentTimeMillis.pipe(Effect.map((timestamp) => ({ timestamp }))),

        "v1/daemon/shutdown": () => onShutdown ?? Effect.void,

        "v1/worktree/create": (payload) => manager.createWorktree(payload),

        "v1/worktree/list": (payload) => manager.listWorktrees(payload),

        "v1/worktree/remove": (payload) => manager.removeWorktree(payload),

        "v1/workspace/create": (payload) => workspaces.createWorkspace(payload),

        "v1/workspace/get": (payload) => workspaces.getWorkspace(payload),

        "v1/workspace/list": (payload) => workspaces.listWorkspaces(payload),

        "v1/workspace/remove": (payload) => workspaces.removeWorkspace(payload),

        "v1/workspace/reconcile": (payload) => workspaces.reconcile(payload),
      })
    }),
  )
