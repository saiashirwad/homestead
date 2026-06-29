import { Console, Effect, FileSystem, Path } from "effect";
import * as os from "node:os";
import { emit } from "../events.ts";
import { parseWorktreePorcelain } from "../git/porcelain.ts";
import { nextFreePort, readEnvVar, slugify } from "../text.ts";
import { capture, probeTcp, run } from "../process.ts";
import {
  DEFAULT_ENV_FALLBACK,
  DEFAULT_ENV_SOURCE,
} from "../defaults.ts";
import { makeContext } from "../context.ts";
import {
  type HomesteadConfig,
  type HomesteadContext,
  type Plan,
  type PortSpec,
  type WorktreeContext,
  type WorktreeOptions,
} from "../types.ts";
import { refExists, resolveDefaultBaseRef } from "./base-ref.ts";
import {
  liveReservations,
  readReservations,
  reservationsToClaim,
  withRegistryLock,
  writeReservations,
} from "./ports.ts";
import type { Repo } from "./repo.ts";

export interface Target {
  readonly targetDir: string;
  readonly branch: string;
  readonly slug: string;
}

export const makeWorktreeContext = (
  repo: Repo,
  target: Target,
  sourceContent: string,
): WorktreeContext => ({
  ...makeContext({
    repoName: repo.repoName,
    slug: target.slug,
    branch: target.branch,
    worktreeDir: target.targetDir,
    env: (key) => readEnvVar(sourceContent, key),
  }),
  targetDir: target.targetDir,
  primaryRoot: repo.primaryRoot,
});

export const resolveTargetDir = (input: {
  readonly dirFlag: string | undefined;
  readonly config: HomesteadConfig;
  readonly repoName: string;
  readonly slug: string;
  readonly branch: string;
  readonly path: Path.Path;
}): string => {
  const { dirFlag, config, repoName, slug, branch, path } = input;
  if (dirFlag !== undefined) return path.resolve(dirFlag);
  if (config.worktreeDir !== undefined) {
    return path.resolve(
      config.worktreeDir(makeContext({ repoName, slug, branch, worktreeDir: "" })),
    );
  }
  return path.join(os.homedir(), "worktrees", repoName, slug);
};

export const collectUsedPorts = (
  envContents: ReadonlyArray<string>,
  ports: ReadonlyArray<PortSpec>,
  reserved: ReadonlyArray<{ readonly key: string; readonly port: number }> = [],
): Map<string, Set<number>> => {
  const used = new Map<string, Set<number>>(ports.map((spec) => [spec.key, new Set<number>()]));
  for (const content of envContents) {
    for (const spec of ports) {
      const value = Number(readEnvVar(content, spec.key));
      if (Number.isInteger(value)) used.get(spec.key)?.add(value);
    }
  }
  // In-flight cross-process claims (live reservations) count as used too, so a
  // port picked-but-not-yet-written by another homestead run isn't handed out twice.
  for (const { key, port } of reserved) {
    if (Number.isInteger(port)) used.get(key)?.add(port);
  }
  return used;
};

export const resolvePortBase = (
  base: number | ((ctx: HomesteadContext) => number),
  ctx: HomesteadContext,
): number => (typeof base === "function" ? base(ctx) : base);

export const computePortEdits = (
  targetEnv: string,
  ports: ReadonlyArray<PortSpec>,
  used: ReadonlyMap<string, ReadonlySet<number>>,
  ctx: HomesteadContext,
): ReadonlyArray<readonly [string, string]> => {
  const envEdits: Array<readonly [string, string]> = [];
  for (const spec of ports) {
    const existing = readEnvVar(targetEnv, spec.key);
    const value =
      existing ?? String(nextFreePort(resolvePortBase(spec.base, ctx), used.get(spec.key) ?? new Set()));
    envEdits.push([spec.key, value]);
  }
  return envEdits;
};

const PROBE_HOST = "127.0.0.1";
const PROBE_TIMEOUT_MS = 200;
const MAX_PORT_ATTEMPTS = 20;

