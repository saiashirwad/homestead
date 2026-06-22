import { Console, Effect, FileSystem, Path } from "effect";
import * as os from "node:os";
import { ServiceUnavailable } from "./errors.ts";
import { applyTemplate, nextFreePort, readEnvVar, setEnvVar, slugify } from "./text.ts";
import { capture, pollSchedule, probeTcp, run, runExit } from "./process.ts";
import type { GithogConfig, Plan, WorktreeContext, WorktreeOptions } from "./types.ts";

const DEFAULT_ENV_SOURCE = ".env";
const DEFAULT_ENV_FALLBACK = ".env.example";

interface Repo {
  readonly startCwd: string;
  readonly primaryRoot: string;
  readonly repoName: string;
}

interface Target {
  readonly targetDir: string;
  readonly branch: string;
  readonly slug: string;
}

// Locate the primary checkout (where the shared services + canonical .env + the
// githog config live). git-common-dir is "<primary>/.git" for every worktree.
export const resolveRepo = Effect.fn("githog/resolve-repo")(function* () {
  const path = yield* Path.Path;
  const startCwd = process.cwd();
  const gitCommonDirRaw = yield* capture("git", ["rev-parse", "--git-common-dir"], startCwd);
  const gitCommonDir = path.isAbsolute(gitCommonDirRaw)
    ? gitCommonDirRaw
    : path.resolve(startCwd, gitCommonDirRaw);
  const primaryRoot = path.dirname(gitCommonDir);
  return { startCwd, primaryRoot, repoName: path.basename(primaryRoot) } satisfies Repo;
});

