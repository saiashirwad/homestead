import { Console, Effect } from "effect";
import { emit } from "../events.ts";
import { UsageError } from "../errors.ts";
import { launchAgent } from "../herdr/agent.ts";
import { explainTimeout } from "../herdr/errors.ts";
import { resolveIssue, validateIssueRefs, type IssueRef } from "../issues.ts";
import { markStarted } from "../tracking.ts";
import { resolveAgentDefaults } from "../agent/defaults.ts";
import { DEFAULT_LAUNCH_CONCURRENCY } from "../defaults.ts";
import {
  type AgentConfig,
  type AgentPromptContext,
  type HomesteadConfig,
  type IssuesConfig,
  type WorkItem,
} from "../types.ts";
import { setupWorktree, type Repo } from "../worktree/index.ts";

export interface LaunchIssueInput {
  readonly config: HomesteadConfig;
  readonly repo: Repo;
  readonly item: WorkItem;
  readonly branch: string;
  readonly agent: AgentConfig & { readonly prompt: (ctx: AgentPromptContext) => string };
  readonly issueConfig: IssuesConfig | undefined;
  // Base ref to fork the worktree from (an integration branch); undefined falls
  // back to the repo's default branch inside resolveTarget.
  readonly from: string | undefined;
}

export const launchIssue = Effect.fn("homestead/launch-issue")(function* (input: LaunchIssueInput) {
  const { config, repo, item, branch, agent, issueConfig, from } = input;

  const plan = yield* setupWorktree(config, { create: branch, from }, repo);

  yield* launchAgent({
    config,
    plan,
    item,
    branch,
    repoName: repo.repoName,
    agent,
  });

  yield* markStarted(repo.repoName, item, branch, plan.targetDir, issueConfig);

  return plan;
});

export interface LaunchIssuesInput {
  readonly refs: ReadonlyArray<IssueRef>;
  readonly config: HomesteadConfig;
  readonly repo: Repo;
  readonly agent: AgentConfig;
  readonly issueConfig: IssuesConfig | undefined;
  // `--from` on the CLI; overrides the persistent `issues.base` config.
  readonly from?: string | undefined;
}

// The base ref a wave forks from: an explicit `--from` flag wins, else the
// persistent `issues.base` config, else undefined (resolveTarget then uses the
// repo's default branch).
export const resolveIssueBase = (
  from: string | undefined,
  issueConfig: IssuesConfig | undefined,
): string | undefined => from ?? issueConfig?.base;

export const launchIssues = Effect.fn("homestead/launch-issues")(function* (input: LaunchIssuesInput) {
  const { refs, config, repo, issueConfig } = input;
  const agent = resolveAgentDefaults(input.agent);
  const branchOf = issueConfig?.branch ?? ((item: WorkItem) => String(item.number));
  const from = resolveIssueBase(input.from, issueConfig);

  yield* validateIssueRefs(refs);
  yield* Console.log(`Issues: ${refs.map((r) => `#${r.number}`).join(", ")}`);
  const items = yield* Effect.forEach(refs, resolveIssue);

  // Bounded-parallel: the PortAllocator semaphore (in-process) + the reservations
  // registry (cross-process) make port picks race-free, so worktrees can provision
  // concurrently. `concurrency` is config-driven, conservative default.
  const concurrency = issueConfig?.concurrency ?? DEFAULT_LAUNCH_CONCURRENCY;
  const launched = yield* Effect.forEach(
    items,
    (item) =>
      launchIssue({
        config,
        repo,
        item,
        branch: branchOf(item),
        agent,
        issueConfig,
        from,
      }).pipe(
        Effect.as(true),
        Effect.catchTags({
          HerdrError: (e) =>
            Console.log(`  ⚠ #${item.number}: launch failed (${e.op}) — skipping`).pipe(Effect.as(false)),
          HerdrNotAvailable: (e) =>
            Console.log(`  ⚠ #${item.number}: ${e.reason} — skipping`).pipe(Effect.as(false)),
          HerdrTimeout: (e) =>
            Console.log(`  ⚠ #${item.number}: ${explainTimeout(e)} — skipping`).pipe(Effect.as(false)),
        }),
      ),
    { concurrency },
  );

  const ok = launched.filter(Boolean).length;
  yield* emit(config.onEvent, { type: "issues.summary", launched: ok, total: items.length });
});

export const requireAgentConfig = (
  agent: AgentConfig | undefined,
): Effect.Effect<AgentConfig & { readonly prompt: (ctx: AgentPromptContext) => string }, UsageError> =>
  agent === undefined
    ? Effect.fail(
        new UsageError({
          message: "[homestead] config has no `agent` block — launching an agent needs one.",
        }),
      )
    : Effect.succeed(resolveAgentDefaults(agent));