// Pick a port that is BOTH free in `used` (the sibling-.env-derived set) AND has
// no live listener. We only probe the .env-chosen candidate, not the whole range
// — probing is sequential network I/O, so probing every port would be too slow.
// On a live hit we record the busy port in `used` and ask `nextFreePort` again,
// bounded by `maxAttempts` so a saturated range fails loudly instead of hanging.
//
// Side effect: mutates `used`, adding every live port it skipped (but NOT the
// returned port). That lets a downstream `computePortEdits(base, used)` recompute
// this exact pick — the busy ports are excluded, the chosen one is the next free.
//
// ⚠ TOCTOU: a port free at probe time can be grabbed milliseconds later by
// another process or a parallel homestead run. Probing shrinks the window
// dramatically but cannot close it; we deliberately do NOT bind/reserve the port.
export const pickFreePort = Effect.fn("homestead/pick-free-port")(function* (
  base: number,
  used: Set<number>,
  probe: (port: number) => Effect.Effect<boolean>,
  maxAttempts: number = MAX_PORT_ATTEMPTS,
) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const candidate = nextFreePort(base, used);
    const live = yield* probe(candidate);
    if (!live) return candidate;
    used.add(candidate);
  }
  return yield* Effect.die(
    new Error(
      `[homestead] could not allocate a free port near ${base} after ${maxAttempts} attempts — ` +
        `every candidate already had a live listener. Free a port or stop a stale process.`,
    ),
  );
});

// Liveness-aware port allocation. For each spec the worktree's own .env already
// claims, we reuse that value verbatim and never probe (idempotent re-run). For
// the rest we probe-pick a port, then reserve the chosen port against every other
// spec so two specs sharing a range can't both grab it — its own set is left
// free of the pick so `computePortEdits` below reproduces the same value.
export const resolvePortEdits = Effect.fn("homestead/resolve-port-edits")(function* (
  targetEnv: string,
  ports: ReadonlyArray<PortSpec>,
  used: Map<string, Set<number>>,
  ctx: HomesteadContext,
  probe: (port: number) => Effect.Effect<boolean>,
  maxAttempts: number = MAX_PORT_ATTEMPTS,
) {
  for (const spec of ports) {
    if (readEnvVar(targetEnv, spec.key) !== undefined) continue;
    let set = used.get(spec.key);
    if (set === undefined) {
      set = new Set<number>();
      used.set(spec.key, set);
    }
    const picked = yield* pickFreePort(resolvePortBase(spec.base, ctx), set, probe, maxAttempts);
    for (const other of ports) {
      if (other.key !== spec.key) used.get(other.key)?.add(picked);
    }
  }
  return computePortEdits(targetEnv, ports, used, ctx);
});

// Resolve which worktree we're isolating — creating it first with `git worktree
// add` when --create is given.
export const resolveTarget = Effect.fn("homestead/resolve-target")(function* (
  repo: Repo,
  options: WorktreeOptions,
  config: HomesteadConfig,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const dryRun = options.dryRun ?? false;
  const createBranch = options.create;
  let targetDir: string;
  let branch: string;

  if (createBranch !== undefined) {
    branch = createBranch;
    const slug = slugify(branch);
    targetDir = resolveTargetDir({
      dirFlag: options.dir,
      config,
      repoName: repo.repoName,
      slug,
      branch,
      path,
    });

    const exists = yield* refExists(repo.primaryRoot, `refs/heads/${branch}`);
    const from = options.from ?? (exists ? undefined : yield* resolveDefaultBaseRef(repo.primaryRoot));
    yield* emit(config.onEvent, {
      type: "worktree.creating",
      branch,
      targetDir,
      ...(from !== undefined ? { from } : {}),
    });
    if (!dryRun) {
      const alreadyThere = yield* fs.exists(targetDir);
      if (alreadyThere) {
        yield* Console.log(`  ${targetDir} already exists — skipping git worktree add`);
      } else {
        yield* fs.makeDirectory(path.dirname(targetDir), { recursive: true });
        if (exists) {
          yield* run("git worktree add", "git", ["worktree", "add", targetDir, branch], {
            cwd: repo.primaryRoot,
          });
        } else {
          const baseRef = from ?? (yield* resolveDefaultBaseRef(repo.primaryRoot));
          yield* run("git worktree add", "git", ["worktree", "add", "-b", branch, targetDir, baseRef], {
            cwd: repo.primaryRoot,
          });
        }
      }
    }
  } else {
    targetDir = yield* capture("git", ["rev-parse", "--show-toplevel"], repo.startCwd);
    const head = yield* capture("git", ["rev-parse", "--abbrev-ref", "HEAD"], targetDir);
    branch = head === "HEAD" ? yield* capture("git", ["rev-parse", "--short", "HEAD"], targetDir) : head;
  }

  const slug = slugify(branch) || slugify(path.basename(targetDir));
  return { targetDir, branch, slug } satisfies Target;
});

