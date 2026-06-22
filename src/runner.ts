import { Console, Effect, FileSystem } from "effect";
import {
  advance,
  decide,
  parseOutcome,
  resolveLoopSettings,
  type LoopState,
  type Outcome,
  type Terminal,
} from "./loop.ts";
import { captureStreaming, runExit } from "./process.ts";
import { iterationPrompt, planPrompt, skillPresent } from "./skills.ts";
import { markBlocked, markReview } from "./tracking.ts";
import type { AgentConfig, IssuesConfig, LoopPromptContext, WorkItem } from "./types.ts";

const DEFAULT_WIP_LABEL = "agent:wip";
const DEFAULT_REVIEW_LABEL = "agent:review";
const DEFAULT_BLOCKED_LABEL = "agent:blocked";

// `git add -A && git commit` in the worktree, tolerating "nothing to commit". A
// safety net after the plan pass so the task list lands as a commit even if the
// agent forgot to commit it; the agent owns its own commits during iterations.
const commitAll = Effect.fn("githog/runner/commit-all")(function* (cwd: string, message: string) {
  yield* runExit("git", ["add", "-A"], { cwd }).pipe(Effect.catchCause(() => Effect.succeed(1)));
  yield* runExit("git", ["commit", "-m", message], { cwd }).pipe(Effect.catchCause(() => Effect.succeed(1)));
});

// Push the branch to origin (best-effort) so a PR can open / a blocked branch is
// recoverable. Idempotent: re-pushing an up-to-date branch is a no-op.
const pushBranch = Effect.fn("githog/runner/push")(function* (cwd: string, branch: string) {
  yield* runExit("git", ["push", "-u", "origin", branch], { cwd }).pipe(
    Effect.catchCause(() => Console.log(`  ⚠ git push of '${branch}' failed (continuing)`)),
  );
});

// Open a PR from the worktree's branch, linking the issue so a merge closes it.
const openPr = Effect.fn("githog/runner/open-pr")(function* (cwd: string, item: WorkItem, branch: string) {
  const body = `Closes #${item.number}\n\n🤖 Opened by githog's Ralph loop.`;
  yield* runExit(
    "gh",
    ["pr", "create", "--head", branch, "--title", item.title, "--body", body],
    { cwd },
  ).pipe(Effect.catchCause(() => Console.log(`  ⚠ gh pr create for '${branch}' failed (continuing)`)));
});

// The per-issue Ralph loop (ADR-0001): a thin IO shell around the pure core
// (loop.ts). Runs a one-shot plan pass, then re-invokes the agent headlessly with
// a clean context each iteration — parsing each output for sentinels — until the
// pure `decide` says to finish. On Complete: PR + agent:review (worktree left
// alive). On Blocked (cap exhausted or `<blocked>`): push + agent:blocked + the
// reason as a comment. Runs INSIDE the herdr pane so iterations are watchable.
export const runLoop = Effect.fn("githog/run-loop")(function* (
  item: WorkItem,
  worktreeDir: string,
  branch: string,
  agent: AgentConfig,
  issues: IssuesConfig,
) {
  const loop = resolveLoopSettings(agent.loop);
  const wipLabel = issues.label ?? DEFAULT_WIP_LABEL;
  const reviewLabel = issues.reviewLabel ?? DEFAULT_REVIEW_LABEL;
  const blockedLabel = issues.blockedLabel ?? DEFAULT_BLOCKED_LABEL;
  // Honour the same opt-out as markStarted: with no tracking label configured the
  // loop never touches the issue's labels/comments (listen forces label = wip, so
  // its lifecycle is unaffected). The PR / branch push are the work product, not
  // an issue-tracker touch, so they stand regardless.
  const trackLabels = issues.label !== undefined && issues.label.trim() !== "";

  const command = agent.command ?? ["claude"];
  const [bin, ...baseArgs] = command;

  const planSkillPresent = yield* skillPresent(worktreeDir, loop.planSkill);
  const implementSkillPresent = yield* skillPresent(worktreeDir, loop.implementSkill);
  const ctx: LoopPromptContext = {
    item,
    taskFile: loop.taskFile,
    completionSentinel: loop.sentinels.completion,
    blockedTag: loop.sentinels.blockedTag,
  };

  // One headless agent invocation: a fresh process (= clean context), output
  // streamed live to the pane AND captured for sentinel parsing.
  const invoke = (prompt: string) =>
    captureStreaming(bin ?? "claude", [...baseArgs, "-p", prompt], { cwd: worktreeDir });

  const finish = Effect.fn("githog/runner/finish")(function* (terminal: Terminal) {
    yield* pushBranch(worktreeDir, branch);
    if (terminal._tag === "Complete") {
      yield* openPr(worktreeDir, item, branch);
      if (trackLabels) yield* markReview(wipLabel, reviewLabel, item.number);
      yield* Console.log(`\n✅ #${item.number} complete — PR opened${trackLabels ? `, moved to '${reviewLabel}'` : ""}`);
    } else {
      const comment = `🛑 githog: agent blocked on \`${branch}\` — ${terminal.reason}`;
      if (trackLabels) yield* markBlocked(wipLabel, blockedLabel, item.number, comment);
      yield* Console.log(`\n⛔ #${item.number} blocked: ${terminal.reason}${trackLabels ? ` — moved to '${blockedLabel}'` : ""}`);
    }
  });

  yield* Console.log(`\n▸ githog Ralph loop for #${item.number}: ${item.title}`);

  let state: LoopState = { planned: false, iterations: 0, maxIterations: loop.maxIterations };
  let outcome: Outcome = { _tag: "Working" };

  for (;;) {
    const action = decide(state, outcome);
    if (action._tag === "Finish") {
      yield* finish(action.terminal);
      return;
    }

    const isPlan = action._tag === "RunPlan";
    const prompt = isPlan
      ? agent.loop?.planPrompt?.(ctx) ?? planPrompt(loop.planSkill, planSkillPresent, ctx)
      : agent.loop?.iterationPrompt?.(ctx) ?? iterationPrompt(loop.implementSkill, implementSkillPresent, ctx);
    yield* Console.log(
      isPlan
        ? `\n▸ #${item.number} — plan pass`
        : `\n▸ #${item.number} — iteration ${state.iterations + 1}/${loop.maxIterations}`,
    );
    const { output } = yield* invoke(prompt);
    // Safety net: commit the task list even if the plan skill forgot to. Iterations
    // own their own commits, so we only force-commit after the plan pass.
    if (isPlan) yield* commitAll(worktreeDir, `githog: plan #${item.number}`);
    state = advance(state, action);
    outcome = parseOutcome(output, loop.sentinels);
    // Guard: a plan pass that emitted no sentinel but produced no task list has
    // nothing to iterate on (denied tool, agent slip). Block instead of burning
    // the whole iteration cap on a missing plan.
    if (isPlan && outcome._tag === "Working") {
      const fs = yield* FileSystem.FileSystem;
      const taskPath = `${worktreeDir}/${loop.taskFile}`;
      if (!(yield* fs.exists(taskPath).pipe(Effect.catchCause(() => Effect.succeed(false))))) {
        outcome = {
          _tag: "Blocked",
          reason: `plan pass produced no ${loop.taskFile} — nothing to iterate on (check the agent could read the issue)`,
        };
      }
    }
  }
});
