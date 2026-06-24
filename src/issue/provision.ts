import { Console, Effect } from "effect";
import { UsageError } from "../errors.ts";
import { launchAgent } from "../herdr/agent.ts";
import { resolveIssue, validateIssueRefs, type IssueRef } from "../issues.ts";
import { markStarted } from "../tracking.ts";
import { resolveAgentDefaults } from "../agent/defaults.ts";
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
}

export const launchIssue = Effect.fn("homestead/launch-issue")(function* (input: LaunchIssueInput) {
  const { config, repo, item, branch, agent, issueConfig } = input;

  const plan = yield* setupWorktree(config, { create: branch }, repo);

  yield* launchAgent({
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
}

export const launchIssues = Effect.fn("homestead/launch-issues")(function* (input: LaunchIssuesInput) {
  const { refs, config, repo, issueConfig } = input;
  const agent = resolveAgentDefaults(input.agent);
  const branchOf = issueConfig?.branch ?? ((item: WorkItem) => String(item.number));

  yield* validateIssueRefs(refs);
  yield* Console.log(`Issues: ${refs.map((r) => `#${r.number}`).join(", ")}`);
  const items = yield* Effect.forEach(refs, resolveIssue);

  // Sequential: port allocation reads sibling .env files; parallel setup causes collisions.
  const launched = yield* Effect.forEach(items, (item) =>
    launchIssue({
      config,
      repo,
      item,
      branch: branchOf(item),
      agent,
      issueConfig,
    }).pipe(
      Effect.as(true),
      Effect.catchTags({
        HerdrError: (e) =>
          Console.log(`  ⚠ #${item.number}: launch failed (${e.op}) — skipping`).pipe(Effect.as(false)),
        HerdrNotAvailable: (e) =>
          Console.log(`  ⚠ #${item.number}: ${e.reason} — skipping`).pipe(Effect.as(false)),
        HerdrTimeout: (e) =>
          Console.log(`  ⚠ #${item.number}: agent never reached ready (${e.marker}) — skipping`).pipe(
            Effect.as(false),
          ),
      }),
    ),
  );

  const ok = launched.filter(Boolean).length;
  yield* Console.log(
    ok === items.length
      ? `\n✅ ${ok} agent(s) launched. Switch into the issue-* workspaces to drive them.`
      : `\n✅ ${ok}/${items.length} agent(s) launched (${items.length - ok} skipped). Switch into the issue-* workspaces to drive them.`,
  );
});

export const requireAgentConfig = (
  agent: AgentConfig | undefined,
): Effect.Effect<AgentConfig & { readonly prompt: (ctx: AgentPromptContext) => string }, UsageError> =>
  agent === undefined
    ? Effect.fail(
        new UsageError({
          message: "[homestead] config has no `agent` block — launching an agent per issue needs one.",
        }),
      )
    : Effect.succeed(resolveAgentDefaults(agent));
