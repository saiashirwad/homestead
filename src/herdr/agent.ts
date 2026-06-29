import { Effect } from "effect";
import { makeContext } from "../context.ts";
import { emit } from "../events.ts";
import { runAfterLaunch } from "../hooks.ts";
import type {
  AgentConfig,
  AgentPromptContext,
  HomesteadConfig,
  Plan,
  SurfaceCtx,
  WorkItem,
} from "../types.ts";
import { resolveCommand } from "../agent/defaults.ts";
import { buildAutonomousCommand, selfInvocation } from "../agent/autonomous.ts";
import { Herdr } from "./service.ts";
import { launchAndSeed, toSpec } from "./launch.ts";

// The single workspace that collects every orchestrator-spawned (auto) agent so
// the user can never confuse auto-work with their own worktrees.
export const DISPATCHED_WORKSPACE_LABEL = "[dispatched]";

export const resolveSurfaceLabel = (
  cfg: ((ctx: SurfaceCtx) => string) | undefined,
  ctx: SurfaceCtx,
): string => {
  if (cfg !== undefined) return cfg(ctx);
  switch (ctx.kind) {
    case "issue":
      return `issue-${ctx.item.number}`;
    case "pr":
      return `pr-${ctx.pr.number}`;
    case "agent":
      return `agent-${ctx.slug}`;
  }
};

// The agent type, minus the prompt-from-item builder (the issue path resolves
// the prompt from `item`; the spawn path passes a free-form string straight in).
type ResolvedAgent = AgentConfig & { readonly prompt?: (ctx: AgentPromptContext) => string };

interface LaunchCoreInput {
  readonly config: HomesteadConfig;
  readonly plan: Plan;
  readonly branch: string;
  readonly repoName: string;
  readonly agent: ResolvedAgent;
  // Already resolved — the issue path builds this from `item`, the spawn path
  // passes its free-form brief through verbatim.
  readonly prompt: string;
  // How to label the herdr surface (issue-<n> / pr-<n> / agent-<slug>).
  readonly surfaceCtx: SurfaceCtx;
  // Carried on the launching/launched events; exactly one is set.
  readonly item?: WorkItem;
  readonly slug?: string;
  readonly args?: ReadonlyArray<string>;
  // When set, this launch is orchestrator-spawned ("auto"): it nests under the
  // shared `[dispatched]` workspace and its label is prefixed with `[auto] `.
  readonly auto?: boolean;
}

// The shared surface-open + seed core. Knows nothing about WorkItem beyond the
// optional event payload — both `launchAgent` (issue) and `launchFreeAgent`
// (spawn) funnel through here with an already-resolved prompt.
const launchCore = Effect.fn("homestead/launch-core")(function* (input: LaunchCoreInput) {
  const { config, plan, branch, repoName, agent, prompt, surfaceCtx, item, slug, args = [], auto = false } = input;
  const baseCtx = makeContext({
    repoName,
    slug: plan.slug,
    branch,
    worktreeDir: plan.targetDir,
    ...(item !== undefined ? { item } : {}),
  });
  const commandCtx = { ...baseCtx, args };
  // Autonomous mode wraps the resolved agent argv in an `sh -c` tail that
  // re-invokes homestead to write the sentinel deterministically on exit. The
  // wrap happens here (not in toSpec) so readyMarker/trustPrompt stay derived
  // from the *real* agent, not from `sh`.
  const resolvedCommand = resolveCommand(agent.command, commandCtx);
  const command = agent.autonomous
    ? buildAutonomousCommand(resolvedCommand, selfInvocation())
    : resolvedCommand;
  const spec = toSpec({ ...agent, command });
  const surface = agent.surface ?? "worktree";
  const herdr = yield* Herdr;

  // Report the *real* agent binary in the launch events, not the `sh` wrapper
  // autonomous mode runs it under — that's what the user recognizes.
  const displayBinary = resolvedCommand[0] ?? spec.command;

  yield* emit(config.onEvent, {
    type: "agent.launching",
    ...(item !== undefined ? { item } : {}),
    ...(slug !== undefined ? { slug } : {}),
    command: [displayBinary],
    worktreeDir: plan.targetDir,
  });
  // Route by provenance: auto launches nest under the shared `[dispatched]`
  // workspace and wear an `[auto] ` marker; everything else is untouched. A user
  // `surfaceLabel` override still wins, but auto prepends `[auto] ` to its result
  // (with no override, the bare slug is used — not the `agent-` default).
  const baseLabel =
    auto && agent.surfaceLabel === undefined ? plan.slug : resolveSurfaceLabel(agent.surfaceLabel, surfaceCtx);
  const label = auto ? `[auto] ${baseLabel}` : baseLabel;
  const runtime = auto
    ? { workspaceId: yield* herdr.findOrCreateWorkspace(DISPATCHED_WORKSPACE_LABEL), cwd: process.cwd() }
    : undefined;
  const paneId = yield* herdr.createSurface(surface, plan.targetDir, label, runtime);

  yield* launchAndSeed(paneId, spec, prompt, { readyTimeoutMs: agent.readyTimeoutMs });
  yield* runAfterLaunch(config.afterLaunch, baseCtx, paneId);

  yield* emit(config.onEvent, {
    type: "agent.launched",
    ...(item !== undefined ? { item } : {}),
    ...(slug !== undefined ? { slug } : {}),
    command: [displayBinary],
    paneId,
    worktreeDir: plan.targetDir,
  });
  return paneId;
});

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
  const { config, plan, item, branch, repoName, agent, args = [] } = input;
  const baseCtx = makeContext({ repoName, slug: plan.slug, branch, worktreeDir: plan.targetDir, item });
  const prompt = agent.prompt({ ...baseCtx, item, args });
  return yield* launchCore({
    config,
    plan,
    branch,
    repoName,
    agent,
    prompt,
    surfaceCtx: { ...baseCtx, kind: "issue", item },
    item,
    args,
  });
});

export interface LaunchFreeAgentInput {
  readonly config: HomesteadConfig;
  readonly plan: Plan;
  readonly slug: string;
  readonly branch: string;
  readonly repoName: string;
  // The prompt builder (if any) is ignored — the spawn path seeds `prompt`.
  readonly agent: ResolvedAgent;
  readonly prompt: string;
  readonly args?: ReadonlyArray<string>;
  // Provenance marker. Its presence is the single source of truth for "this is
  // auto" — it routes the surface into `[dispatched]` with an `[auto] ` label.
  readonly spawnedBy?: string | undefined;
}

// Issue-free sibling of `launchAgent`: boots an agent in an already-provisioned
// worktree and seeds a free-form prompt. No `WorkItem` ever reaches it.
export const launchFreeAgent = Effect.fn("homestead/launch-free-agent")(function* (
  input: LaunchFreeAgentInput,
) {
  const { config, plan, slug, branch, repoName, agent, prompt, args = [], spawnedBy } = input;
  const baseCtx = makeContext({ repoName, slug: plan.slug, branch, worktreeDir: plan.targetDir });
  return yield* launchCore({
    config,
    plan,
    branch,
    repoName,
    agent,
    prompt,
    surfaceCtx: { ...baseCtx, kind: "agent" },
    slug,
    args,
    auto: spawnedBy !== undefined,
  });
});
