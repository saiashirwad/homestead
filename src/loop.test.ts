import { expect, test } from "bun:test";
import {
  advance,
  decide,
  DEFAULT_SENTINELS,
  gateVerdict,
  parseOutcome,
  parseReview,
  rememberSession,
  resolveLoopSettings,
  resumeArg,
  type Action,
  type LoopState,
  type Outcome,
  type ResolvedLoop,
} from "./loop.ts";

const state = (over: Partial<LoopState> = {}): LoopState => ({
  planned: false,
  iterations: 0,
  maxIterations: 5,
  review: false,
  gate: false,
  maxReviewRounds: 3,
  reviewRounds: 0,
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
  const sentinels = { ...DEFAULT_SENTINELS, completion: "##DONE##", blockedTag: "halt" };
  expect(parseOutcome("work ##DONE##", sentinels)).toEqual({ _tag: "Complete" });
  expect(parseOutcome("<halt>why</halt>", sentinels)).toEqual({ _tag: "Blocked", reason: "why" });
  // the default tokens are inert under custom sentinels
  expect(parseOutcome("<promise>COMPLETE</promise>", sentinels)).toEqual({ _tag: "Working" });
});

// --- parseReview (ADR-0003) -------------------------------------------------

test("parseReview: clean signal -> ReviewClean", () => {
  expect(parseReview("diff looks good <review>CLEAN</review>")).toEqual({ _tag: "ReviewClean" });
});

test("parseReview: findings signal -> ReviewFindings", () => {
  expect(parseReview("appended 2 fix tasks <review>FINDINGS</review>")).toEqual({ _tag: "ReviewFindings" });
});

test("parseReview: blocked wins over a clean signal (defined precedence)", () => {
  expect(parseReview("<review>CLEAN</review>\n<blocked>which schema is canonical?</blocked>")).toEqual({
    _tag: "Blocked",
    reason: "which schema is canonical?",
  });
});

test("parseReview: findings wins over clean (conservative — don't ship)", () => {
  expect(parseReview("<review>CLEAN</review> but also <review>FINDINGS</review>")).toEqual({
    _tag: "ReviewFindings",
  });
});

test("parseReview: no recognizable signal -> Blocked (never guess clean)", () => {
  const out = parseReview("I looked at the diff and have opinions");
  expect(out._tag).toBe("Blocked");
  if (out._tag === "Blocked") expect(out.reason).toContain("no recognizable signal");
});

test("parseReview: honours custom sentinels", () => {
  const sentinels = { ...DEFAULT_SENTINELS, reviewClean: "##OK##", reviewFindings: "##FIX##" };
  expect(parseReview("##OK##", sentinels)).toEqual({ _tag: "ReviewClean" });
  expect(parseReview("##FIX##", sentinels)).toEqual({ _tag: "ReviewFindings" });
});

// --- gateVerdict (ADR-0003) -------------------------------------------------

test("gateVerdict: exit 0 -> GateGreen", () => {
  expect(gateVerdict(0, ["bun", "test"])).toEqual({ _tag: "GateGreen" });
});

