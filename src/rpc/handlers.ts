import { Clock, Effect } from "effect"
import { WorktreeManager } from "../worktree/manager.ts"
import { WorkspaceManager } from "../workspace/manager.ts"
import { CommandRuntime } from "../workspace/commands.ts"
import { HomesteadRpcs } from "./shared.ts"

export const makeHomesteadHandlers = (onShutdown?: Effect.Effect<void>) =>
  HomesteadRpcs.toLayer(
    Effect.gen(function* () {
      const manager = yield* WorktreeManager
      const workspaces = yield* WorkspaceManager
      const commands = yield* CommandRuntime
      yield* workspaces.reconcile()
      yield* commands.reconcile

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

        "v1/workspace/file/read": (payload) => workspaces.readFile(payload),

        "v1/workspace/file/write": (payload) => workspaces.writeFile(payload),

        "v1/workspace/file/stat": (payload) => workspaces.statFile(payload),

        "v1/workspace/file/list": (payload) => workspaces.listDirectory(payload),

        "v1/workspace/file/mkdir": (payload) => workspaces.makeDirectory(payload),

        "v1/workspace/file/remove": (payload) => workspaces.removePath(payload),

        "v1/workspace/command/start": (payload) => workspaces.startCommand(payload),

        "v1/workspace/command/get": (payload) => commands.get(payload.workspaceId, payload.runId),

        "v1/workspace/command/list": (payload) => commands.list(payload.workspaceId),

        "v1/workspace/command/input": (payload) =>
          commands.input(payload.workspaceId, payload.runId, payload.data),

        "v1/workspace/command/cancel": (payload) =>
          commands.cancel(payload.workspaceId, payload.runId),

        "v1/workspace/command/events": (payload) => commands.events(payload),
      })
    }),
  )
