# 3. Adversarial review-converge gate before PR

Date: 2026-06-22

## Status

Accepted (extends [ADR-0001](0001-homestead-driven-agent-loop.md) and [ADR-0002](0002-structured-signal-and-resume-toggle.md), supersedes neither)

## Context

ADR-0001 gave homestead a per-issue agent loop; ADR-0002 made the completion signal
structured and added an opt-in resume toggle. In both, when the builder agent finishes
it **grades its own exam**: the implement skill asks the agent to self-review its diff
(`/code-review`) and run the tests, then emit `<promise>COMPLETE</promise>`. homestead
trusts that sentinel — it squashes, pushes, and opens a PR.

Two weaknesses follow from that:

1. **No invigilator.** The agent that wrote the code is the same agent (and, under
   resume, the same context) that judges it, so it rationalises its own shortcuts —
   placeholder logic, lazy error handling, untested edges.
2. **The "tests passed" claim is agent-reported, not machine-checked.** A slipped or
   skipped suite still produces a green `COMPLETE`.

The result is PRs that look finished but carry defects a fresh, hostile reviewer — or a
real test run — would have caught.

## Decision

Interpose a **review-converge cycle** between a builder `Complete` and `Finish Complete`,
gated by two checks homestead itself enforces:

- **A deterministic machine gate.** homestead runs a configured `verifyCommand` (the
  project's typecheck/test) via `runExit` and reads the exit code directly. A pure
  `gateVerdict(exitCode, command)` maps it: `0` → gate-green, non-zero → gate-red
  carrying a reason. A red gate is never "complete", whatever the agent claimed.
- **A fresh-context adversarial review.** homestead spawns a separate `RunReview` pass over
  the whole diff in a clean context — always with no `--resume`, even under `resume:true`
  (the one deliberate carve-out to ADR-0002 continuity: the reviewer must not share
  history with the builder or it drifts toward endorsing the author's choices). A new
  `homestead-review` skill reads the issue, the task file, and the diff; runs the checks;
  hunts placeholder/lazy/untested/weak-logic defects against the slice acceptance
  criteria; then emits a clean signal (`<review>CLEAN</review>`) or appends fix tasks and
  emits a findings signal (`<review>FINDINGS</review>`). A genuine human-only question
  reuses the existing `<blocked>` path.

The state machine lives in the pure core (`loop.ts`), so every transition is unit-tested
without spawning claude/git/gh:

```
Complete  (builder)         -> RunGate            (RunReview directly if no verifyCommand)
GateRed                     -> RunIteration        (failure appended as a fix task)
GateGreen                   -> RunReview
Findings  (review)          -> RunIteration        (reviewer appended fix tasks)
Clean     (review)          -> Finish Complete
Blocked   (review or build) -> Finish Blocked
reviewRounds >= cap         -> Finish Blocked      ("review did not converge")
```

`LoopState` gains a `reviewRounds` counter; `ResolvedLoop` gains a `maxReviewRounds` cap
(default 3) that backstops the review phase the way `maxIterations` backstops the build
phase — the two compose, neither runs unbounded.

**Carrying findings across the amnesia boundary.** Rather than invent a second memory
channel, both the reviewer and a gate failure append their findings to the task file as
new vertical-slice tasks with acceptance criteria — the same shape the plan pass writes.
The next `RunIteration` picks them up naturally, making `RunReview` symmetric with
`RunPlan`: plan decomposes the *issue*, review decomposes the *defects*. Review-fix
commits fold into the single PR commit via the unchanged `squashToOne`.

The whole feature is **opt-in via `agent.loop.review` and off by default**: with
`review: false`, a builder `Complete` opens the PR exactly as before.

## Consequences

- A green `COMPLETE` can no longer open a PR over a red/skipped suite, and defects the
  builder rationalised away get a hostile second pass before reaching the review queue.
- Existing configs are byte-for-byte unchanged until they opt in. The implement skill's
  self-review is retained as a cheap first pass but is explicitly no longer the
  authoritative gate.
- Review is the single intentional exception to resume continuity — always fresh context.
- Cost is bounded: each round adds one machine-gate run plus one fresh-context review
  invocation, capped by `maxReviewRounds` (and the build phase by `maxIterations`).
- Explicitly **not** adopted: formal/mathematical verification, multi-reviewer vote
  ensembles, per-finding skeptic sub-agents, direct hallucination detection, and the
  reviewer posting PR comments (it fixes in-tree via fix tasks). These are later
  evolutions if the single-reviewer gate proves its keep.
