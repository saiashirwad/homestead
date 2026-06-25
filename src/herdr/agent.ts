import { Effect } from "effect";
import { makeContext } from "../context.ts";
import { emit } from "../events.ts";
import { runAfterLaunch } from "../hooks.ts";
import type {
  AgentConfig,
  AgentPromptContext,
  HomesteadConfig,
  HomesteadContext,
  HomesteadServices,
  Plan,
  WorkItem,
} from "../types.ts";
import { resolveCommand } from "../agent/defaults.ts";
import { Herdr } from "./service.ts";
import { launchAndSeed, toSpec } from "./launch.ts";

type SurfaceCtx = HomesteadContext & { readonly kind: "issue" | "pr" };

export const resolveSurfaceLabel = (
  cfg: ((ctx: SurfaceCtx) => string) | undefined,
  ctx: SurfaceCtx,
): string => {
  if (cfg !== undefined) return cfg(ctx);
  return ctx.kind === "issue" ? `issue-${ctx.item!.number}` : `pr-${ctx.pr!.number}`;
};

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
  const baseCtx = makeContext({ repoName, slug: plan.slug, branch, worktreeDir: plan.targetDir, item });
  const commandCtx = { ...baseCtx, args };
  const spec = toSpec({ ...agent, command: resolveCommand(agent.command, commandCtx) });
  const surface = agent.surface ?? "worktree";
  const herdr = yield* Herdr;

  yield* emit(input.config.onEvent, {
    type: "agent.launching",
    item,
    command: [spec.command],
    worktreeDir: plan.targetDir,
  });
  const paneId = yield* herdr.createSurface(surface, plan.targetDir, resolveSurfaceLabel(agent.surfaceLabel, {
    ...baseCtx,
    kind: "issue",
  }));

  const prompt = agent.prompt({ ...baseCtx, args });
  yield* launchAndSeed(paneId, spec, prompt, { readyTimeoutMs: agent.readyTimeoutMs });
  yield* runAfterLaunch(input.config.afterLaunch, baseCtx, paneId);

  yield* emit(input.config.onEvent, {
    type: "agent.launched",
    item,
    command: [spec.command],
    paneId,
    worktreeDir: plan.targetDir,
  });
});
