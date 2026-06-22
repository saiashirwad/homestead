import { expect, test } from "bun:test";
import {
  advance,
  decide,
  DEFAULT_SENTINELS,
  parseOutcome,
  type Action,
  type LoopState,
  type Outcome,
} from "./loop.ts";

const state = (over: Partial<LoopState> = {}): LoopState => ({
  planned: false,
  iterations: 0,
  maxIterations: 5,
  ...over,
});

// --- parseOutcome -----------------------------------------------------------

test("parseOutcome: plain working output -> Working", () => {
  expect(parseOutcome("doing some work\nediting files")).toEqual({ _tag: "Working" });
  expect(parseOutcome("")).toEqual({ _tag: "Working" });
});

test("parseOutcome: completion sentinel -> Complete", () => {
  expect(parseOutcome("all done\n<promise>COMPLETE</promise>")).toEqual({ _tag: "Complete" });
});

test("parseOutcome: completion sentinel embedded in noisy tool-use output -> Complete", () => {
  const noisy =
    "● Bash(bun test)\n  ⎿ 12 pass\nLet me finish. <promise>COMPLETE</promise> Thanks!\n● done";
  expect(parseOutcome(noisy)).toEqual({ _tag: "Complete" });
});

test("parseOutcome: blocked sentinel -> Blocked with extracted reason", () => {
  expect(parseOutcome("hmm <blocked>need the API key for staging</blocked> stopping")).toEqual({
    _tag: "Blocked",
    reason: "need the API key for staging",
  });
});

test("parseOutcome: blocked reason is trimmed across newlines", () => {
  expect(parseOutcome("<blocked>\n  which DB schema?\n</blocked>")).toEqual({
    _tag: "Blocked",
    reason: "which DB schema?",
  });
});

test("parseOutcome: empty blocked reason gets a fallback", () => {
  const out = parseOutcome("<blocked></blocked>");
  expect(out._tag).toBe("Blocked");
  if (out._tag === "Blocked") expect(out.reason.length).toBeGreaterThan(0);
});

test("parseOutcome: both sentinels present -> Blocked wins (defined precedence)", () => {
  expect(parseOutcome("<promise>COMPLETE</promise>\n<blocked>but actually stuck</blocked>")).toEqual({
    _tag: "Blocked",
    reason: "but actually stuck",
  });
});

test("parseOutcome: honours custom sentinels", () => {
  const sentinels = { completion: "##DONE##", blockedTag: "halt" };
  expect(parseOutcome("work ##DONE##", sentinels)).toEqual({ _tag: "Complete" });
  expect(parseOutcome("<halt>why</halt>", sentinels)).toEqual({ _tag: "Blocked", reason: "why" });
  // the default tokens are inert under custom sentinels
  expect(parseOutcome("<promise>COMPLETE</promise>", sentinels)).toEqual({ _tag: "Working" });
});

// --- decide -----------------------------------------------------------------

const working: Outcome = { _tag: "Working" };

test("decide: fresh state + Working -> RunPlan", () => {
  expect(decide(state(), working)).toEqual({ _tag: "RunPlan" });
});

test("decide: planned, below cap, Working -> RunIteration", () => {
  expect(decide(state({ planned: true, iterations: 0 }), working)).toEqual({ _tag: "RunIteration" });
  expect(decide(state({ planned: true, iterations: 4, maxIterations: 5 }), working)).toEqual({
    _tag: "RunIteration",
  });
});

test("decide: Complete -> Finish(Complete) regardless of progress", () => {
  expect(decide(state(), { _tag: "Complete" })).toEqual({
    _tag: "Finish",
    terminal: { _tag: "Complete" },
  });
});

test("decide: Blocked -> Finish(Blocked) carrying the reason", () => {
  expect(decide(state({ planned: true }), { _tag: "Blocked", reason: "stuck" })).toEqual({
    _tag: "Finish",
    terminal: { _tag: "Blocked", reason: "stuck" },
  });
});

test("decide: iteration count at cap with Working -> Finish(Blocked)", () => {
  const action = decide(state({ planned: true, iterations: 5, maxIterations: 5 }), working);
  expect(action._tag).toBe("Finish");
  if (action._tag === "Finish") {
    expect(action.terminal._tag).toBe("Blocked");
  }
});

// --- advance ----------------------------------------------------------------

test("advance: RunPlan marks planned", () => {
  expect(advance(state(), { _tag: "RunPlan" })).toEqual(state({ planned: true }));
});

test("advance: RunIteration increments the iteration count", () => {
  expect(advance(state({ planned: true, iterations: 2 }), { _tag: "RunIteration" })).toEqual(
    state({ planned: true, iterations: 3 }),
  );
});

test("advance: Finish leaves state unchanged", () => {
  const s = state({ planned: true, iterations: 3 });
  const finish: Action = { _tag: "Finish", terminal: { _tag: "Complete" } };
  expect(advance(s, finish)).toEqual(s);
});

test("DEFAULT_SENTINELS are the documented tokens", () => {
  expect(DEFAULT_SENTINELS.completion).toBe("<promise>COMPLETE</promise>");
  expect(DEFAULT_SENTINELS.blockedTag).toBe("blocked");
});
