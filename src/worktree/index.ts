import { Console, Effect } from "effect";
import type { HomesteadConfig, Plan, WorktreeOptions } from "../types.ts";
import { makeWorktreeContext, printPlan, resolvePlan, resolveTarget } from "./plan.ts";
import { ensureServices, printDone, runSetup, writeEnv } from "./provision.ts";
import { finalizeReservations, PortAllocator } from "./ports.ts";
import { normalizeHookResult } from "../hooks.ts";
import type { Repo } from "./repo.ts";

export { resolveRepo } from "./repo.ts";
export type { Repo } from "./repo.ts";

// Provision an isolated worktree from the project's config and return its Plan.
export const setupWorktree = Effect.fn("homestead/setup-worktree")(function* (
  config: HomesteadConfig,
  options: WorktreeOptions,
  repo: Repo,
) {
  const { semaphore } = yield* PortAllocator;
  const target = yield* resolveTarget(repo, options, config);
  const hasPorts = (config.ports ?? []).length > 0;

  // Layer 1 (in-process): hold one permit across the read-pick-write span
  // (resolvePlan's port pick → writeEnv) so sibling fibers of a single invocation
  // can't both pick the same port. `finalize` ALWAYS runs — success, dry-run, or
  // failure — to clear this branch's cross-process reservation once its `.env`
  // carries the port (or nothing was written); TTL/dead-pid expiry is the
  // backstop if the process dies before finalize.
  const region = Effect.gen(function* () {
    const plan = yield* resolvePlan(repo, target, config);
    yield* printPlan(plan);
    if (options.dryRun === true) {
      yield* Console.log(`\n(dry run — no changes made)`);
      return plan;
    }
    yield* writeEnv(plan);
    return plan;
  });
  const plan = yield* semaphore.withPermit(
    hasPorts
      ? region.pipe(
          Effect.ensuring(finalizeReservations(repo.repoName, target.branch, process.pid).pipe(Effect.ignore)),
        )
      : region,
  );
  if (options.dryRun === true) return plan;

  yield* ensureServices(repo, config);
  if (options.noSetup !== true) {
    yield* runSetup(repo, plan, config);
  }

  if (config.afterSetup !== undefined) {
    const ctx = { ...makeWorktreeContext(repo, target, plan.sourceContent), plan };
    yield* normalizeHookResult(config.afterSetup(ctx)).pipe(Effect.orDie);
  }

  yield* printDone(plan);
  return plan;
});

export type { Plan, WorktreeOptions } from "../types.ts";
