import { describe, expect, it } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer, Option } from "effect"
import { execFileSync } from "node:child_process"
import * as path from "node:path"
import { GitLive } from "../../src/git/service.ts"
import { WorkspaceInfo } from "../../src/types.ts"
import { WorkspaceProvider } from "../../src/workspace/provider.ts"
import { layerWithoutDependencies as worktreeProviderLayer } from "../../src/workspace/providers/worktree.ts"
import { createTempGitRepo } from "../helpers.ts"

const GitServiceLive = GitLive.pipe(Layer.provide(BunServices.layer))
const ProviderLive = worktreeProviderLayer.pipe(
  Layer.provide(GitServiceLive),
  Layer.provide(BunServices.layer),
)

describe("WorkspaceProvider conformance: worktree", () => {
  it("prepares, creates, finds, discovers, and destroys a Workspace", async () => {
    const fixture = createTempGitRepo()
    try {
      const workspacePath = path.join(fixture.workspacesDir, "provider_conformance")
      await Effect.runPromise(
        Effect.gen(function* () {
          const provider = yield* WorkspaceProvider
          expect(provider.provider).toBe("worktree")
          expect(provider.capabilities.filesystemIsolation).toBe("rooted")
          expect(provider.capabilities.networkIsolation).toBe("host")

          const prepared = yield* provider.prepare({
            id: "provider-conformance-id",
            projectRoot: fixture.dir,
            name: "provider-conformance",
            from: "main",
            targetPath: workspacePath,
          })
          const created = yield* provider.create(prepared)
          expect(created.baseRevision).toBe(
            execFileSync("git", ["rev-parse", "main"], { cwd: fixture.dir }).toString().trim(),
          )

          const info = WorkspaceInfo.make({
            id: created.id,
            projectRoot: created.projectRoot,
            name: created.name,
            branch: created.branch,
            baseRevision: created.baseRevision,
            provider: provider.provider,
            providerCapabilities: provider.capabilities,
            providerMetadata: created.metadata,
            rootPath: created.rootPath,
            ports: {},
            state: "ready",
            createdAt: 1,
            updatedAt: 1,
          })
          const found = yield* provider.find(info)
          expect(Option.isSome(found)).toBe(true)
          const discovered = yield* provider.discover(fixture.dir)
          expect(discovered.some((entry) => entry.branch === "provider-conformance")).toBe(true)

          yield* provider.destroy(created)
          expect(Option.isNone(yield* provider.find(info))).toBe(true)
        }).pipe(Effect.provide(ProviderLive)),
      )

      const branches = execFileSync("git", ["branch", "--list", "provider-conformance"], {
        cwd: fixture.dir,
      })
        .toString()
        .trim()
      expect(branches).toBe("")
    } finally {
      fixture.cleanup()
    }
  })
})