// Resolve which worktree we're isolating — creating it first with `git worktree
// add` when --create is given.
const resolveTarget = Effect.fn("githog/resolve-target")(function* (
  repo: Repo,
  options: WorktreeOptions,
  config: GithogConfig,
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
    const dirFlag = options.dir;
    targetDir =
      dirFlag !== undefined
        ? path.resolve(dirFlag)
        : config.worktreeDir !== undefined
          ? path.resolve(config.worktreeDir({ repoName: repo.repoName, slug, branch }))
          : path.join(os.homedir(), "worktrees", repo.repoName, slug);

    yield* Console.log(`\n▸ Creating worktree '${branch}' at ${targetDir}`);
    if (!dryRun) {
      const alreadyThere = yield* fs.exists(targetDir);
      if (alreadyThere) {
        yield* Console.log(`  ${targetDir} already exists — skipping git worktree add`);
      } else {
        yield* fs.makeDirectory(path.dirname(targetDir), { recursive: true });
        const branchExists =
          (yield* runExit("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
            cwd: repo.primaryRoot,
          })) === 0;
        const from = options.from;
        const addArgs = branchExists
          ? ["worktree", "add", targetDir, branch]
          : from !== undefined
            ? ["worktree", "add", "-b", branch, targetDir, from]
            : ["worktree", "add", "-b", branch, targetDir];
        yield* run("git worktree add", "git", addArgs, { cwd: repo.primaryRoot });
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
const resolvePlan = Effect.fn("githog/resolve-plan")(function* (
  repo: Repo,
  target: Target,
  config: GithogConfig,
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
  const worktreePaths = worktreeList
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length).trim());

  const ports = config.ports ?? [];
  const used = new Map<string, Set<number>>(ports.map((spec) => [spec.key, new Set<number>()]));
  for (const wt of worktreePaths) {
    if (path.resolve(wt) === path.resolve(target.targetDir)) continue;
    const siblingEnv = path.join(wt, ".env");
    if (!(yield* fs.exists(siblingEnv))) continue;
    const content = yield* fs.readFileString(siblingEnv);
    for (const spec of ports) {
      const value = Number(readEnvVar(content, spec.key));
      if (Number.isInteger(value)) used.get(spec.key)?.add(value);
    }
  }

  const envEdits: Array<readonly [string, string]> = [];
  for (const spec of ports) {
    const existing = readEnvVar(targetEnv, spec.key);
    const value = existing ?? String(nextFreePort(spec.base, used.get(spec.key) ?? new Set()));
    envEdits.push([spec.key, value]);
  }

  // Derived keys (e.g. a per-worktree DATABASE_URL) — the config function reads
  // the SOURCE .env via ctx.env and returns the values to override.
  if (config.env?.derive !== undefined) {
    const ctx: WorktreeContext = {
      slug: target.slug,
      branch: target.branch,
      targetDir: target.targetDir,
      primaryRoot: repo.primaryRoot,
      repoName: repo.repoName,
      env: (key) => readEnvVar(sourceContent, key),
    };
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

const printPlan = Effect.fn("githog/print-plan")(function* (plan: Plan) {
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

// Write the worktree's .env: the source body with our owned keys overridden.
const writeEnv = Effect.fn("githog/write-env")(function* (plan: Plan) {
  const fs = yield* FileSystem.FileSystem;
  const lines = plan.envEdits.reduce(
    (acc, [key, value]) => setEnvVar(acc, key, value),
    plan.sourceContent.split("\n"),
  );
  yield* fs.writeFileString(plan.envPath, lines.join("\n"));
  yield* Console.log(`\n✓ wrote ${plan.envPath}`);
});

// Make sure each configured TCP service is reachable (starting it if a `start`
// command is given, then polling until it accepts connections).
const ensureServices = Effect.fn("githog/ensure-services")(function* (
  repo: Repo,
  config: GithogConfig,
) {
  for (const service of config.services ?? []) {
    const timeoutMs = service.timeoutMs ?? 15000;
    const reachable = yield* probeTcp(service.host, service.port, 1000);
    if (reachable) continue;
    if (service.start === undefined || service.start.length === 0) {
      return yield* new ServiceUnavailable({
        name: service.name,
        host: service.host,
        port: service.port,
        detail: `unreachable and no \`start\` command configured`,
      });
    }
    yield* Console.log(
      `\n▸ ${service.name} unreachable on ${service.host}:${service.port} — starting it`,
    );
    const [command, ...args] = service.start;
    yield* runExit(command!, args, { cwd: repo.primaryRoot });
    const retries = Math.max(1, Math.ceil(timeoutMs / 1000));
    const up = yield* probeTcp(service.host, service.port, 1000).pipe(
      Effect.repeat({ schedule: pollSchedule(retries), until: (ok) => ok }),
    );
    if (!up) {
      return yield* new ServiceUnavailable({
        name: service.name,
        host: service.host,
        port: service.port,
        detail: `still unreachable ${timeoutMs}ms after running its start command`,
      });
    }
  }
});

// Run the config's ordered setup commands against the worktree.
const runSetup = Effect.fn("githog/run-setup")(function* (repo: Repo, plan: Plan, config: GithogConfig) {
  const vars: Record<string, string> = {
    slug: plan.slug,
    branch: plan.branch,
    targetDir: plan.targetDir,
    primaryRoot: repo.primaryRoot,
    repoName: repo.repoName,
  };
  const envMap = Object.fromEntries(plan.envEdits);

  for (const step of config.setup ?? []) {
    const argv = step.run.map((arg) => applyTemplate(arg, vars, envMap));
    const [command, ...args] = argv;
    const cwd = step.cwd === undefined ? plan.targetDir : applyTemplate(step.cwd, vars, envMap);
    const injected = Object.fromEntries(
      (step.injectEnv ?? [])
        .map((key) => [key, envMap[key]] as const)
        .filter((entry): entry is readonly [string, string] => entry[1] !== undefined),
    );
    const runOptions = { cwd, ...(Object.keys(injected).length > 0 ? { env: injected } : {}) };

    if (step.fatal === false) {
      const code = yield* runExit(command!, args, runOptions);
      if (code !== 0) {
        yield* Console.log(`\n⚠ ${step.label} failed (exit ${code}) — continuing (fatal: false)`);
      }
    } else {
      yield* run(step.label, command!, args, runOptions);
    }
  }
});

const printDone = Effect.fn("githog/print-done")(function* (plan: Plan) {
  yield* Console.log(`\n✅ Worktree ready: ${plan.targetDir}`);
});

// Provision an isolated worktree from the project's config and return its
// resolved Plan. Reusable from any githog effect (implement-issues calls it
// in-process). Every fs/subprocess PlatformError becomes a defect — dev tooling;
// the one error it surfaces is a service that won't come up.
export const setupWorktree = (config: GithogConfig, options: WorktreeOptions) =>
  Effect.gen(function* () {
    const repo = yield* resolveRepo();
    const target = yield* resolveTarget(repo, options, config);
    const plan = yield* resolvePlan(repo, target, config);

    yield* printPlan(plan);
    if (options.dryRun === true) {
      yield* Console.log(`\n(dry run — no changes made)`);
      return plan;
    }

    yield* writeEnv(plan);
    yield* ensureServices(repo, config);
    if (options.noSetup !== true) {
      yield* runSetup(repo, plan, config);
    }

    if (config.afterSetup !== undefined) {
      const ctx: WorktreeContext & { readonly plan: Plan } = {
        slug: plan.slug,
        branch: plan.branch,
        targetDir: plan.targetDir,
        primaryRoot: repo.primaryRoot,
        repoName: repo.repoName,
        env: (key) => readEnvVar(plan.sourceContent, key),
        plan,
      };
      yield* config.afterSetup(ctx).pipe(Effect.orDie);
    }

    // Loop skills are installed once by `githog init` on the default branch, so the
    // worktree inherits them already-committed (no per-worktree seeding, which used
    // to commit them into every issue branch's diff).

    yield* printDone(plan);
    return plan;
  });
