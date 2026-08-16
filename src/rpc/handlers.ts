import { Effect } from "effect";
import { WorktreeManager } from "../worktree/manager.ts";
import { HomesteadRpcs } from "./shared.ts";

export const makeHomesteadHandlers = (
  onShutdown?: Effect.Effect<void>,
) =>
  HomesteadRpcs.toLayer(
    Effect.gen(function* () {
      const manager = yield* WorktreeManager;

      return HomesteadRpcs.of({
        "v1/daemon/ping": () =>
          Effect.succeed({ timestamp: Date.now() }),

        "v1/daemon/shutdown": () =>
          onShutdown ?? Effect.void,

        "v1/worktree/create": (payload) =>
          manager.createWorktree(payload),

        "v1/worktree/list": (payload) =>
          manager.listWorktrees(payload),

        "v1/worktree/remove": (payload) =>
          manager.removeWorktree(payload),
      });
    }),
  );
