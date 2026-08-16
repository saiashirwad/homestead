import {
  Context,
  Effect,
  FileSystem,
  Layer,
  Path,
  Ref,
} from "effect";
import { BunServices } from "@effect/platform-bun";
import { loadConfigOrUndefined } from "../config.ts";
import {
  InvalidInput,
  ProvisionFailure,
  RepositoryNotFound,
  RequestIdConflict,
  WorktreeAlreadyExists,
  WorktreeNotFound,
  WorktreeRemovalRefused,
} from "../errors.ts";
import { Git, GitLive } from "../git/service.ts";
import { slugify } from "../text.ts";
import { RemoveWorktreeResult, WorktreeInfo } from "../types.ts";
import { resolveDefaultBaseRef } from "./base-ref.ts";
import { resolveTargetDir } from "./plan.ts";
import { PortAllocator } from "./ports.ts";
import { provisionTarget } from "./index.ts";
import { runTeardown } from "./provision.ts";

interface IdempotencyRecord {
  readonly rpcTag: string;
  readonly fingerprint: string;
  readonly result: unknown;
  readonly timestamp: number;
}

interface WorktreeState {
  readonly worktrees: Map<string, WorktreeInfo>;
  readonly idempotency: Map<string, IdempotencyRecord>;
}

const DEFAULT_MAX_IDEMPOTENCY_ENTRIES = 1000;
const PROTECTED_BRANCHES = new Set(["main", "master"]);

export interface WorktreeManagerShape {
  readonly validateRepoRoot: (
    repoRoot: string,
  ) => Effect.Effect<string, RepositoryNotFound | InvalidInput>;
  readonly createWorktree: (payload: {
    readonly requestId: string;
    readonly repoRoot: string;
    readonly name: string;
    readonly from?: string | undefined;
  }) => Effect.Effect<
    WorktreeInfo,
    InvalidInput | RepositoryNotFound | WorktreeAlreadyExists | RequestIdConflict | ProvisionFailure
  >;
  readonly removeWorktree: (payload: {
    readonly requestId: string;
    readonly repoRoot: string;
    readonly name: string;
    readonly force?: boolean | undefined;
  }) => Effect.Effect<
    RemoveWorktreeResult,
    | InvalidInput
    | RepositoryNotFound
    | WorktreeNotFound
    | WorktreeRemovalRefused
    | RequestIdConflict
    | ProvisionFailure
  >;
  readonly listWorktrees: (payload?: {
    readonly repoRoot?: string | undefined;
  }) => Effect.Effect<ReadonlyArray<WorktreeInfo>, InvalidInput | RepositoryNotFound>;
}

export class WorktreeManager extends Context.Service<WorktreeManager, WorktreeManagerShape>()(
  "homestead/WorktreeManager",
) {}

const computeFingerprint = (payload: Record<string, unknown>): string => {
  const keys = Object.keys(payload)
    .filter((k) => k !== "requestId")
    .sort();
  const normalized: Record<string, unknown> = {};
  for (const k of keys) {
    normalized[k] = payload[k] === undefined ? null : payload[k];
  }
  return JSON.stringify(normalized);
};

export const make: Effect.Effect<
  WorktreeManagerShape,
  never,
  FileSystem.FileSystem | Path.Path | Git | PortAllocator
> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* Git;
  const portAllocator = yield* PortAllocator;
  const maxEntries = DEFAULT_MAX_IDEMPOTENCY_ENTRIES;

  const stateRef = yield* Ref.make<WorktreeState>({
    worktrees: new Map(),
    idempotency: new Map(),
  });

  const validateWorktreeName = (name: string): Effect.Effect<string, InvalidInput> => {
    if (!name || typeof name !== "string") {
      return Effect.fail(
        new InvalidInput({
          message: "Worktree name must be a non-empty string",
          field: "name",
        }),
      );
    }
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      return Effect.fail(
        new InvalidInput({
          message: "Worktree name cannot be whitespace-only",
          field: "name",
        }),
      );
    }
    if (
      trimmed.includes("/") ||
      trimmed.includes("\\") ||
      trimmed.includes("..") ||
      trimmed.startsWith(".") ||
      trimmed.startsWith("-") ||
      /[\x00-\x1f\x7f]/.test(trimmed)
    ) {
      return Effect.fail(
        new InvalidInput({
          message: `Invalid worktree name "${trimmed}". Must not contain slashes, path traversal, control characters, or begin with . or -`,
          field: "name",
        }),
      );
    }
    return Effect.succeed(trimmed);
  };

  const validateRepoRoot = (
    repoRoot: string,
  ): Effect.Effect<string, RepositoryNotFound | InvalidInput> =>
    Effect.gen(function* () {
      if (!repoRoot || typeof repoRoot !== "string") {
        return yield* Effect.fail(
          new InvalidInput({
            message: "Repository root path must be a non-empty string",
            field: "repoRoot",
          }),
        );
      }
      const canonical = path.resolve(repoRoot);
      const exists = yield* fs.exists(canonical).pipe(Effect.orDie);
      if (!exists) {
        return yield* Effect.fail(
          new RepositoryNotFound({
            repoRoot: canonical,
            message: `Directory does not exist: ${canonical}`,
          }),
        );
      }
      const gitDir = path.join(canonical, ".git");
      const hasGit = yield* fs.exists(gitDir).pipe(Effect.orDie);
      if (!hasGit) {
        return yield* Effect.fail(
          new RepositoryNotFound({
            repoRoot: canonical,
            message: `Directory is not a git repository (missing .git): ${canonical}`,
          }),
        );
      }
      return canonical;
    });

  const checkOrRecordIdempotency = <T, E>(
    requestId: string,
    rpcTag: string,
    payload: Record<string, unknown>,
    computation: Effect.Effect<T, E>,
  ): Effect.Effect<T, E | RequestIdConflict> =>
    Effect.gen(function* () {
      const fingerprint = computeFingerprint(payload);

      const state = yield* Ref.get(stateRef);
      const existing = state.idempotency.get(requestId);
      if (existing !== undefined) {
        if (existing.rpcTag !== rpcTag || existing.fingerprint !== fingerprint) {
          return yield* Effect.fail(
            new RequestIdConflict({
              requestId,
              message: `Request ID "${requestId}" has already been used with different parameters or RPC.`,
            }),
          );
        }
        return existing.result as T;
      }

      const result = yield* computation;

      yield* Ref.update(stateRef, (s) => {
        const newIdempotency = new Map(s.idempotency);
        if (newIdempotency.size >= maxEntries) {
          const oldestKey = newIdempotency.keys().next().value;
          if (oldestKey !== undefined) {
            newIdempotency.delete(oldestKey);
          }
        }
        newIdempotency.set(requestId, {
          rpcTag,
          fingerprint,
          result,
          timestamp: Date.now(),
        });
        return { ...s, idempotency: newIdempotency };
      });

      return result;
    });

  const createWorktree: WorktreeManagerShape["createWorktree"] = (payload) =>
    checkOrRecordIdempotency(
      payload.requestId,
      "v1/worktree/create",
      payload as unknown as Record<string, unknown>,
      Effect.gen(function* () {
        const canonicalRepo = yield* validateRepoRoot(payload.repoRoot);
        const name = yield* validateWorktreeName(payload.name);
        const repoName = path.basename(canonicalRepo);
        const slug = slugify(name);

        const existingWorktrees = yield* git.worktree.list(canonicalRepo).pipe(
          Effect.orElseSucceed(() => []),
        );
        const alreadyExistsInGit = existingWorktrees.some(
          (wt) => wt.branch === name || path.basename(wt.path) === slug,
        );

        if (alreadyExistsInGit) {
          return yield* Effect.fail(
            new WorktreeAlreadyExists({
              name,
              repoRoot: canonicalRepo,
              message: `Worktree or branch "${name}" already exists in repository "${canonicalRepo}"`,
            }),
          );
        }

        const config = (yield* loadConfigOrUndefined(canonicalRepo).pipe(
          Effect.catch((err) =>
            Effect.fail(
              new ProvisionFailure({
                message: `Failed to load config: ${String(err)}`,
              }),
            ),
          ),
        )) ?? {
          ports: [],
          services: [],
          setup: [],
          teardown: [],
        };

        const targetDir = resolveTargetDir({
          dirFlag: undefined,
          config,
          repoName,
          slug,
          branch: name,
          path,
        });

        const existsOnDisk = yield* fs.exists(targetDir).pipe(Effect.orDie);
        if (existsOnDisk) {
          return yield* Effect.fail(
            new WorktreeAlreadyExists({
              name,
              repoRoot: canonicalRepo,
              message: `Target worktree directory already exists: ${targetDir}`,
            }),
          );
        }

        const hasBranchRef = yield* git.refExists(canonicalRepo, `refs/heads/${name}`).pipe(
          Effect.orElseSucceed(() => false),
        );

        const baseRef =
          payload.from ??
          (hasBranchRef ? undefined : yield* resolveDefaultBaseRef(canonicalRepo).pipe(
            Effect.catch((err) =>
              Effect.fail(
                new ProvisionFailure({
                  message: `Failed to resolve base ref: ${String(err)}`,
                }),
              ),
            ),
          ));

        yield* fs.makeDirectory(path.dirname(targetDir), { recursive: true }).pipe(
          Effect.catch((err) =>
            Effect.fail(
              new ProvisionFailure({
                message: `Failed to create parent directory for worktree: ${String(err)}`,
              }),
            ),
          ),
        );

        if (hasBranchRef) {
          yield* git.worktree.add(canonicalRepo, { dir: targetDir, branch: name }).pipe(
            Effect.catch((err) =>
              Effect.fail(
                new ProvisionFailure({
                  message: `git worktree add failed: ${String(err)}`,
                }),
              ),
            ),
          );
        } else {
          const startRef = baseRef ?? (yield* resolveDefaultBaseRef(canonicalRepo).pipe(
            Effect.catch((err) =>
              Effect.fail(
                new ProvisionFailure({
                  message: `Failed to resolve base ref: ${String(err)}`,
                }),
              ),
            ),
          ));
          yield* git.worktree.addNew(canonicalRepo, { dir: targetDir, branch: name, baseRef: startRef }).pipe(
            Effect.catch((err) =>
              Effect.fail(
                new ProvisionFailure({
                  message: `git worktree add -b failed: ${String(err)}`,
                }),
              ),
            ),
          );
        }

        const target = { targetDir, branch: name, slug };
        const repo = { startCwd: canonicalRepo, primaryRoot: canonicalRepo, repoName };

        const plan = yield* provisionTarget(config, repo, target, { noSetup: false }).pipe(
          Effect.catch((err) =>
            Effect.fail(
              new ProvisionFailure({
                message: `Worktree provisioning failed: ${String(err)}`,
              }),
            ),
          ),
        );

        const portsRecord: Record<string, number> = {};
        for (const [k, v] of plan.envEdits) {
          const num = Number(v);
          if (Number.isInteger(num)) {
            portsRecord[k] = num;
          }
        }

        const info = new WorktreeInfo({
          repoRoot: canonicalRepo,
          name,
          branch: name,
          path: targetDir,
          ports: portsRecord,
          createdAt: Date.now(),
        });

        yield* Ref.update(stateRef, (state) => {
          const newMap = new Map(state.worktrees);
          newMap.set(`${canonicalRepo}::${name}`, info);
          return { ...state, worktrees: newMap };
        });

        return info;
      }).pipe(
        Effect.provideService(PortAllocator, portAllocator),
        Effect.provideService(Git, git),
        Effect.provide(BunServices.layer),
      ),
    );

  const removeWorktree: WorktreeManagerShape["removeWorktree"] = (payload) =>
    checkOrRecordIdempotency(
      payload.requestId,
      "v1/worktree/remove",
      payload as unknown as Record<string, unknown>,
      Effect.gen(function* () {
        const canonicalRepo = yield* validateRepoRoot(payload.repoRoot);
        const name = yield* validateWorktreeName(payload.name);
        const repoName = path.basename(canonicalRepo);
        const slug = slugify(name);

        const worktreeList = yield* git.worktree.list(canonicalRepo).pipe(
          Effect.orElseSucceed(() => []),
        );
        const entry = worktreeList.find(
          (wt) => wt.branch === name || path.basename(wt.path) === slug,
        );

        if (entry === undefined) {
          return yield* Effect.fail(
            new WorktreeNotFound({
              name,
              repoRoot: canonicalRepo,
              message: `Worktree "${name}" not found in repository "${canonicalRepo}"`,
            }),
          );
        }

        if (PROTECTED_BRANCHES.has(name) && payload.force !== true) {
          return yield* Effect.fail(
            new WorktreeRemovalRefused({
              name,
              repoRoot: canonicalRepo,
              reason: "protected_branch",
              message: `Refusing to remove primary branch worktree "${name}" without force flag.`,
            }),
          );
        }

        const config = (yield* loadConfigOrUndefined(canonicalRepo).pipe(
          Effect.catch((err) =>
            Effect.fail(
              new ProvisionFailure({
                message: `Failed to load config: ${String(err)}`,
              }),
            ),
          ),
        )) ?? {
          ports: [],
          services: [],
          setup: [],
          teardown: [],
        };
        const repo = { startCwd: canonicalRepo, primaryRoot: canonicalRepo, repoName };

        yield* runTeardown(repo, entry.path, slug, name, config).pipe(Effect.ignore);

        yield* git.worktree.remove(canonicalRepo, entry.path).pipe(
          Effect.catch((err) =>
            Effect.fail(
              new ProvisionFailure({
                message: `Failed to remove git worktree at ${entry.path}: ${String(err)}`,
              }),
            ),
          ),
        );

        yield* git.worktree.prune(canonicalRepo).pipe(Effect.ignore);

        if (!PROTECTED_BRANCHES.has(name)) {
          yield* git.branch.delete(canonicalRepo, name).pipe(Effect.ignore);
        }

        yield* Ref.update(stateRef, (state) => {
          const newMap = new Map(state.worktrees);
          newMap.delete(`${canonicalRepo}::${name}`);
          return { ...state, worktrees: newMap };
        });

        return new RemoveWorktreeResult({
          removed: true,
          repoRoot: canonicalRepo,
          name,
        });
      }).pipe(
        Effect.provideService(Git, git),
        Effect.provide(BunServices.layer),
      ),
    );

  const listWorktrees: WorktreeManagerShape["listWorktrees"] = (payload) =>
    Effect.gen(function* () {
      if (payload?.repoRoot !== undefined) {
        const canonicalRepo = yield* validateRepoRoot(payload.repoRoot);
        const entries = yield* git.worktree.list(canonicalRepo).pipe(
          Effect.orElseSucceed(() => []),
        );
        const list: Array<WorktreeInfo> = [];
        for (const entry of entries) {
          const envPath = path.join(entry.path, ".env");
          const envExists = yield* fs.exists(envPath).pipe(Effect.orDie);
          const ports: Record<string, number> = {};
          if (envExists) {
            const content = yield* fs.readFileString(envPath).pipe(Effect.orDie);
            for (const line of content.split("\n")) {
              const eq = line.indexOf("=");
              if (eq > 0 && !line.startsWith("#")) {
                const k = line.slice(0, eq).trim();
                const v = Number(line.slice(eq + 1).trim());
                if (Number.isInteger(v) && k.includes("PORT")) {
                  ports[k] = v;
                }
              }
            }
          }
          list.push(
            new WorktreeInfo({
              repoRoot: canonicalRepo,
              name: entry.branch ?? path.basename(entry.path),
              branch: entry.branch ?? "HEAD",
              path: entry.path,
              ports,
              createdAt: Date.now(),
            }),
          );
        }
        return list;
      }

      const state = yield* Ref.get(stateRef);
      return Array.from(state.worktrees.values());
    });

  return {
    validateRepoRoot,
    createWorktree,
    removeWorktree,
    listWorktrees,
  };
});

export const layerWithoutDependencies = Layer.effect(WorktreeManager, make);

export const WorktreeManagerLive = layerWithoutDependencies.pipe(
  Layer.provideMerge(GitLive),
  Layer.provideMerge(PortAllocator.layer),
  Layer.provideMerge(BunServices.layer),
);
