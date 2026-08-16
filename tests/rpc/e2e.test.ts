import { describe, expect, it } from "bun:test"
import { BunFileSystem, BunPath, BunSocket } from "@effect/platform-bun"
import { RpcClient, RpcSerialization } from "effect/unstable/rpc"
import { Deferred, Effect, Fiber, Layer, Scope } from "effect"
import * as fs from "node:fs"
import { makeServer } from "../../src/rpc/server.ts"
import { makeHomesteadClient } from "../../src/rpc/shared.ts"
import { createTempGitRepo, createTempSocket } from "../helpers.ts"

const ServerEnv = Layer.merge(BunFileSystem.layer, BunPath.layer)

describe("Homestead UDS End-to-End RPC Flow", () => {
  it("executes ping, create, list, rm, and shutdown over Unix Domain Socket with deterministic readiness", async () => {
    const tempSock = createTempSocket()
    const fixture = createTempGitRepo()

    try {
      const testProgram = Effect.scoped(
        Effect.gen(function* () {
          const readyDeferred = yield* Deferred.make<void>()

          const serverFiber = yield* Effect.forkScoped(
            makeServer(tempSock.path, {
              onReady: readyDeferred,
              registryFilePath: fixture.registryFile,
            }),
          )

          yield* Deferred.await(readyDeferred)

          const ClientEnv = RpcClient.layerProtocolSocket().pipe(
            Layer.provide(BunSocket.layerNet({ path: tempSock.path })),
            Layer.provide(RpcSerialization.layerNdjson),
          )

          const runClient = <A, E>(
            clientEff: Effect.Effect<A, E, RpcClient.Protocol | Scope.Scope>,
          ) => Effect.scoped(clientEff).pipe(Effect.provide(ClientEnv))

          const pong = yield* runClient(
            Effect.gen(function* () {
              const client = yield* makeHomesteadClient
              return yield* client.ping
            }),
          )
          expect(pong.timestamp).toBeGreaterThan(0)

          const created = yield* runClient(
            Effect.gen(function* () {
              const client = yield* makeHomesteadClient
              return yield* client.createWorktree({
                requestId: "e2e-req-create-1",
                repoRoot: fixture.dir,
                name: "e2e-feature-branch",
                from: "main",
              })
            }),
          )
          expect(created.name).toBe("e2e-feature-branch")
          expect(created.branch).toBe("e2e-feature-branch")

          const list = yield* runClient(
            Effect.gen(function* () {
              const client = yield* makeHomesteadClient
              return yield* client.listWorktrees({ repoRoot: fixture.dir })
            }),
          )
          expect(list.length).toBeGreaterThanOrEqual(1)
          expect(list.some((w) => w.name === "e2e-feature-branch")).toBe(true)

          const removed = yield* runClient(
            Effect.gen(function* () {
              const client = yield* makeHomesteadClient
              return yield* client.removeWorktree({
                requestId: "e2e-req-rm-1",
                repoRoot: fixture.dir,
                name: "e2e-feature-branch",
              })
            }),
          )
          expect(removed.removed).toBe(true)
          expect(removed.name).toBe("e2e-feature-branch")

          const listAfter = yield* runClient(
            Effect.gen(function* () {
              const client = yield* makeHomesteadClient
              return yield* client.listWorktrees({ repoRoot: fixture.dir })
            }),
          )
          expect(listAfter.some((w) => w.name === "e2e-feature-branch")).toBe(false)

          const workspace = yield* runClient(
            Effect.gen(function* () {
              const client = yield* makeHomesteadClient
              return yield* client.createWorkspace({
                requestId: "e2e-workspace-create",
                projectRoot: fixture.dir,
                name: "e2e-workspace",
                from: "main",
              })
            }),
          )
          expect(workspace.provider).toBe("worktree")
          expect(workspace.state).toBe("ready")

          const inspected = yield* runClient(
            Effect.gen(function* () {
              const client = yield* makeHomesteadClient
              return yield* client.getWorkspace({
                projectRoot: fixture.dir,
                name: workspace.name,
              })
            }),
          )
          expect(inspected.id).toBe(workspace.id)

          yield* runClient(
            Effect.gen(function* () {
              const client = yield* makeHomesteadClient
              yield* client.reconcileWorkspaces({ projectRoot: fixture.dir })
              return yield* client.removeWorkspace({
                requestId: "e2e-workspace-remove",
                projectRoot: fixture.dir,
                name: workspace.name,
              })
            }),
          )

          yield* runClient(
            Effect.gen(function* () {
              const client = yield* makeHomesteadClient
              yield* client.shutdown.pipe(Effect.ignoreCause)
            }),
          )

          yield* Fiber.await(serverFiber)
        }),
      )

      await Effect.runPromise(testProgram.pipe(Effect.provide(ServerEnv)))

      expect(fs.existsSync(tempSock.path)).toBe(false)
      expect(fs.existsSync(`${tempSock.path}.lock`)).toBe(false)
    } finally {
      tempSock.cleanup()
      fixture.cleanup()
    }
  })
})
