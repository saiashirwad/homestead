import type { LoopConfig } from "./types.ts";

// The pure decision core of the agent loop — no Effect, no IO, no subprocess.
// `parseOutcome` reads an agent invocation's output into an Outcome; `decide`
// maps (state, outcome) to the next Action; `advance` evolves the state after an
// action runs. The loop runner (runner.ts) is a thin IO shell around these three
// pure functions, so the loop's logic is fully unit-testable in isolation
// (loop.test.ts) — same shape as text.ts / text.test.ts.

// The tokens the agent emits to signal a terminal state. `completion` is matched
// as a plain substring anywhere in the (noisy, tool-use-laden) output; `blockedTag`
// names the `<tag>reason</tag>` wrapper the agent uses to surface a hard question.
// `reviewClean` / `reviewFindings` are the review pass's distinct signals (ADR-0003):
// the fresh-context reviewer emits one explicitly so `parseReview` never infers
// state from absence — clean diff vs "I appended fix tasks".
export interface Sentinels {
  readonly completion: string;
  readonly blockedTag: string;
  readonly reviewClean: string;
  readonly reviewFindings: string;
}

export const DEFAULT_SENTINELS: Sentinels = {
  completion: "<promise>COMPLETE</promise>",
  blockedTag: "blocked",
  reviewClean: "<review>CLEAN</review>",
  reviewFindings: "<review>FINDINGS</review>",
};

// What one step of the loop tells us about the issue's state. The first three come
// from an agent invocation (parseOutcome); the last four drive the review-converge
// cycle (ADR-0003): GateGreen/GateRed from the machine-gate verdict mapper, and
// ReviewClean/ReviewFindings from a review pass (parseReview). `decide` routes them all.
export type Outcome =
  | { readonly _tag: "Working" }
  | { readonly _tag: "Complete" }
  | { readonly _tag: "Blocked"; readonly reason: string }
  | { readonly _tag: "GateGreen" }
  | { readonly _tag: "GateRed"; readonly reason: string }
  | { readonly _tag: "ReviewClean" }
  | { readonly _tag: "ReviewFindings" };

// The loop's cross-iteration state. Mirrors the durable facts: has the plan pass
// run, how many iterations have completed, the cap that backstops a stuck loop,
// and (continuity mode only) the claude session id to resume into next invocation.
// The review-converge fields (ADR-0003) follow the same `maxIterations` pattern —
// the static config knobs `decide` needs are folded into state by the runner at
// init, so `decide` stays pure and fully testable without a ResolvedLoop in hand.
export interface LoopState {
  readonly planned: boolean;
  readonly iterations: number;
  readonly maxIterations: number;
  // Review-converge (ADR-0003): whether the adversarial review gate is on at all,
  // whether a deterministic machine gate (verifyCommand) is configured, the cap on
  // review rounds, and how many review passes have run so far.
  readonly review: boolean;
  readonly gate: boolean;
  readonly maxReviewRounds: number;
  readonly reviewRounds: number;
  // The session id returned by the most recent invocation. `undefined` until the
  // first invocation reports one. Carried so a resume-mode loop continues the SAME
  // conversation across iterations; ignored entirely in amnesia mode.
  readonly sessionId?: string | undefined;
}

// A terminal verdict for the loop — drives the completion vs blocked handoff.
export type Terminal =
  | { readonly _tag: "Complete" }
  | { readonly _tag: "Blocked"; readonly reason: string };

// The next thing the loop should do. `RunGate` runs the deterministic machine gate
// (the project's verify command) and `RunReview` runs the fresh-context adversarial
// reviewer — the two halves of the review-converge cycle (ADR-0003) that sit between
// a builder `Complete` and a `Finish Complete`.
export type Action =
  | { readonly _tag: "RunPlan" }
  | { readonly _tag: "RunIteration" }
  | { readonly _tag: "RunGate" }
  | { readonly _tag: "RunReview" }
  | { readonly _tag: "Finish"; readonly terminal: Terminal };

const FALLBACK_BLOCKED_REASON = "agent emitted a blocked sentinel with no reason";

