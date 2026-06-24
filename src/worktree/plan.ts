import { Console, Effect, FileSystem, Path } from "effect";
import * as os from "node:os";
import { parseWorktreePorcelain } from "../git/porcelain.ts";
import { nextFreePort, readEnvVar, slugify } from "../text.ts";
import { capture, run } from "../process.ts";
import {
  DEFAULT_ENV_FALLBACK,
  DEFAULT_ENV_SOURCE,
} from "../defaults.ts";
import {
  type HomesteadConfig,
  type Plan,
  type PortSpec,
  type WorktreeContext,
  type WorktreeOptions,
} from "../types.ts";
import { refExists, resolveDefaultBaseRef } from "./base-ref.ts";
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
  slug: target.slug,
  branch: target.branch,
  targetDir: target.targetDir,
  primaryRoot: repo.primaryRoot,
  repoName: repo.repoName,
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
    return path.resolve(config.worktreeDir({ repoName, slug, branch }));
  }
  return path.join(os.homedir(), "worktrees", repoName, slug);
};

export const collectUsedPorts = (
  envContents: ReadonlyArray<string>,
  ports: ReadonlyArray<PortSpec>,
): Map<string, Set<number>> => {
  const used = new Map<string, Set<number>>(ports.map((spec) => [spec.key, new Set<number>()]));
  for (const content of envContents) {
    for (const spec of ports) {
      const value = Number(readEnvVar(content, spec.key));
      if (Number.isInteger(value)) used.get(spec.key)?.add(value);
    }
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
    const value = existing ?? String(nextFreePort(spec.base, used.get(spec.key) ?? new Set()));
    envEdits.push([spec.key, value]);
  }
  return envEdits;
};

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
    const fromSuffix = from === undefined ? "" : ` (from ${from})`;
    yield* Console.log(`\n▸ Creating worktree '${branch}' at ${targetDir}${fromSuffix}`);
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
  const used = collectUsedPorts(siblingEnvContents, ports);

  const envEdits: Array<readonly [string, string]> = [...computePortEdits(targetEnv, ports, used)];

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
