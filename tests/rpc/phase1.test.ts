import { describe, expect, it } from "bun:test"
import { BunFileSystem, BunPath, BunSocket } from "@effect/platform-bun"
import { RpcClient, RpcSerialization } from "effect/unstable/rpc"
import { Deferred, Effect, Fiber, Layer, Scope, Stream } from "effect"
import * as path from "node:path"
import { makeServer } from "../../src/rpc/server.ts"
import { makeHomesteadClient } from "../../src/rpc/shared.ts"
import { createTempGitRepo, createTempSocket } from "../helpers.ts"

const ServerEnv = Layer.merge(BunFileSystem.layer, BunPath.layer)

describe("Phase 1 public Workspace protocol", () => {
  it("edits files, replays detached output after disconnect, and cancels a second run", async () => {
    const tempSock = createTempSocket()
    const fixture = createTempGitRepo()

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const ready = yield* Deferred.make<void>()
            const serverFiber = yield* Effect.forkScoped(
              makeServer(tempSock.path, {
                onReady: ready,
                registryFilePath: fixture.registryFile,
                commandFilePath: path.join(fixture.root, "state", "commands.json"),
              }),
            )
            yield* Deferred.await(ready)

            const ClientEnv = RpcClient.layerProtocolSocket().pipe(
              Layer.provide(BunSocket.layerNet({ path: tempSock.path })),
              Layer.provide(RpcSerialization.layerNdjson),
            )
            const runClient = <A, E>(
              effect: Effect.Effect<A, E, RpcClient.Protocol | Scope.Scope>,
            ) => Effect.scoped(effect).pipe(Effect.provide(ClientEnv))

            const workspace = yield* runClient(
              Effect.gen(function* () {
                const client = yield* makeHomesteadClient
                return yield* client.createWorkspace({
                  requestId: "phase1-create",
                  projectRoot: fixture.dir,
                  name: "phase1-workspace",
                  from: "main",
                })
              }),
            )

            yield* runClient(
              Effect.gen(function* () {
                const client = yield* makeHomesteadClient
                yield* client
                  .writeWorkspaceFile({
                    workspaceId: workspace.id,
                    path: "notes/phase1.txt",
                    content: "phase 1",
                  })
                  .pipe(Effect.flip)
                yield* client.makeWorkspaceDirectory({
                  workspaceId: workspace.id,
                  path: "notes",
                })
                yield* client.writeWorkspaceFile({
                  workspaceId: workspace.id,
                  path: "notes/phase1.txt",
                  content: "phase 1",
                })
                const file = yield* client.readWorkspaceFile({
                  workspaceId: workspace.id,
                  path: "notes/phase1.txt",
                })
                expect(file.content).toBe("phase 1")
                const entries = yield* client.listWorkspaceDirectory({
                  workspaceId: workspace.id,
                  path: "notes",
                })
                expect(entries.map((entry) => entry.path)).toEqual(["notes/phase1.txt"])
              }),
            )

            const run = yield* runClient(
              Effect.gen(function* () {
                const client = yield* makeHomesteadClient
                return yield* client.startCommand({
                  workspaceId: workspace.id,
                  command: process.execPath,
                  args: [
                    "-e",
                    "process.stdout.write('first'); setTimeout(() => process.stdout.write(' second'), 30)",
                  ],
                })
              }),
            )

            // The first client scope is gone here. The daemon owns the process.
            yield* Effect.sleep("100 millis")

            const events = yield* runClient(
              Effect.gen(function* () {
                const client = yield* makeHomesteadClient
                return yield* Stream.runCollect(
                  client.streamCommandEvents({
                    workspaceId: workspace.id,
                    runId: run.id,
                    since: 0,
                  }),
                )
              }),
            )
            const output = Array.from(events)
              .filter((event) => event.type === "stdout")
              .map((event) => event.data ?? "")
              .join("")
            expect(output).toBe("first second")
            expect(Array.from(events).map((event) => event.sequence)).toEqual(
              Array.from(events)
                .map((event) => event.sequence)
                .toSorted((a, b) => a - b),
            )

            const completed = yield* runClient(
              Effect.gen(function* () {
                const client = yield* makeHomesteadClient
                return yield* client.getCommandRun({
                  workspaceId: workspace.id,
                  runId: run.id,
                })
              }),
            )
            expect(completed.state).toBe("exited")
            expect(completed.exitCode).toBe(0)

            const cancelledRun = yield* runClient(
              Effect.gen(function* () {
                const client = yield* makeHomesteadClient
                return yield* client.startCommand({
                  workspaceId: workspace.id,
                  command: process.execPath,
                  args: ["-e", "setTimeout(() => {}, 10000)"],
                })
              }),
            )
            yield* runClient(
              Effect.gen(function* () {
                const client = yield* makeHomesteadClient
                yield* client.cancelCommand({
                  workspaceId: workspace.id,
                  runId: cancelledRun.id,
                })
              }),
            )
            yield* Effect.sleep("50 millis")
            const cancelled = yield* runClient(
              Effect.gen(function* () {
                const client = yield* makeHomesteadClient
                return yield* client.getCommandRun({
                  workspaceId: workspace.id,
                  runId: cancelledRun.id,
                })
              }),
            )
            expect(cancelled.state).toBe("cancelled")

            yield* runClient(
              Effect.gen(function* () {
                const client = yield* makeHomesteadClient
                yield* client.removeWorkspace({
                  requestId: "phase1-remove",
                  projectRoot: fixture.dir,
                  name: workspace.name,
                })
                yield* client.shutdown.pipe(Effect.ignoreCause)
              }),
            )
            yield* Fiber.await(serverFiber)
          }),
        ).pipe(Effect.provide(ServerEnv)),
      )
    } finally {
      tempSock.cleanup()
      fixture.cleanup()
    }
  })
})
