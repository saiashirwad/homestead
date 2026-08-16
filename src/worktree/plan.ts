import { Console, Effect, FileSystem, Path } from "effect";
import * as os from "node:os";
import { Git } from "../git/service.ts";
import { nextFreePort, readEnvVar, slugify } from "../text.ts";
import { probeTcp } from "../process.ts";
import { DEFAULT_ENV_FALLBACK, DEFAULT_ENV_SOURCE } from "../defaults.ts";
import type {
  HomesteadConfig,
  Plan,
  PortSpec,
  WorktreeContext,
} from "../types.ts";
import { resolveDefaultBaseRef } from "./base-ref.ts";
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
  repoName: repo.repoName,
  slug: target.slug,
  branch: target.branch,
  worktreeDir: target.targetDir,
  primaryRoot: repo.primaryRoot,
  env: (key) => readEnvVar(sourceContent, key),
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
      config.worktreeDir({ repoName, slug, branch }),
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
  for (const { key, port } of reserved) {
    if (Number.isInteger(port)) used.get(key)?.add(port);
  }
  return used;
};

export const computePortEdits = (
  targetEnv: string,
  ports: ReadonlyArray<PortSpec>,
  used: ReadonlyMap<string, ReadonlySet<number>>,
): ReadonlyArray<readonly [string, string]> => {
  const envEdits: Array<readonly [string, string]> = [];
  for (const spec of ports) {
    const existing = readEnvVar(targetEnv, spec.key);
    const value =
      existing ?? String(nextFreePort(spec.base, used.get(spec.key) ?? new Set()));
    envEdits.push([spec.key, value]);
  }
  return envEdits;
};

const PROBE_HOST = "127.0.0.1";
const PROBE_TIMEOUT_MS = 200;
const MAX_PORT_ATTEMPTS = 20;

export const pickFreePort = Effect.fnUntraced(function* (
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

export const resolvePortEdits = Effect.fnUntraced(function* (
  targetEnv: string,
  ports: ReadonlyArray<PortSpec>,
  used: Map<string, Set<number>>,
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
    const picked = yield* pickFreePort(spec.base, set, probe, maxAttempts);
    for (const other of ports) {
      if (other.key !== spec.key) used.get(other.key)?.add(picked);
    }
  }
  return computePortEdits(targetEnv, ports, used);
});

export const resolvePlan = Effect.fnUntraced(function* (
  repo: Repo,
  target: Target,
  config: HomesteadConfig,
  probe: (port: number) => Effect.Effect<boolean> = (port) => probeTcp(PROBE_HOST, port, PROBE_TIMEOUT_MS),
) {
  const git = yield* Git;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const envPath = path.join(target.targetDir, ".env");
  const reusedExistingEnv = yield* fs.exists(envPath);
  const targetEnv = reusedExistingEnv ? yield* fs.readFileString(envPath) : "";

  const sourceName = config.env?.source ?? DEFAULT_ENV_SOURCE;
  const fallbackName = config.env?.fallback ?? DEFAULT_ENV_FALLBACK;
  const mainEnvPath = path.join(repo.primaryRoot, sourceName);
  const fallbackPath = path.join(target.targetDir, fallbackName);
  const mainEnvExists = yield* fs.exists(mainEnvPath);
  const fellBackToExample = !reusedExistingEnv && !mainEnvExists;
  const sourcePath = reusedExistingEnv ? envPath : mainEnvExists ? mainEnvPath : fallbackPath;
  const sourceExists = yield* fs.exists(sourcePath);
  const sourceContent = sourceExists ? yield* fs.readFileString(sourcePath) : "";

  const worktreePaths = (yield* git.worktree.list(repo.startCwd)).map((entry) => entry.path);

  const ports = config.ports ?? [];
  const siblingEnvContents: Array<string> = [];
  for (const wt of worktreePaths) {
    if (path.resolve(wt) === path.resolve(target.targetDir)) continue;
    const siblingEnv = path.join(wt, ".env");
    if (!(yield* fs.exists(siblingEnv))) continue;
    siblingEnvContents.push(yield* fs.readFileString(siblingEnv));
  }

  const portEdits =
    ports.length === 0
      ? ([] as ReadonlyArray<readonly [string, string]>)
      : yield* withRegistryLock(
          repo.repoName,
          Effect.gen(function* () {
            const reserved = liveReservations(yield* readReservations(repo.repoName), Date.now());
            const used = collectUsedPorts(siblingEnvContents, ports, reserved);
            const picks = yield* resolvePortEdits(targetEnv, ports, used, probe);
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

export const printPlan = Effect.fnUntraced(function* (plan: Plan) {
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