// Extract the `<blockedTag>reason</blockedTag>` payload from raw output, or null if
// no open tag is present. Shared by parseOutcome and parseReview so the human-only
// block path is identical whether it comes from a build iteration or a review pass.
const extractBlocked = (output: string, blockedTag: string): { readonly reason: string } | null => {
  const open = `<${blockedTag}>`;
  const start = output.indexOf(open);
  if (start === -1) return null;
  const from = start + open.length;
  const end = output.indexOf(`</${blockedTag}>`, from);
  const reason = (end === -1 ? output.slice(from) : output.slice(from, end)).trim();
  return { reason: reason === "" ? FALLBACK_BLOCKED_REASON : reason };
};

// Read an agent invocation's raw output into an Outcome. Precedence: a `<blocked>`
// sentinel WINS over a completion sentinel when both are present — a flagged block
// is the safe stop (surface the question to a human) rather than an auto-PR.
export const parseOutcome = (output: string, sentinels: Sentinels = DEFAULT_SENTINELS): Outcome => {
  const blocked = extractBlocked(output, sentinels.blockedTag);
  if (blocked !== null) return { _tag: "Blocked", reason: blocked.reason };
  if (output.includes(sentinels.completion)) return { _tag: "Complete" };
  return { _tag: "Working" };
};

// Read a review pass's raw output into an Outcome (ADR-0003). Precedence mirrors
// parseOutcome: a `<blocked>` (human-only question) wins, then a findings signal
// (the reviewer appended fix tasks — don't ship), then the clean signal. A review
// that emitted no recognizable signal is treated as Blocked rather than guessed
// clean — never auto-PR on ambiguity. Findings/clean are content-free outcomes:
// the reviewer carries its findings across the amnesia boundary by appending them
// to the task file, so RunReview is symmetric with RunPlan.
export const parseReview = (output: string, sentinels: Sentinels = DEFAULT_SENTINELS): Outcome => {
  const blocked = extractBlocked(output, sentinels.blockedTag);
  if (blocked !== null) return { _tag: "Blocked", reason: blocked.reason };
  if (output.includes(sentinels.reviewFindings)) return { _tag: "ReviewFindings" };
  if (output.includes(sentinels.reviewClean)) return { _tag: "ReviewClean" };
  return {
    _tag: "Blocked",
    reason: "review pass produced no recognizable signal (no clean, findings, or blocked sentinel)",
  };
};

// Map the machine gate's exit code into a verdict Outcome (ADR-0003). Exit 0 is the
// only green; any non-zero is red and carries a reason naming the command and code,
// which the runner turns into a fix task so the next iteration repairs it. Pure, so
// the gate routing is unit-testable without running a subprocess.
export const gateVerdict = (exitCode: number, command: ReadonlyArray<string>): Outcome =>
  exitCode === 0
    ? { _tag: "GateGreen" }
    : { _tag: "GateRed", reason: `machine gate \`${command.join(" ")}\` failed (exit ${exitCode})` };

const finishBlocked = (reason: string): Action => ({ _tag: "Finish", terminal: { _tag: "Blocked", reason } });

// Map (state, outcome) to the next Action. With review off this is exactly the
// original machine: terminal outcomes finish immediately, otherwise plan then
// iterate until the cap. With review on (ADR-0003) a builder `Complete` no longer
// finishes — it must clear the machine gate then a clean review first:
//   Complete  -> RunGate (or RunReview directly when no verifyCommand is configured)
//   GateGreen -> RunReview      GateRed  -> RunIteration (gate failure -> fix task)
//   Findings  -> RunIteration   Clean    -> Finish Complete
//   review/build Blocked -> Finish Blocked
//   reviewRounds >= maxReviewRounds -> Finish Blocked ("review did not converge")
export const decide = (state: LoopState, outcome: Outcome): Action => {
  // The convergence backstop: once the cap is hit, hand a never-satisfiable builder
  // to a human rather than launching another review round.
  const reviewOrConverge = (): Action =>
    state.reviewRounds >= state.maxReviewRounds
      ? finishBlocked(`review did not converge after ${state.maxReviewRounds} round(s)`)
      : { _tag: "RunReview" };

  switch (outcome._tag) {
    case "Blocked":
      return finishBlocked(outcome.reason);
    case "ReviewClean":
      return { _tag: "Finish", terminal: { _tag: "Complete" } };
    case "GateRed":
    case "ReviewFindings":
      // A gate failure or fresh findings are carried into the task file as fix
      // tasks (by the runner / the reviewer respectively); rebuild to address them.
      return { _tag: "RunIteration" };
    case "GateGreen":
      return reviewOrConverge();
    case "Complete":
      if (!state.review) return { _tag: "Finish", terminal: { _tag: "Complete" } };
      // Machine gate first when configured; review-only otherwise.
      return state.gate ? { _tag: "RunGate" } : reviewOrConverge();
    case "Working":
      if (!state.planned) return { _tag: "RunPlan" };
      if (state.iterations >= state.maxIterations) {
        return finishBlocked(`iteration cap (${state.maxIterations}) reached without a completion signal`);
      }
      return { _tag: "RunIteration" };
  }
};

