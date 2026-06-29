import { BunServices } from "@effect/platform-bun";
import { Layer } from "effect";
import { Herdr } from "./herdr/service.ts";
import { PortAllocator } from "./worktree/ports.ts";

// The single application layer: the herdr read/write surface plus the in-process
// port-allocation semaphore, both over Bun's platform services (FileSystem, Path,
// CommandExecutor, …). Defined ONCE here so cli.ts and mcp.ts share one
// definition — and, crucially, so the mcp server can build it into a single
// ManagedRuntime whose lone PortAllocator semaphore serializes port picks across
// every tool call (see src/mcp.ts). Building it per call would mint a fresh
// semaphore each time and lose that in-process collision avoidance.
export const AppLayer = Layer.provideMerge(
  Layer.mergeAll(Layer.effect(Herdr, Herdr.make), PortAllocator.layer),
  BunServices.layer,
);

// The services AppLayer provides — the environment every tool program runs in.
export type AppServices = Layer.Success<typeof AppLayer>;
