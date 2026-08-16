import { Clock, Context, Effect, FileSystem, Layer, Path, Ref, Schema } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import { BunServices } from "@effect/platform-bun"
import { loadConfigOrUndefined } from "../config.ts"
import {
  InvalidInput,
  ProvisionFailure,
  RepositoryNotFound,
  RequestIdConflict,
  WorktreeAlreadyExists,
  WorktreeNotFound,
  WorktreeRemovalRefused,
} from "../errors.ts"
import { Git, GitLive } from "../git/service.ts"
import { slugify } from "../text.ts"
import { RemoveWorktreeResult, WorktreeInfo } from "../types.ts"
import { resolveDefaultBaseRef } from "./base-ref.ts"
import { resolveTargetDir } from "./plan.ts"
import { PortAllocator } from "./ports.ts"
import { provisionTarget } from "./index.ts"
import { runTeardown } from "./provision.ts"

type IdempotencyRecord =
  | {
      readonly rpcTag: "v1/worktree/create"
      readonly fingerprint: string
      readonly result: WorktreeInfo
      readonly timestamp: number
    }
  | {
      readonly rpcTag: "v1/worktree/remove"
      readonly fingerprint: string
      readonly result: RemoveWorktreeResult
      readonly timestamp: number
    }

interface WorktreeState {
  readonly worktrees: Map<string, WorktreeInfo>
  readonly idempotency: Map<string, IdempotencyRecord>
}

const DEFAULT_MAX_IDEMPOTENCY_ENTRIES = 1000
const PROTECTED_BRANCHES = new Set(["main", "master"])

type PayloadRecord = Readonly<Record<string, string | number | boolean | null | undefined>>

export interface WorktreeManagerApi {
  readonly validateRepoRoot: (
    repoRoot: string,
  ) => Effect.Effect<string, RepositoryNotFound | InvalidInput>
  readonly createWorktree: (payload: {
    readonly requestId: string
    readonly repoRoot: string
    readonly name: string
    readonly from?: string | undefined
  }) => Effect.Effect<
    WorktreeInfo,
    InvalidInput | RepositoryNotFound | WorktreeAlreadyExists | RequestIdConflict | ProvisionFailure
  >
  readonly removeWorktree: (payload: {
    readonly requestId: string
    readonly repoRoot: string
    readonly name: string
    readonly force?: boolean | undefined
  }) => Effect.Effect<
    RemoveWorktreeResult,
    | InvalidInput
    | RepositoryNotFound
    | WorktreeNotFound
    | WorktreeRemovalRefused
    | RequestIdConflict
    | ProvisionFailure
  >
  readonly listWorktrees: (payload?: {
    readonly repoRoot?: string | undefined
  }) => Effect.Effect<ReadonlyArray<WorktreeInfo>, InvalidInput | RepositoryNotFound>
}

export class WorktreeManager extends Context.Service<WorktreeManager, WorktreeManagerApi>()(
  "homestead/worktree/manager/WorktreeManager",
) {}

const computeFingerprint = (payload: PayloadRecord): string => {
  const keys = Object.keys(payload)
    .filter((k) => k !== "requestId")
    .toSorted()
  const normalized: Record<string, string | number | boolean | null> = {}
  for (const k of keys) {
    const val = payload[k]
    normalized[k] = val === undefined ? null : val
  }
  return JSON.stringify(normalized)
}

const hasControlChar = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if ((c >= 0 && c <= 31) || c === 127) return true
  }
  return false
}

const validateWorktreeName = (name: string): Effect.Effect<string, InvalidInput> => {
  if (!name || name.length === 0) {
    return InvalidInput.make({
      message: "Worktree name must be a non-empty string",
      field: "name",
    })
  }
  const trimmed = name.trim()
  if (trimmed.length === 0) {
    return InvalidInput.make({
      message: "Worktree name cannot be whitespace-only",
      field: "name",
    })
  }
  if (
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("..") ||
    trimmed.startsWith(".") ||
    trimmed.startsWith("-") ||
    hasControlChar(trimmed)
  ) {
    return InvalidInput.make({
      message: `Invalid worktree name "${trimmed}". Must not contain slashes, path traversal, control characters, or begin with . or -`,
      field: "name",
    })
  }
  return Effect.succeed(trimmed)
}

