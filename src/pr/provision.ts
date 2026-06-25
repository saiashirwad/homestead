import { Effect } from "effect";
import { makeContext } from "../context.ts";
import { emit } from "../events.ts";
import { runAfterLaunch } from "../hooks.ts";
import { UsageError } from "../errors.ts";
import { Herdr } from "../herdr/service.ts";
import { resolveCommand } from "../agent/defaults.ts";
import { launchAndSeed, toSpec } from "../herdr/launch.ts";
import { resolveSurfaceLabel } from "../herdr/agent.ts";
import type { AgentConfig, HomesteadConfig } from "../types.ts";
import { setupWorktree, type Repo } from "../worktree/index.ts";
import { ensureLocalBranch, planPrCheckout } from "./branch.ts";
import { buildPrPrompt } from "./prompt.ts";
import { validatePrRef, type PrRef } from "./ref.ts";
import { resolvePr } from "./resolve.ts";

export interface LaunchPrInput {
  readonly mode: "review" | "work";
  readonly ref: PrRef;
  readonly config: HomesteadConfig;
  readonly repo: Repo;
  readonly agent: AgentConfig;
}

export const launchPr = Effect.fn("homestead/launch-pr")(function* (input: LaunchPrInput) {
  const { mode, ref, config, repo, agent } = input;

  yield* validatePrRef(ref);
  const pr = yield* resolvePr(ref);
  const checkout = planPrCheckout(pr, config.pr?.prBranch);

  if (mode === "work" && checkout.kind === "fork") {
    return yield* new UsageError({
      message:
        `[homestead] cross-repo PR #${pr.number} can't be continued here. ` +
        `Try: homestead review ${pr.number}`,
    });
  }

  yield* emit(config.onEvent, {
    type: "pr.launching",
    pr,
    mode,
    branch: checkout.branch,
  });

  yield* ensureLocalBranch(repo.primaryRoot, pr, checkout);

  // setupWorktree attaches a worktree to checkout.branch: resolveTarget sees
  // refs/heads/<branch> exists (we just ensured it) and runs `git worktree add
  // <dir> <branch>` instead of creating a new branch.
  const plan = yield* setupWorktree(config, { create: checkout.branch }, repo);

  const prompt = buildPrPrompt(mode, pr, config);
  const surface = agent.surface ?? "worktree";
  const herdr = yield* Herdr;
  const baseCtx = makeContext({
    repoName: repo.repoName,
    slug: plan.slug,
    branch: checkout.branch,
    worktreeDir: plan.targetDir,
    pr,
  });
  const paneId = yield* herdr.createSurface(
    surface,
    plan.targetDir,
    resolveSurfaceLabel(agent.surfaceLabel, { ...baseCtx, kind: "pr" }),
  );
  yield* launchAndSeed(
    paneId,
    toSpec({ ...agent, command: resolveCommand(agent.command, { ...baseCtx, args: [] as const }) }),
    prompt,
    { readyTimeoutMs: agent.readyTimeoutMs },
  );
  yield* runAfterLaunch(config.afterLaunch, baseCtx, paneId);

  yield* emit(config.onEvent, {
    type: "pr.launched",
    pr,
    mode,
    branch: checkout.branch,
    paneId,
  });
});
