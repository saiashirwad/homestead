# 2. Structured completion signal and an opt-in context-continuity toggle

Date: 2026-06-22

## Status

Accepted (extends [ADR-0001](0001-homestead-driven-agent-loop.md), does not supersede it)

## Context

ADR-0001 gave homestead a per-issue agent loop driven by headless re-invocation. Two
properties of that first cut were worth revisiting:

1. **The completion signal was a substring grep over raw stdout.** The runner ran
   `claude -p <prompt>`, accumulated every line of the (noisy, tool-use-laden) output,
   and searched the whole blob for `<promise>COMPLETE</promise>` / `<blocked>`. That is
   fragile: the sentinel can appear inside quoted tool output or a diff the agent prints,
   and there is no structured handle on "the agent's final answer" vs "everything it
   typed along the way."

2. **Amnesia was hard-wired.** Every iteration was a fresh process with no memory but the
   on-disk task file. That clean-context discipline is the source of the loop's quality
   (ADR-0001), but it is not obviously right for *every* project or issue — some work
   benefits from the agent carrying its own context forward. There was no way to even try
   the alternative without a rewrite.

We considered the larger move — a persistent interactive claude session per worktree that
homestead drives step-by-step over a live channel (Agent SDK, in-process session host). That
is a coherent direction but a different loop philosophy and a substantial rewrite: it
trades away the per-issue process isolation, the herdr-pane-per-issue watchability, and
the `ps`-based liveness check that `listen` relies on. We deferred it until we know
continuity is actually worth having.

## Decision

Two changes, both inside the existing spawn-per-iteration shape (no new dependency, no
change to the process/pane/crash-isolation model):

- **Structured signal.** Invocations run with `--output-format stream-json --verbose`.
  `captureAgent` (process.ts) parses the NDJSON event envelope: it re-emits each assistant
  text block live so the run still scrolls watchably in the herdr pane, and captures the
  final `result` text, the `session_id`, and a coarse stop reason. The loop parses the
  clean `result` for sentinels rather than the whole stream — same sentinel contract, far
  less chance of a false match. If no `result` event arrives (e.g. a crash mid-turn) it
  falls back to the streamed assistant text so the loop still has something to parse.

- **Opt-in continuity.** A new `agent.loop.resume` flag (default `false`). When `false`,
  behaviour is exactly ADR-0001 amnesia — every invocation a fresh context. When `true`,
  the runner captures the session id from each invocation and passes `--resume <id>` to the
  next, so the agent continues the same conversation across the plan pass and every
  iteration. The decision is two pure, unit-tested functions in loop.ts: `resumeArg`
  (whether/what to resume) and `rememberSession` (fold the reported id into state, keeping
  the latest non-empty id so it stays correct whether claude continues or forks the id).

Because amnesia and continuity now differ only by the presence of `--resume`, a project can
A/B the two on real issues by flipping one config flag.

## Consequences

- The completion/blocked signal is read from the agent's structured final result, not a
  grep over interleaved tool output — the weakest part of the ADR-0001 runner is gone.
- Amnesia remains the default, so every existing config behaves identically. Continuity is
  a per-project opt-in, not a fork in the codebase.
- `stream-json` requires `--verbose`; both flags are added by the runner, not the user.
- The persistent interactive-session model (homestead hosting live sessions and pushing each
  step in) is explicitly **not** adopted here. If the resume toggle shows continuity earns
  its keep, that becomes the next ADR — with the isolation/watchability costs paid
  deliberately rather than by accident.
