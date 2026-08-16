import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import * as crypto from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { createTempGitRepo } from "../helpers.ts"
import { WorktreeManager, makeWorktreeManagerLayer } from "../../src/worktree/manager.ts"

const runTest = async <A, E>(effect: Effect.Effect<A, E, WorktreeManager>): Promise<A> => {
  const state = mkdtempSync(path.join(os.tmpdir(), "homestead-manager-state-"))
  try {
    return await Effect.runPromise(
      effect.pipe(
        Effect.provide(
          makeWorktreeManagerLayer({
            registry: { filePath: path.join(state, "workspaces.json") },
          }),
        ),
      ),
    )
  } finally {
    rmSync(state, { recursive: true, force: true })
  }
}

const runTestExit = async <A, E>(effect: Effect.Effect<A, E, WorktreeManager>) => {
  const state = mkdtempSync(path.join(os.tmpdir(), "homestead-manager-state-"))
  try {
    return await Effect.runPromiseExit(
      effect.pipe(
        Effect.provide(
          makeWorktreeManagerLayer({
            registry: { filePath: path.join(state, "workspaces.json") },
          }),
        ),
      ),
    )
  } finally {
    rmSync(state, { recursive: true, force: true })
  }
}

describe("WorktreeManager - Repository and Input Validation", () => {
  it("validates existing isolated git repository fixture", async () => {
    const repoFixture = createTempGitRepo()
    try {
      const canonical = await runTest(
        Effect.gen(function* () {
          const manager = yield* WorktreeManager
          return yield* manager.validateRepoRoot(repoFixture.dir)
        }),
      )
      expect(canonical).toBe(repoFixture.dir)
    } finally {
      repoFixture.cleanup()
    }
  })

  it("keeps legacy listWorktrees discovery semantics for the primary checkout", async () => {
    const repoFixture = createTempGitRepo()
    try {
      const worktrees = await runTest(
        Effect.gen(function* () {
          const manager = yield* WorktreeManager
          return yield* manager.listWorktrees({ repoRoot: repoFixture.dir })
        }),
      )
      expect(worktrees.some((worktree) => worktree.branch === "main")).toBe(true)
    } finally {
      repoFixture.cleanup()
    }
  })

  it("fails with RepositoryNotFound for non-existent path", async () => {
    const exit = await runTestExit(
      Effect.gen(function* () {
        const manager = yield* WorktreeManager
        return yield* manager.validateRepoRoot("/tmp/non-existent-homestead-path-12345")
      }),
    )
    expect(exit._tag).toBe("Failure")
  })

  it("fails with InvalidInput for bad worktree names", async () => {
    const repoFixture = createTempGitRepo()
    try {
      const exit = await runTestExit(
        Effect.gen(function* () {
          const manager = yield* WorktreeManager
          return yield* manager.createWorktree({
            requestId: crypto.randomUUID(),
            repoRoot: repoFixture.dir,
            name: "../escape",
          })
        }),
      )
      expect(exit._tag).toBe("Failure")
    } finally {
      repoFixture.cleanup()
    }
  })

  it("replays original result when same requestId and same request payload is sent", async () => {
    const repoFixture = createTempGitRepo()
    try {
      const reqId = crypto.randomUUID()

      const [res1, res2] = await runTest(
        Effect.gen(function* () {
          const manager = yield* WorktreeManager
          const r1 = yield* manager.createWorktree({
            requestId: reqId,
            repoRoot: repoFixture.dir,
            name: "test-feature",
          })
          const r2 = yield* manager.createWorktree({
            requestId: reqId,
            repoRoot: repoFixture.dir,
            name: "test-feature",
          })
          return [r1, r2] as const
        }),
      )

      expect(res1.name).toBe("test-feature")
      expect(res2.name).toBe("test-feature")
    } finally {
      repoFixture.cleanup()
    }
  })

  it("fails with RequestIdConflict when same requestId is used with different payload", async () => {
    const repoFixture = createTempGitRepo()
    try {
      const reqId = crypto.randomUUID()

      const exit = await runTestExit(
        Effect.gen(function* () {
          const manager = yield* WorktreeManager
          yield* manager.createWorktree({
            requestId: reqId,
            repoRoot: repoFixture.dir,
            name: "test-feature-a",
          })
          return yield* manager.createWorktree({
            requestId: reqId,
            repoRoot: repoFixture.dir,
            name: "test-feature-b",
          })
        }),
      )

      expect(exit._tag).toBe("Failure")
    } finally {
      repoFixture.cleanup()
    }
  })

  it("refuses removal of existing primary worktree 'main' without force", async () => {
    const repoFixture = createTempGitRepo()
    try {
      const exit = await runTestExit(
        Effect.gen(function* () {
          const manager = yield* WorktreeManager
          return yield* manager.removeWorktree({
            requestId: crypto.randomUUID(),
            repoRoot: repoFixture.dir,
            name: "main",
          })
        }),
      )
      expect(exit._tag).toBe("Failure")
    } finally {
      repoFixture.cleanup()
    }
  })
})