test("gateVerdict: non-zero -> GateRed carrying a reason that names the command", () => {
  const out = gateVerdict(1, ["bun", "run", "typecheck"]);
  expect(out._tag).toBe("GateRed");
  if (out._tag === "GateRed") {
    expect(out.reason).toContain("bun run typecheck");
    expect(out.reason).toContain("1");
  }
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

// --- decide: review-converge cycle (ADR-0003) -------------------------------

const built = (over: Partial<LoopState> = {}): LoopState => state({ planned: true, ...over });

test("decide: review OFF -> Complete finishes immediately (regression, unchanged)", () => {
  expect(decide(built({ review: false }), { _tag: "Complete" })).toEqual({
    _tag: "Finish",
    terminal: { _tag: "Complete" },
  });
});

test("decide: review ON + gate configured -> Complete routes to RunGate", () => {
  expect(decide(built({ review: true, gate: true }), { _tag: "Complete" })).toEqual({ _tag: "RunGate" });
});

test("decide: review ON, no verifyCommand -> Complete routes straight to RunReview", () => {
  expect(decide(built({ review: true, gate: false }), { _tag: "Complete" })).toEqual({ _tag: "RunReview" });
});

test("decide: GateGreen -> RunReview", () => {
  expect(decide(built({ review: true, gate: true }), { _tag: "GateGreen" })).toEqual({ _tag: "RunReview" });
});

test("decide: GateRed -> RunIteration (failure becomes a fix task)", () => {
  expect(decide(built({ review: true, gate: true }), { _tag: "GateRed", reason: "tsc failed" })).toEqual({
    _tag: "RunIteration",
  });
});

test("decide: review Findings -> RunIteration", () => {
  expect(decide(built({ review: true }), { _tag: "ReviewFindings" })).toEqual({ _tag: "RunIteration" });
});

test("decide: review Clean -> Finish(Complete)", () => {
  expect(decide(built({ review: true }), { _tag: "ReviewClean" })).toEqual({
    _tag: "Finish",
    terminal: { _tag: "Complete" },
  });
});

test("decide: review Blocked -> Finish(Blocked) carrying the reason", () => {
  expect(decide(built({ review: true }), { _tag: "Blocked", reason: "ambiguous spec" })).toEqual({
    _tag: "Finish",
    terminal: { _tag: "Blocked", reason: "ambiguous spec" },
  });
});

test("decide: reviewRounds at cap on a green gate -> Finish(Blocked) 'did not converge'", () => {
  const action = decide(built({ review: true, gate: true, reviewRounds: 3, maxReviewRounds: 3 }), {
    _tag: "GateGreen",
  });
  expect(action._tag).toBe("Finish");
  if (action._tag === "Finish") {
    expect(action.terminal._tag).toBe("Blocked");
    if (action.terminal._tag === "Blocked") expect(action.terminal.reason).toContain("did not converge");
  }
});

test("decide: convergence cap also applies on a review-only Complete", () => {
  const action = decide(built({ review: true, gate: false, reviewRounds: 3, maxReviewRounds: 3 }), {
    _tag: "Complete",
  });
  expect(action._tag).toBe("Finish");
  if (action._tag === "Finish") expect(action.terminal._tag).toBe("Blocked");
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

test("advance: RunReview increments the review-round count (ADR-0003)", () => {
  expect(advance(state({ planned: true, reviewRounds: 1 }), { _tag: "RunReview" })).toEqual(
    state({ planned: true, reviewRounds: 2 }),
  );
});

test("advance: RunGate leaves state unchanged (it just runs a command)", () => {
  const s = state({ planned: true, reviewRounds: 1 });
  expect(advance(s, { _tag: "RunGate" })).toEqual(s);
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

// --- continuity (ADR-0002): resolveLoopSettings / resumeArg / rememberSession ---

const resolved = (over: Partial<ResolvedLoop> = {}): ResolvedLoop => ({
  maxIterations: 5,
  sentinels: DEFAULT_SENTINELS,
  planSkill: "homestead-plan",
  implementSkill: "homestead-implement",
  taskFile: "TASKS.md",
  resume: false,
  review: false,
  verifyCommand: undefined,
  reviewSkill: "homestead-review",
  maxReviewRounds: 3,
  ...over,
});

test("resolveLoopSettings: resume defaults to false (amnesia per ADR-0001)", () => {
  expect(resolveLoopSettings().resume).toBe(false);
  expect(resolveLoopSettings({}).resume).toBe(false);
  expect(resolveLoopSettings({ resume: true }).resume).toBe(true);
});

test("resolveLoopSettings: review-converge defaults are today's behaviour (ADR-0003)", () => {
  const r = resolveLoopSettings();
  expect(r.review).toBe(false);
  expect(r.verifyCommand).toBeUndefined();
  expect(r.reviewSkill).toBe("homestead-review");
  expect(r.maxReviewRounds).toBe(3);
  expect(r.sentinels.reviewClean).toBe("<review>CLEAN</review>");
  expect(r.sentinels.reviewFindings).toBe("<review>FINDINGS</review>");
});

test("resolveLoopSettings: review-converge knobs are overridable", () => {
  const r = resolveLoopSettings({
    review: true,
    verifyCommand: ["bun", "test"],
    reviewSkill: "my-review",
    maxReviewRounds: 5,
  });
  expect(r.review).toBe(true);
  expect(r.verifyCommand).toEqual(["bun", "test"]);
  expect(r.reviewSkill).toBe("my-review");
  expect(r.maxReviewRounds).toBe(5);
});

test("resumeArg: amnesia mode never resumes, even with a session id", () => {
  expect(resumeArg(state({ sessionId: "sess-1" }), resolved({ resume: false }))).toEqual([]);
});

test("resumeArg: a review pass never resumes, even under resume:true with a known session (VDD carve-out)", () => {
  expect(resumeArg(state({ sessionId: "sess-1" }), resolved({ resume: true }), true)).toEqual([]);
  // sanity: the same state/settings DO resume for a non-review invocation
  expect(resumeArg(state({ sessionId: "sess-1" }), resolved({ resume: true }), false)).toEqual([
    "--resume",
    "sess-1",
  ]);
});

test("resumeArg: resume mode omits on the first invocation (no session yet)", () => {
  expect(resumeArg(state(), resolved({ resume: true }))).toEqual([]);
  expect(resumeArg(state({ sessionId: undefined }), resolved({ resume: true }))).toEqual([]);
});

test("resumeArg: resume mode carries --resume once a session id is known", () => {
  expect(resumeArg(state({ sessionId: "sess-1" }), resolved({ resume: true }))).toEqual([
    "--resume",
    "sess-1",
  ]);
});

test("rememberSession: keeps the latest non-empty id, ignores undefined/empty", () => {
  expect(rememberSession(state(), "sess-1").sessionId).toBe("sess-1");
  // a later invocation forked a new id -> follow it
  expect(rememberSession(state({ sessionId: "sess-1" }), "sess-2").sessionId).toBe("sess-2");
  // no id reported -> keep the prior one (don't clobber)
  expect(rememberSession(state({ sessionId: "sess-1" }), undefined).sessionId).toBe("sess-1");
  expect(rememberSession(state({ sessionId: "sess-1" }), "").sessionId).toBe("sess-1");
});

test("rememberSession: preserves the rest of the state", () => {
  const s = state({ planned: true, iterations: 3 });
  expect(rememberSession(s, "sess-9")).toEqual({ ...s, sessionId: "sess-9" });
});
