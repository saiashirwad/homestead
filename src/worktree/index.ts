import { Console, Effect } from "effect";
import type { HomesteadConfig, Plan, WorktreeOptions } from "../types.ts";
import { makeWorktreeContext, printPlan, resolvePlan, resolveTarget } from "./plan.ts";
import { ensureServices, printDone, runSetup, writeEnv } from "./provision.ts";
import type { Repo } from "./repo.ts";

export { resolveRepo } from "./repo.ts";
export type { Repo } from "./repo.ts";

// Provision an isolated worktree from the project's config and return its Plan.
export const setupWorktree = Effect.fn("homestead/setup-worktree")(function* (
  config: HomesteadConfig,
  options: WorktreeOptions,
  repo: Repo,
) {
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
    const ctx = { ...makeWorktreeContext(repo, target, plan.sourceContent), plan };
    yield* config.afterSetup(ctx).pipe(Effect.orDie);
  }

  yield* printDone(plan);
  return plan;
});

export type { Plan, WorktreeOptions } from "../types.ts";
