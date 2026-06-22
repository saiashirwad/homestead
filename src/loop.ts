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
export interface Sentinels {
  readonly completion: string;
  readonly blockedTag: string;
}

export const DEFAULT_SENTINELS: Sentinels = {
  completion: "<promise>COMPLETE</promise>",
  blockedTag: "blocked",
};

// What one agent invocation's output tells us about the issue's state.
export type Outcome =
  | { readonly _tag: "Working" }
  | { readonly _tag: "Complete" }
  | { readonly _tag: "Blocked"; readonly reason: string };

// The loop's cross-iteration state. Mirrors the durable facts: has the plan pass
// run, how many iterations have completed, the cap that backstops a stuck loop,
// and (continuity mode only) the claude session id to resume into next invocation.
export interface LoopState {
  readonly planned: boolean;
  readonly iterations: number;
  readonly maxIterations: number;
  // The session id returned by the most recent invocation. `undefined` until the
  // first invocation reports one. Carried so a resume-mode loop continues the SAME
  // conversation across iterations; ignored entirely in amnesia mode.
  readonly sessionId?: string | undefined;
}

// A terminal verdict for the loop — drives the completion vs blocked handoff.
export type Terminal =
  | { readonly _tag: "Complete" }
  | { readonly _tag: "Blocked"; readonly reason: string };

// The next thing the loop should do.
export type Action =
  | { readonly _tag: "RunPlan" }
  | { readonly _tag: "RunIteration" }
  | { readonly _tag: "Finish"; readonly terminal: Terminal };

const FALLBACK_BLOCKED_REASON = "agent emitted a blocked sentinel with no reason";

// Read an agent invocation's raw output into an Outcome. Precedence: a `<blocked>`
// sentinel WINS over a completion sentinel when both are present — a flagged block
// is the safe stop (surface the question to a human) rather than an auto-PR.
export const parseOutcome = (output: string, sentinels: Sentinels = DEFAULT_SENTINELS): Outcome => {
  const open = `<${sentinels.blockedTag}>`;
  const close = `</${sentinels.blockedTag}>`;
  const start = output.indexOf(open);
  if (start !== -1) {
    const from = start + open.length;
    const end = output.indexOf(close, from);
    const reason = (end === -1 ? output.slice(from) : output.slice(from, end)).trim();
    return { _tag: "Blocked", reason: reason === "" ? FALLBACK_BLOCKED_REASON : reason };
  }
  if (output.includes(sentinels.completion)) return { _tag: "Complete" };
  return { _tag: "Working" };
};

// Map (state, outcome) to the next Action. Terminal outcomes finish immediately;
// otherwise plan first, then iterate until the cap is hit (which finishes blocked).
export const decide = (state: LoopState, outcome: Outcome): Action => {
  if (outcome._tag === "Complete") return { _tag: "Finish", terminal: { _tag: "Complete" } };
  if (outcome._tag === "Blocked") {
    return { _tag: "Finish", terminal: { _tag: "Blocked", reason: outcome.reason } };
  }
  if (!state.planned) return { _tag: "RunPlan" };
  if (state.iterations >= state.maxIterations) {
    return {
      _tag: "Finish",
      terminal: {
        _tag: "Blocked",
        reason: `iteration cap (${state.maxIterations}) reached without a completion signal`,
      },
    };
  }
  return { _tag: "RunIteration" };
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
}

export const resolveLoopSettings = (loop?: LoopConfig): ResolvedLoop => ({
  maxIterations: loop?.maxIterations ?? 25,
  sentinels: {
    completion: loop?.completionSentinel ?? DEFAULT_SENTINELS.completion,
    blockedTag: loop?.blockedTag ?? DEFAULT_SENTINELS.blockedTag,
  },
  planSkill: loop?.planSkill ?? "githog-plan",
  implementSkill: loop?.implementSkill ?? "githog-implement",
  taskFile: loop?.taskFile ?? "TASKS.md",
  resume: loop?.resume ?? false,
});

// The `--resume <id>` args for the NEXT invocation, or `[]` when none apply.
// Resuming needs both: continuity mode on AND a session id from a prior run (so
// the first invocation always starts fresh — there is nothing to resume into yet).
// Pure, so the continuity decision is unit-testable without spawning claude.
export const resumeArg = (state: LoopState, resolved: ResolvedLoop): ReadonlyArray<string> =>
  resolved.resume && state.sessionId !== undefined ? ["--resume", state.sessionId] : [];

// Fold the session id reported by an invocation into the loop state. We keep the
// LATEST non-empty id rather than the first, so it stays correct whether claude
// continues the same session on `--resume` or forks a new id — next iteration
// always resumes whatever the last one actually wrote.
export const rememberSession = (state: LoopState, sessionId: string | undefined): LoopState =>
  sessionId === undefined || sessionId === "" ? state : { ...state, sessionId };

// Evolve the loop state after an action has run. RunPlan records that planning
// happened; RunIteration counts the iteration; Finish is terminal (no change).
export const advance = (state: LoopState, action: Action): LoopState => {
  switch (action._tag) {
    case "RunPlan":
      return { ...state, planned: true };
    case "RunIteration":
      return { ...state, iterations: state.iterations + 1 };
    case "Finish":
      return state;
  }
};
