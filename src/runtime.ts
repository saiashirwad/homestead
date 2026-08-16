import { BunServices } from "@effect/platform-bun";
import { Layer } from "effect";
import { GitLive } from "./git/service.ts";
import { PortAllocator } from "./worktree/ports.ts";
import { WorktreeManagerLive } from "./worktree/manager.ts";

export const AppLayer = Layer.provideMerge(
  Layer.mergeAll(GitLive, PortAllocator.layer, WorktreeManagerLive),
  BunServices.layer,
);

export type AppServices = Layer.Success<typeof AppLayer>;
