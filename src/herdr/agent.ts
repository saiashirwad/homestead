import { Effect } from "effect";
import { makeContext } from "../context.ts";
import { emit } from "../events.ts";
import type {
  AgentConfig,
  AgentPromptContext,
  HomesteadConfig,
  HomesteadContext,
  HomesteadServices,
  Plan,
  WorkItem,
} from "../types.ts";
import { Herdr } from "./service.ts";
import { launchAndSeed, toSpec } from "./launch.ts";

export const runAfterLaunch = (
  hook: HomesteadConfig["afterLaunch"],
  ctx: HomesteadContext,
  paneId: string,
): Effect.Effect<void, never, HomesteadServices> =>
  hook === undefined ? Effect.void : hook({ ...ctx, paneId });

export interface LaunchAgentInput {
  readonly config: HomesteadConfig;
  readonly plan: Plan;
  readonly item: WorkItem;
  readonly branch: string;
  readonly repoName: string;
  readonly agent: AgentConfig & { readonly prompt: (ctx: AgentPromptContext) => string };
  readonly args?: ReadonlyArray<string>;
}

export const launchAgent = Effect.fn("homestead/launch-agent")(function* (input: LaunchAgentInput) {
  const { plan, item, branch, repoName, agent, args = [] } = input;
  const spec = toSpec(agent);
  const surface = agent.surface ?? "worktree";
  const herdr = yield* Herdr;

  yield* emit(input.config.onEvent, {
    type: "agent.launching",
    item,
    command: [spec.command],
    worktreeDir: plan.targetDir,
  });
  const paneId = yield* herdr.createSurface(surface, plan.targetDir, `issue-${item.number}`);

  const prompt = agent.prompt({ item, branch, worktreeDir: plan.targetDir, repoName, args });

  yield* launchAndSeed(paneId, spec, prompt, { readyTimeoutMs: agent.readyTimeoutMs });

  yield* runAfterLaunch(
    input.config.afterLaunch,
    makeContext({ repoName, slug: plan.slug, branch, worktreeDir: plan.targetDir, item }),
    paneId,
  );

  yield* emit(input.config.onEvent, {
    type: "agent.launched",
    item,
    command: [spec.command],
    paneId,
    worktreeDir: plan.targetDir,
  });
});
