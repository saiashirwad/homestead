import { Console, Effect } from "effect";
import type { AgentConfig, AgentPromptContext, Plan, WorkItem } from "../types.ts";
import { Herdr } from "./service.ts";
import { launchAndSeed, toSpec } from "./launch.ts";

export interface LaunchAgentInput {
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

  yield* Console.log(`\n▸ Launching ${spec.command} for issue #${item.number} in ${plan.targetDir}`);
  const paneId = yield* herdr.createSurface(surface, plan.targetDir, `issue-${item.number}`);

  const prompt = agent.prompt({ item, branch, worktreeDir: plan.targetDir, repoName, args });

  yield* launchAndSeed(paneId, spec, prompt, { readyTimeoutMs: agent.readyTimeoutMs });

  yield* Console.log(`  ✓ #${item.number}: ${spec.command} launched in herdr pane ${paneId} — switch in to drive it`);
});