// Every loop knob with its default filled in — the single place defaults live, so
// the runner and the skill seeder agree on the cap, sentinels, skill names, and
// task file. Pure, so it stays trivially testable.
export interface ResolvedLoop {
  readonly maxIterations: number;
  readonly sentinels: Sentinels;
  readonly planSkill: string;
  readonly implementSkill: string;
  readonly taskFile: string;
  // Continuity (ADR-0002): false (default) keeps ADR-0001 amnesia — every
  // invocation is a fresh context. true resumes the prior claude session each
  // iteration, so context carries forward (TASKS.md stops being the only memory).
  readonly resume: boolean;
  // Review-converge (ADR-0003), all defaulting to today's behaviour. `review` is
  // the master opt-in (false => a builder Complete opens the PR exactly as before).
  // `verifyCommand` is the deterministic machine gate (undefined => review-only, no
  // gate). `reviewSkill` is the fresh-context reviewer skill, `maxReviewRounds` the
  // convergence cap.
  readonly review: boolean;
  readonly verifyCommand: ReadonlyArray<string> | undefined;
  readonly reviewSkill: string;
  readonly maxReviewRounds: number;
}

export const resolveLoopSettings = (loop?: LoopConfig): ResolvedLoop => ({
  maxIterations: loop?.maxIterations ?? 25,
  sentinels: {
    completion: loop?.completionSentinel ?? DEFAULT_SENTINELS.completion,
    blockedTag: loop?.blockedTag ?? DEFAULT_SENTINELS.blockedTag,
    reviewClean: loop?.reviewCleanSentinel ?? DEFAULT_SENTINELS.reviewClean,
    reviewFindings: loop?.reviewFindingsSentinel ?? DEFAULT_SENTINELS.reviewFindings,
  },
  planSkill: loop?.planSkill ?? "homestead-plan",
  implementSkill: loop?.implementSkill ?? "homestead-implement",
  taskFile: loop?.taskFile ?? "TASKS.md",
  resume: loop?.resume ?? false,
  review: loop?.review ?? false,
  verifyCommand: loop?.verifyCommand,
  reviewSkill: loop?.reviewSkill ?? "homestead-review",
  maxReviewRounds: loop?.maxReviewRounds ?? 3,
});

// The `--resume <id>` args for the NEXT invocation, or `[]` when none apply.
// Resuming needs both: continuity mode on AND a session id from a prior run (so
// the first invocation always starts fresh — there is nothing to resume into yet).
// The VDD carve-out (ADR-0003): a review pass is ALWAYS fresh context, even under
// resume:true — the reviewer must never share history with the builder or it drifts
// toward endorsing the author's choices. Pure, so the decision is unit-testable.
export const resumeArg = (
  state: LoopState,
  resolved: ResolvedLoop,
  isReview = false,
): ReadonlyArray<string> =>
  !isReview && resolved.resume && state.sessionId !== undefined ? ["--resume", state.sessionId] : [];

// Fold the session id reported by an invocation into the loop state. We keep the
// LATEST non-empty id rather than the first, so it stays correct whether claude
// continues the same session on `--resume` or forks a new id — next iteration
// always resumes whatever the last one actually wrote.
export const rememberSession = (state: LoopState, sessionId: string | undefined): LoopState =>
  sessionId === undefined || sessionId === "" ? state : { ...state, sessionId };

// Evolve the loop state after an action has run. RunPlan records that planning
// happened; RunIteration counts the iteration; RunReview counts a review round (the
// convergence cap reads this); RunGate and Finish leave state unchanged — the gate
// just runs a command, and Finish is terminal.
export const advance = (state: LoopState, action: Action): LoopState => {
  switch (action._tag) {
    case "RunPlan":
      return { ...state, planned: true };
    case "RunIteration":
      return { ...state, iterations: state.iterations + 1 };
    case "RunReview":
      return { ...state, reviewRounds: state.reviewRounds + 1 };
    case "RunGate":
    case "Finish":
      return state;
  }
};
