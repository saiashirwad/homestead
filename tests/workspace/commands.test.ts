import { describe, expect, it } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  layerWithoutDependencies as commandRuntimeLayer,
  CommandRuntime,
} from "../../src/workspace/commands.ts"

describe("CommandRuntime", () => {
  it("keeps bounded event history and replays it by sequence", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "homestead-command-runtime-"))
    const filePath = path.join(root, "commands.json")
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const runtime = yield* CommandRuntime
            const run = yield* runtime.start({
              workspaceId: "workspace-1",
              rootPath: root,
              command: process.execPath,
              args: [
                "-e",
                "process.stdout.write('one'); setTimeout(() => process.stdout.write('two'), 20)",
              ],
              cwd: ".",
              cwdPath: root,
            })
            yield* Effect.sleep("100 millis")
            const events = yield* Stream.runCollect(
              Stream.unwrap(
                runtime
                  .events({
                    workspaceId: "workspace-1",
                    runId: run.id,
                  })
                  .pipe(Effect.map(Stream.fromQueue)),
              ),
            )
            expect(
              Array.from(events)
                .filter((event) => event.type === "stdout")
                .map((event) => event.data ?? "")
                .join(""),
            ).toBe("onetwo")
            const lastSequence = Array.from(events).at(-1)?.sequence ?? 0
            const replay = yield* Stream.runCollect(
              Stream.unwrap(
                runtime
                  .events({
                    workspaceId: "workspace-1",
                    runId: run.id,
                    since: lastSequence - 1,
                  })
                  .pipe(Effect.map(Stream.fromQueue)),
              ),
            )
            expect(Array.from(replay).map((event) => event.sequence)).toEqual([lastSequence])
          }).pipe(Effect.provide(commandRuntimeLayer({ filePath, maxEvents: 16 }))),
        ),
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("marks a running Command Run interrupted when its daemon scope closes", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "homestead-command-reconcile-"))
    const filePath = path.join(root, "commands.json")
    let runId = ""
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const runtime = yield* CommandRuntime
            const run = yield* runtime.start({
              workspaceId: "workspace-2",
              rootPath: root,
              command: process.execPath,
              args: ["-e", "setTimeout(() => {}, 10000)"],
              cwd: ".",
              cwdPath: root,
            })
            runId = run.id
          }).pipe(Effect.provide(commandRuntimeLayer({ filePath }))),
        ),
      )

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const runtime = yield* CommandRuntime
            const run = yield* runtime.get("workspace-2", runId)
            expect(run.state).toBe("interrupted")
          }).pipe(Effect.provide(commandRuntimeLayer({ filePath }))),
        ),
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
