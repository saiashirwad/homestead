import { describe, expect, it, spyOn } from "bun:test"
import { Effect, Exit, Fiber, Schedule } from "effect"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { makeWorkspaceManagerLayer } from "../../src/workspace/live.ts"
import { WorkspaceManager } from "../../src/workspace/manager.ts"
import { createTempGitRepo } from "../helpers.ts"

const managerLayer = (registryFile: string) =>
  makeWorkspaceManagerLayer({ registry: { filePath: registryFile } })

describe("WorkspaceManager Phase 0 lifecycle", () => {
  it("rolls back the worktree, branch, registry record, and port reservation on setup failure", async () => {
    const fixture = createTempGitRepo()
    const name = "rollback-on-failure"
    const workspacePath = path.join(fixture.workspacesDir, "rollback_on_failure")
    const homeSpy = spyOn(os, "homedir").mockReturnValue(fixture.root)
    try {
      writeFileSync(
        path.join(fixture.dir, "homestead.config.ts"),
        `export default {
          worktreeDir: ({ slug }: { slug: string }) => ${JSON.stringify(fixture.workspacesDir)} + "/" + slug,
          ports: [{ key: "PORT", base: 43100 }],
          setup: [{ label: "induced failure", run: ["false"] }]
        }\n`,
      )

      const exit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const manager = yield* WorkspaceManager
          return yield* manager.createWorkspace({
            requestId: "rollback-request",
            projectRoot: fixture.dir,
            name,
            from: "main",
          })
        }).pipe(Effect.provide(managerLayer(fixture.registryFile))),
      )

      expect(Exit.isFailure(exit)).toBe(true)
      expect(existsSync(workspacePath)).toBe(false)
      expect(
        execFileSync("git", ["branch", "--list", name], { cwd: fixture.dir }).toString().trim(),
      ).toBe("")
      // SAFETY: The registry was written by WorkspaceRegistry using its versioned schema.
      const registry = JSON.parse(readFileSync(fixture.registryFile, "utf8")) as {
        readonly workspaces: ReadonlyArray<unknown>
      }
      expect(registry.workspaces).toEqual([])
      const reservations = path.join(
        fixture.root,
        ".homestead",
        "state",
        path.basename(fixture.dir),
        "reservations.json",
      )
      if (existsSync(reservations)) {
        // SAFETY: The reservation file was written by PortAllocator using its schema.
        const contents = JSON.parse(readFileSync(reservations, "utf8")) as {
          readonly reservations: ReadonlyArray<unknown>
        }
        expect(contents.reservations).toEqual([])
      }
    } finally {
      homeSpy.mockRestore()
      fixture.cleanup()
    }
  })

  it("closes the Workspace scope and rolls back when creation is cancelled", async () => {
    const fixture = createTempGitRepo()
    const name = "cancelled-create"
    const rootPath = path.join(fixture.workspacesDir, "cancelled_create")
    const startedPath = path.join(rootPath, "setup-started")
    try {
      writeFileSync(
        path.join(fixture.dir, "homestead.config.ts"),
        `export default {
          worktreeDir: ({ slug }: { slug: string }) => ${JSON.stringify(fixture.workspacesDir)} + "/" + slug,
          setup: [{ label: "wait for cancellation", run: ["sh", "-c", "touch setup-started && sleep 30"] }]
        }\n`,
      )

      await Effect.runPromise(
        Effect.gen(function* () {
          const manager = yield* WorkspaceManager
          const fiber = yield* manager
            .createWorkspace({
              requestId: "cancelled-request",
              projectRoot: fixture.dir,
              name,
              from: "main",
            })
            .pipe(Effect.forkChild)
          yield* Effect.sync(() => existsSync(startedPath)).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("20 millis"),
              until: (started) => started,
            }),
            Effect.timeout("5 seconds"),
          )
          yield* Fiber.interrupt(fiber)
        }).pipe(Effect.provide(managerLayer(fixture.registryFile))),
      )

      expect(existsSync(rootPath)).toBe(false)
      expect(
        execFileSync("git", ["branch", "--list", name], { cwd: fixture.dir }).toString().trim(),
      ).toBe("")
      // SAFETY: The registry was written by WorkspaceRegistry using its versioned schema.
      const registry = JSON.parse(readFileSync(fixture.registryFile, "utf8")) as {
        readonly workspaces: ReadonlyArray<unknown>
      }
      expect(registry.workspaces).toEqual([])
    } finally {
      fixture.cleanup()
    }
  })

  it("restores a completed Workspace after manager reconstruction and removes it cleanly", async () => {
    const fixture = createTempGitRepo()
    try {
      const created = await Effect.runPromise(
        Effect.gen(function* () {
          const manager = yield* WorkspaceManager
          return yield* manager.createWorkspace({
            requestId: "restart-create",
            projectRoot: fixture.dir,
            name: "restart-safe",
            from: "main",
          })
        }).pipe(Effect.provide(managerLayer(fixture.registryFile))),
      )
      expect(created.state).toBe("ready")
      expect(created.baseRevision).toBe(
        execFileSync("git", ["rev-parse", "main"], { cwd: fixture.dir }).toString().trim(),
      )

      await Effect.runPromise(
        Effect.gen(function* () {
          const manager = yield* WorkspaceManager
          const restored = yield* manager.getWorkspace({
            projectRoot: fixture.dir,
            name: created.name,
          })
          expect(restored.id).toBe(created.id)
          expect(restored.createdAt).toBe(created.createdAt)
          expect((yield* manager.listWorkspaces({ projectRoot: fixture.dir })).length).toBe(1)
          yield* manager.removeWorkspace({
            requestId: "restart-remove",
            projectRoot: fixture.dir,
            name: created.name,
          })
          expect(yield* manager.listWorkspaces({ projectRoot: fixture.dir })).toEqual([])
        }).pipe(Effect.provide(managerLayer(fixture.registryFile))),
      )

      expect(created.rootPath === undefined ? false : existsSync(created.rootPath)).toBe(false)
    } finally {
      fixture.cleanup()
    }
  })

  it("reconciles an interrupted provisioning record by removing its partial worktree", async () => {
    const fixture = createTempGitRepo()
    const name = "interrupted-create"
    const rootPath = path.join(fixture.workspacesDir, "interrupted_create")
    try {
      execFileSync("git", ["worktree", "add", "-b", name, rootPath, "main"], {
        cwd: fixture.dir,
        stdio: "ignore",
      })
      const baseRevision = execFileSync("git", ["rev-parse", "main"], {
        cwd: fixture.dir,
      })
        .toString()
        .trim()
      mkdirSync(path.dirname(fixture.registryFile), { recursive: true })
      writeFileSync(
        fixture.registryFile,
        `${JSON.stringify({
          version: 1,
          workspaces: [
            {
              id: "interrupted-workspace-id",
              projectRoot: fixture.dir,
              name,
              branch: name,
              baseRevision,
              provider: "worktree",
              providerCapabilities: {
                filesystemIsolation: "rooted",
                networkIsolation: "host",
                survivesHostDisconnect: false,
                supportsPortals: true,
              },
              providerMetadata: { path: rootPath },
              rootPath,
              ports: {},
              state: "provisioning",
              createdAt: 1,
              updatedAt: 1,
            },
          ],
        })}\n`,
      )

      const workspaces = await Effect.runPromise(
        Effect.gen(function* () {
          const manager = yield* WorkspaceManager
          return yield* manager.listWorkspaces({ projectRoot: fixture.dir })
        }).pipe(Effect.provide(managerLayer(fixture.registryFile))),
      )

      expect(workspaces).toEqual([])
      expect(existsSync(rootPath)).toBe(false)
      expect(
        execFileSync("git", ["branch", "--list", name], { cwd: fixture.dir }).toString().trim(),
      ).toBe("")
    } finally {
      fixture.cleanup()
    }
  })
})
