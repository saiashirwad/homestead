import { Console, Effect } from "effect";
import type { HomesteadConfig } from "../types.ts";
import {
  printPlan,
  resolvePlan,
  resolveTargetDir,
  type Target,
} from "./plan.ts";
import { ensureServices, printDone, runSetup, writeEnv } from "./provision.ts";
import { finalizeReservations, PortAllocator } from "./ports.ts";
import { writeProvisionMarker } from "./marker.ts";
import type { Repo } from "./repo.ts";

export { resolveRepo } from "./repo.ts";
export type { Repo } from "./repo.ts";

export const provisionTarget = Effect.fnUntraced(function* (
  config: HomesteadConfig,
  repo: Repo,
  target: Target,
  options: { readonly dryRun?: boolean; readonly noSetup?: boolean },
) {
  const { semaphore } = yield* PortAllocator;
  const hasPorts = (config.ports ?? []).length > 0;

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

  yield* writeProvisionMarker(target.targetDir, {
    version: 1,
    completedAt: new Date().toISOString(),
    ports: (config.ports ?? []).map((spec) => spec.key),
    setupSteps: (config.setup ?? []).length,
  });

  yield* printDone(plan);
  return plan;
});