export const make: Effect.Effect<
  WorktreeManagerApi,
  never,
  FileSystem.FileSystem | Path.Path | Git | PortAllocator | ChildProcessSpawner.ChildProcessSpawner
> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const git = yield* Git
  const portAllocator = yield* PortAllocator
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const maxEntries = DEFAULT_MAX_IDEMPOTENCY_ENTRIES

  const stateRef = yield* Ref.make<WorktreeState>({
    worktrees: new Map(),
    idempotency: new Map(),
  })

  const validateRepoRoot = (
    repoRoot: string,
  ): Effect.Effect<string, RepositoryNotFound | InvalidInput> =>
    Effect.gen(function* () {
      if (!repoRoot || repoRoot.length === 0) {
        return yield* InvalidInput.make({
          message: "Repository root path must be a non-empty string",
          field: "repoRoot",
        })
      }
      const canonical = path.resolve(repoRoot)
      const exists = yield* fs.exists(canonical).pipe(Effect.orDie)
      if (!exists) {
        return yield* RepositoryNotFound.make({
          repoRoot: canonical,
          message: `Directory does not exist: ${canonical}`,
        })
      }
      const gitDir = path.join(canonical, ".git")
      const hasGit = yield* fs.exists(gitDir).pipe(Effect.orDie)
      if (!hasGit) {
        return yield* RepositoryNotFound.make({
          repoRoot: canonical,
          message: `Directory is not a git repository (missing .git): ${canonical}`,
        })
      }
      return canonical
    })

  function checkOrRecordIdempotency<E>(
    requestId: string,
    rpcTag: "v1/worktree/create",
    payload: PayloadRecord,
    computation: Effect.Effect<WorktreeInfo, E>,
  ): Effect.Effect<WorktreeInfo, E | RequestIdConflict>
  function checkOrRecordIdempotency<E>(
    requestId: string,
    rpcTag: "v1/worktree/remove",
    payload: PayloadRecord,
    computation: Effect.Effect<RemoveWorktreeResult, E>,
  ): Effect.Effect<RemoveWorktreeResult, E | RequestIdConflict>
  function checkOrRecordIdempotency<E>(
    requestId: string,
    rpcTag: "v1/worktree/create" | "v1/worktree/remove",
    payload: PayloadRecord,
    computation: Effect.Effect<WorktreeInfo | RemoveWorktreeResult, E>,
  ): Effect.Effect<WorktreeInfo | RemoveWorktreeResult, E | RequestIdConflict> {
    return Effect.gen(function* () {
      const fingerprint = computeFingerprint(payload)

      const state = yield* Ref.get(stateRef)
      const existing = state.idempotency.get(requestId)
      if (existing !== undefined) {
        if (existing.rpcTag !== rpcTag || existing.fingerprint !== fingerprint) {
          return yield* RequestIdConflict.make({
            requestId,
            message: `Request ID "${requestId}" has already been used with different parameters or RPC.`,
          })
        }
        return existing.result
      }

      const result = yield* computation
      const now = yield* Clock.currentTimeMillis

      yield* Ref.update(stateRef, (s) => {
        const newIdempotency = new Map(s.idempotency)
        if (newIdempotency.size >= maxEntries) {
          const oldestKey = newIdempotency.keys().next().value
          if (oldestKey !== undefined) {
            newIdempotency.delete(oldestKey)
          }
        }
        if (rpcTag === "v1/worktree/create" && Schema.is(WorktreeInfo)(result)) {
          newIdempotency.set(requestId, {
            rpcTag: "v1/worktree/create",
            fingerprint,
            result,
            timestamp: now,
          })
        } else if (rpcTag === "v1/worktree/remove" && Schema.is(RemoveWorktreeResult)(result)) {
          newIdempotency.set(requestId, {
            rpcTag: "v1/worktree/remove",
            fingerprint,
            result,
            timestamp: now,
          })
        }
        return { ...s, idempotency: newIdempotency }
      })

      return result
    })
  }

  const createWorktree: WorktreeManagerApi["createWorktree"] = (payload) =>
    checkOrRecordIdempotency(
      payload.requestId,
      "v1/worktree/create",
      payload,
      Effect.gen(function* () {
        const canonicalRepo = yield* validateRepoRoot(payload.repoRoot)
        const name = yield* validateWorktreeName(payload.name)
        const repoName = path.basename(canonicalRepo)
        const slug = slugify(name)

        const existingWorktrees = yield* git.worktree
          .list(canonicalRepo)
          .pipe(Effect.orElseSucceed(() => []))
        const alreadyExistsInGit = existingWorktrees.some(
          (wt) => wt.branch === name || path.basename(wt.path) === slug,
        )

        if (alreadyExistsInGit) {
          return yield* WorktreeAlreadyExists.make({
            name,
            repoRoot: canonicalRepo,
            message: `Worktree or branch "${name}" already exists in repository "${canonicalRepo}"`,
          })
        }

        const config = (yield* loadConfigOrUndefined(canonicalRepo).pipe(
          Effect.mapError((err) =>
            ProvisionFailure.make({
              message: `Failed to load config: ${String(err)}`,
            }),
          ),
        )) ?? {
          ports: [],
          services: [],
          setup: [],
          teardown: [],
        }

        const targetDir = resolveTargetDir({
          dirFlag: undefined,
          config,
          repoName,
          slug,
          branch: name,
          path,
        })

        const existsOnDisk = yield* fs.exists(targetDir).pipe(Effect.orDie)
        if (existsOnDisk) {
          return yield* WorktreeAlreadyExists.make({
            name,
            repoRoot: canonicalRepo,
            message: `Target worktree directory already exists: ${targetDir}`,
          })
        }

        const hasBranchRef = yield* git
          .refExists(canonicalRepo, `refs/heads/${name}`)
          .pipe(Effect.orElseSucceed(() => false))

        const baseRef =
          payload.from ??
          (hasBranchRef
            ? undefined
            : yield* resolveDefaultBaseRef(canonicalRepo).pipe(
                Effect.mapError((err) =>
                  ProvisionFailure.make({
                    message: `Failed to resolve base ref: ${String(err)}`,
                  }),
                ),
              ))

        yield* fs.makeDirectory(path.dirname(targetDir), { recursive: true }).pipe(
          Effect.mapError((err) =>
            ProvisionFailure.make({
              message: `Failed to create parent directory for worktree: ${String(err)}`,
            }),
          ),
        )

        if (hasBranchRef) {
          yield* git.worktree.add(canonicalRepo, { dir: targetDir, branch: name }).pipe(
            Effect.mapError((err) =>
              ProvisionFailure.make({
                message: `git worktree add failed: ${String(err)}`,
              }),
            ),
          )
        } else {
          const startRef =
            baseRef ??
            (yield* resolveDefaultBaseRef(canonicalRepo).pipe(
              Effect.mapError((err) =>
                ProvisionFailure.make({
                  message: `Failed to resolve base ref: ${String(err)}`,
                }),
              ),
            ))
          yield* git.worktree
            .addNew(canonicalRepo, { dir: targetDir, branch: name, baseRef: startRef })
            .pipe(
              Effect.mapError((err) =>
                ProvisionFailure.make({
                  message: `git worktree add -b failed: ${String(err)}`,
                }),
              ),
            )
        }

        const target = { targetDir, branch: name, slug }
        const repo = { startCwd: canonicalRepo, primaryRoot: canonicalRepo, repoName }

        const plan = yield* provisionTarget(config, repo, target, { noSetup: false }).pipe(
          Effect.mapError((err) =>
            ProvisionFailure.make({
              message: `Worktree provisioning failed: ${String(err)}`,
            }),
          ),
        )

        const portsRecord: Record<string, number> = {}
        for (const [k, v] of plan.envEdits) {
          const num = Number(v)
          if (Number.isInteger(num)) {
            portsRecord[k] = num
          }
        }

        const createdAt = yield* Clock.currentTimeMillis
        const info = WorktreeInfo.make({
          repoRoot: canonicalRepo,
          name,
          branch: name,
          path: targetDir,
          ports: portsRecord,
          createdAt,
        })

        yield* Ref.update(stateRef, (state) => {
          const newMap = new Map(state.worktrees)
          newMap.set(`${canonicalRepo}::${name}`, info)
          return { ...state, worktrees: newMap }
        })

        return info
      }).pipe(
        Effect.provideService(PortAllocator, portAllocator),
        Effect.provideService(Git, git),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      ),
    )

  const removeWorktree: WorktreeManagerApi["removeWorktree"] = (payload) =>
    checkOrRecordIdempotency(
      payload.requestId,
      "v1/worktree/remove",
      payload,
      Effect.gen(function* () {
        const canonicalRepo = yield* validateRepoRoot(payload.repoRoot)
        const name = yield* validateWorktreeName(payload.name)
        const repoName = path.basename(canonicalRepo)
        const slug = slugify(name)

        const worktreeList = yield* git.worktree
          .list(canonicalRepo)
          .pipe(Effect.orElseSucceed(() => []))
        const entry = worktreeList.find(
          (wt) => wt.branch === name || path.basename(wt.path) === slug,
        )

        if (entry === undefined) {
          return yield* WorktreeNotFound.make({
            name,
            repoRoot: canonicalRepo,
            message: `Worktree "${name}" not found in repository "${canonicalRepo}"`,
          })
        }

        if (PROTECTED_BRANCHES.has(name) && payload.force !== true) {
          return yield* WorktreeRemovalRefused.make({
            name,
            repoRoot: canonicalRepo,
            reason: "protected_branch",
            message: `Refusing to remove primary branch worktree "${name}" without force flag.`,
          })
        }

        const config = (yield* loadConfigOrUndefined(canonicalRepo).pipe(
          Effect.mapError((err) =>
            ProvisionFailure.make({
              message: `Failed to load config: ${String(err)}`,
            }),
          ),
        )) ?? {
          ports: [],
          services: [],
          setup: [],
          teardown: [],
        }
        const repo = { startCwd: canonicalRepo, primaryRoot: canonicalRepo, repoName }

        yield* runTeardown(repo, entry.path, slug, name, config).pipe(Effect.ignore)

        yield* git.worktree.remove(canonicalRepo, entry.path)

        yield* git.worktree.prune(canonicalRepo).pipe(Effect.ignore)

        if (!PROTECTED_BRANCHES.has(name)) {
          yield* git.branch.delete(canonicalRepo, name).pipe(Effect.ignore)
        }

        yield* Ref.update(stateRef, (state) => {
          const newMap = new Map(state.worktrees)
          newMap.delete(`${canonicalRepo}::${name}`)
          return { ...state, worktrees: newMap }
        })

        return RemoveWorktreeResult.make({
          removed: true,
          repoRoot: canonicalRepo,
          name,
        })
      }).pipe(
        Effect.provideService(Git, git),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      ),
    )

  const listWorktrees: WorktreeManagerApi["listWorktrees"] = (payload) =>
    Effect.gen(function* () {
      if (payload?.repoRoot !== undefined) {
        const canonicalRepo = yield* validateRepoRoot(payload.repoRoot)
        const entries = yield* git.worktree.list(canonicalRepo).pipe(Effect.orElseSucceed(() => []))
        const list: Array<WorktreeInfo> = []
        const now = yield* Clock.currentTimeMillis
        for (const entry of entries) {
          const envPath = path.join(entry.path, ".env")
          const envExists = yield* fs.exists(envPath).pipe(Effect.orDie)
          const ports: Record<string, number> = {}
          if (envExists) {
            const content = yield* fs.readFileString(envPath).pipe(Effect.orDie)
            for (const line of content.split("\n")) {
              const eq = line.indexOf("=")
              if (eq > 0 && !line.startsWith("#")) {
                const k = line.slice(0, eq).trim()
                const v = Number(line.slice(eq + 1).trim())
                if (Number.isInteger(v) && k.includes("PORT")) {
                  ports[k] = v
                }
              }
            }
          }
          list.push(
            WorktreeInfo.make({
              repoRoot: canonicalRepo,
              name: entry.branch ?? path.basename(entry.path),
              branch: entry.branch ?? "HEAD",
              path: entry.path,
              ports,
              createdAt: now,
            }),
          )
        }
        return list
      }

      const state = yield* Ref.get(stateRef)
      return Array.from(state.worktrees.values())
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    )

  return {
    validateRepoRoot,
    createWorktree,
    removeWorktree,
    listWorktrees,
  }
})

export const layerWithoutDependencies = Layer.effect(WorktreeManager, make)

export const WorktreeManagerLive = layerWithoutDependencies.pipe(
  Layer.provideMerge(GitLive),
  Layer.provideMerge(PortAllocator.layer),
  Layer.provideMerge(BunServices.layer),
)