// Decide every isolated value (the worktree's existing .env wins for ports, so
// re-runs are idempotent) without changing anything on disk.
export const resolvePlan = Effect.fn("homestead/resolve-plan")(function* (
  repo: Repo,
  target: Target,
  config: HomesteadConfig,
  probe: (port: number) => Effect.Effect<boolean> = (port) => probeTcp(PROBE_HOST, port, PROBE_TIMEOUT_MS),
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const envPath = path.join(target.targetDir, ".env");
  const reusedExistingEnv = yield* fs.exists(envPath);
  const targetEnv = reusedExistingEnv ? yield* fs.readFileString(envPath) : "";

  // .env body source: reuse the worktree's own .env (idempotent re-run), else
  // copy the primary checkout's configured source (real dev values), else the
  // committed fallback template (blank values — the plan warns).
  const sourceName = config.env?.source ?? DEFAULT_ENV_SOURCE;
  const fallbackName = config.env?.fallback ?? DEFAULT_ENV_FALLBACK;
  const mainEnvPath = path.join(repo.primaryRoot, sourceName);
  const fallbackPath = path.join(target.targetDir, fallbackName);
  const mainEnvExists = yield* fs.exists(mainEnvPath);
  const fellBackToExample = !reusedExistingEnv && !mainEnvExists;
  const sourcePath = reusedExistingEnv ? envPath : mainEnvExists ? mainEnvPath : fallbackPath;
  const sourceExists = yield* fs.exists(sourcePath);
  const sourceContent = sourceExists ? yield* fs.readFileString(sourcePath) : "";

  // Gather ports already claimed by sibling worktrees so we never reuse one.
  const worktreeList = yield* capture("git", ["worktree", "list", "--porcelain"], repo.startCwd);
  const worktreePaths = parseWorktreePorcelain(worktreeList).map((entry) => entry.path);

  const ports = config.ports ?? [];
  const siblingEnvContents: Array<string> = [];
  for (const wt of worktreePaths) {
    if (path.resolve(wt) === path.resolve(target.targetDir)) continue;
    const siblingEnv = path.join(wt, ".env");
    if (!(yield* fs.exists(siblingEnv))) continue;
    siblingEnvContents.push(yield* fs.readFileString(siblingEnv));
  }

  const portCtx = makeContext({
    repoName: repo.repoName,
    slug: target.slug,
    branch: target.branch,
    worktreeDir: target.targetDir,
    env: (key) => readEnvVar(sourceContent, key),
  });

  // Cross-process layer: reading the live reservations, picking ports, and
  // recording the picks as claims must be ONE locked critical section — if only
  // the write were locked, two homestead processes could both read a port "free"
  // and both take it. The claim bridges this pick→writeEnv gap; the in-process
  // Semaphore in setupWorktree serializes the same span for sibling fibers.
  const portEdits =
    ports.length === 0
      ? ([] as ReadonlyArray<readonly [string, string]>)
      : yield* withRegistryLock(
          repo.repoName,
          Effect.gen(function* () {
            const reserved = liveReservations(yield* readReservations(repo.repoName), Date.now());
            const used = collectUsedPorts(siblingEnvContents, ports, reserved);
            const picks = yield* resolvePortEdits(targetEnv, ports, used, portCtx, probe);
            const claims = reservationsToClaim(
              ports,
              targetEnv,
              picks,
              target.branch,
              process.pid,
              new Date().toISOString(),
            );
            if (claims.length > 0) {
              const survivors = reserved.filter((r) => !(r.branch === target.branch && r.pid === process.pid));
              yield* writeReservations(repo.repoName, [...survivors, ...claims]);
            }
            return picks;
          }),
        );

  const envEdits: Array<readonly [string, string]> = [...portEdits];

  // Derived keys (e.g. a per-worktree DATABASE_URL) — the config function reads
  // the SOURCE .env via ctx.env and returns the values to override.
  if (config.env?.derive !== undefined) {
    const ctx = makeWorktreeContext(repo, target, sourceContent);
    for (const [key, value] of Object.entries(config.env.derive(ctx))) {
      envEdits.push([key, value]);
    }
  }

  return {
    targetDir: target.targetDir,
    branch: target.branch,
    slug: target.slug,
    envPath,
    sourcePath,
    sourceContent,
    reusedExistingEnv,
    fellBackToExample,
    envEdits,
  } satisfies Plan;
});

export const printPlan = Effect.fn("homestead/print-plan")(function* (plan: Plan) {
  const envSource = plan.reusedExistingEnv
    ? "existing .env (updated in place)"
    : plan.fellBackToExample
      ? `${plan.sourcePath}  ⚠ source .env not found — values blank, setup may fail`
      : `${plan.sourcePath} (copied from primary)`;
  yield* Console.log(`\n▸ Worktree:  ${plan.targetDir}`);
  yield* Console.log(`  Branch:    ${plan.branch}`);
  yield* Console.log(`  .env from: ${envSource}`);
  for (const [key, value] of plan.envEdits) {
    yield* Console.log(`  ${key}=${value}`);
  }
});
