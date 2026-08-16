import { describe, expect, it } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { WorkspaceInfo } from "../../src/types.ts"
import {
  layerWithoutDependencies as registryLayer,
  WorkspaceRegistry,
} from "../../src/workspace/registry.ts"

const makeLayer = (filePath: string) =>
  registryLayer({ filePath }).pipe(Layer.provide(BunServices.layer))

const workspace = WorkspaceInfo.make({
  id: "workspace-registry-test",
  projectRoot: "/project",
  name: "registry-test",
  branch: "registry-test",
  baseRevision: "abc123",
  provider: "worktree",
  providerCapabilities: {
    filesystemIsolation: "rooted",
    networkIsolation: "host",
    survivesHostDisconnect: false,
    supportsPortals: true,
  },
  providerMetadata: { path: "/workspaces/registry-test" },
  rootPath: "/workspaces/registry-test",
  ports: { PORT: 3001 },
  state: "ready",
  createdAt: 1,
  updatedAt: 2,
})

describe("WorkspaceRegistry", () => {
  it("persists records across Layer reconstruction and closes retained scopes on release", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "homestead-registry-test-"))
    const filePath = path.join(root, "workspaces.json")
    let finalized = 0
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const registry = yield* WorkspaceRegistry
          yield* registry.register(workspace)
        }).pipe(Effect.provide(makeLayer(filePath))),
      )

      await Effect.runPromise(
        Effect.gen(function* () {
          const registry = yield* WorkspaceRegistry
          const restored = yield* registry.get(workspace.projectRoot, workspace.name)
          expect(restored?.id).toBe(workspace.id)
          yield* registry.ensureScope(workspace.id)
          yield* registry.addFinalizer(
            workspace.id,
            Effect.sync(() => {
              finalized += 1
            }),
          )
          yield* registry.release(workspace.id)
          expect(yield* registry.list()).toEqual([])
        }).pipe(Effect.provide(makeLayer(filePath))),
      )

      expect(finalized).toBe(1)
      await Effect.runPromise(
        Effect.gen(function* () {
          const registry = yield* WorkspaceRegistry
          expect(yield* registry.list()).toEqual([])
        }).pipe(Effect.provide(makeLayer(filePath))),
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
