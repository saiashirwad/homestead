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
import { capture, captureStreaming, runExit } from "./process.ts";
import { iterationPrompt, planPrompt, skillPresent } from "./skills.ts";
import { markBlocked, markReview } from "./tracking.ts";
import type { AgentConfig, IssuesConfig, LoopPromptContext, WorkItem } from "./types.ts";

const DEFAULT_WIP_LABEL = "agent:wip";
const DEFAULT_REVIEW_LABEL = "agent:review";
const DEFAULT_BLOCKED_LABEL = "agent:blocked";

// Push the branch to origin so a PR can open / a blocked branch is recoverable.
// Returns whether the push succeeded — a non-fast-forward rejection (e.g. a stale
// origin/<branch> left by a prior run) must NOT be ignored, or we'd open a PR
// against the wrong commit. Idempotent: re-pushing an up-to-date branch is a no-op.
const pushBranch = Effect.fn("githog/runner/push")(function* (cwd: string, branch: string) {
  const code = yield* runExit("git", ["push", "-u", "origin", branch], { cwd }).pipe(
    Effect.catchCause(() => Effect.succeed(1)),
  );
  if (code !== 0) yield* Console.log(`  ⚠ git push of '${branch}' failed (exit ${code})`);
  return code === 0;
});

// Collapse the loop's per-iteration commits into ONE before the PR opens. The loop
// commits each task as it goes (recoverability + progress), but that yields a PR
// with a commit per task — far too many for review. We squash against the branch
// point: `git reset --soft <base>` re-stages every change since the fork as one
// commit. The original task subjects go into the commit body so nothing is lost.
// Best-effort: if the base can't be resolved or there's ≤1 commit, leave history
// as-is rather than risk mangling it.
const squashToOne = Effect.fn("githog/runner/squash")(function* (cwd: string, item: WorkItem, branch: string) {
  // The branch's fork point from the repo's default branch (what the PR targets).
  const defaultRef = yield* capture("git", ["rev-parse", "--abbrev-ref", "origin/HEAD"], cwd).pipe(
    Effect.catchCause(() => Effect.succeed("")),
  );
  const baseRef = defaultRef === "" ? "main" : defaultRef;
  const base = yield* capture("git", ["merge-base", "HEAD", baseRef], cwd).pipe(
    Effect.catchCause(() => Effect.succeed("")),
  );
  if (base === "") {
    yield* Console.log(`  ⚠ couldn't resolve a base to squash against — leaving history as-is`);
    return;
  }
  const count = yield* capture("git", ["rev-list", "--count", `${base}..HEAD`], cwd).pipe(
    Effect.catchCause(() => Effect.succeed("0")),
  );
  if (Number(count) <= 1) return; // already one (or no) commit — nothing to squash

  const subjects = yield* capture("git", ["log", "--format=%s", "--reverse", `${base}..HEAD`], cwd).pipe(
    Effect.catchCause(() => Effect.succeed("")),
  );
  const body = `Closes #${item.number}\n\n${subjects
    .split("\n")
    .filter((s) => s.trim() !== "")
    .map((s) => `- ${s}`)
    .join("\n")}\n\n🤖 Squashed from ${count} loop commits by githog.`;

  yield* runExit("git", ["reset", "--soft", base], { cwd });
  yield* runExit("git", ["commit", "-m", item.title, "-m", body], { cwd });
  yield* Console.log(`  ✓ squashed ${count} commits into one for the PR`);
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
    if (terminal._tag === "Complete") {
      // Squash the per-iteration commits into one BEFORE pushing, so the PR shows a
      // single clean commit rather than one per task.
      yield* squashToOne(worktreeDir, item, branch);
      const pushed = yield* pushBranch(worktreeDir, branch);
      // A failed push means the remote doesn't have this work — opening a PR now
      // would point at the wrong commit. Block instead so the failure is visible.
      if (!pushed) {
        const reason = `branch '${branch}' could not be pushed (stale remote branch?) — refusing to open a PR against the wrong commit`;
        if (trackLabels) yield* markBlocked(wipLabel, blockedLabel, item.number, `🛑 githog: ${reason}`);
        yield* Console.log(`\n⛔ #${item.number} blocked: ${reason}${trackLabels ? ` — moved to '${blockedLabel}'` : ""}`);
        return;
      }
      yield* openPr(worktreeDir, item, branch);
      if (trackLabels) yield* markReview(wipLabel, reviewLabel, item.number);
      yield* Console.log(`\n✅ #${item.number} complete — PR opened${trackLabels ? `, moved to '${reviewLabel}'` : ""}`);
    } else {
      // Blocked: push the partial branch AS-IS (granular history aids debugging) — no squash.
      yield* pushBranch(worktreeDir, branch);
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
    // The plan pass writes a git-ignored task file and commits nothing; iterations
    // own their own commits of real work. So there's no scaffolding commit here.
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
