# 4. Launch an interactive agent and drive it by hand, not a headless loop

Date: 2026-06-25

## Status

Accepted

Supersedes [1. homestead drives a headless agent loop](0001-homestead-driven-agent-loop.md),
[2. structured signal and resume toggle](0002-structured-signal-and-resume-toggle.md), and
[3. adversarial review-converge gate](0003-adversarial-review-converge-gate.md).

## Context

ADR-0001 replaced the original "launch an interactive agent, type one prompt, walk away"
model with a headless **agent loop**: homestead re-invoked `claude -p` per iteration with a
clean context, parsed its stream-json for completion/blocked sentinels, and drove a plan →
build → review-converge state machine until a PR opened. ADR-0002 and ADR-0003 layered
resume-continuity and an adversarial review gate on top.

In practice the headless loop was the wrong shape for how this gets used. The loop's whole
reason to exist was **unattended, concurrent** operation — a `listen` daemon draining a
backlog overnight — but the actual workflow is a human sitting down to drive a few issues
and approving the important decisions in person. Watching the scrollback of a Ralph-style
loop is a poor substitute for being in the session. Meanwhile the [superpowers](https://github.com/obra/superpowers)
workflow (brainstorm → spec → plan → subagent-driven build, with human approval gates) is a
far better engine for issue → shipped code than the bespoke plan/implement/review skills —
and it is explicitly built for interactive human sessions.

## Decision

homestead is a **launcher**, not a factory. For each issue it:

1. provisions the worktree (unchanged),
2. opens a herdr surface at it,
3. boots an **interactive** coding agent in that pane (config-driven: `command`,
   `readyMarker`, optional `trustPrompt`),
4. polls the pane until the REPL is ready and types a **kickoff prompt** once.

Then it steps away. The human drives the whole session by hand in herdr — typically the
superpowers workflow, approving at each gate. homestead re-enters only at `close` (finalize:
tear down the worktree/surface, keep the branch, move the issue to `agent:review`) or `kill`
(reverse everything).

The agent is config-blind: an `AgentConfig` (launch argv + ready/trust markers) plus a
`prompt(ctx)` callback is all it takes to swap Claude for Codex/OpenCode or change the
kickoff. The launch mechanics live in a small typed Effect wrapper over the herdr CLI
(`src/herdr/effect.ts` + `src/herdr/launch.ts`), validated against Claude Code in a real
pane (including the fresh-dir trust prompt).

### Removed

The entire headless engine: the agent-loop runner and state machine, stream-json sentinel
parsing, resume continuity, the review-converge gate (machine gate + fresh-context
reviewer), the `homestead-plan`/`-implement`/`-review` skills, the `listen` daemon and its
TUI dashboard, and the `loop`/`listen`/`implement-issues`-fan-as-daemon surface. Triggering
is manual only (`homestead <issue>...`).

## Consequences

- **Simpler.** One launch path, no sentinels, no parsing of agent output, no two engines to
  keep in step. homestead never reads the agent's *work* output — only the ready marker once.
- **Human-in-the-loop by design.** Hard decisions surface to the person in the session
  instead of being guessed or grepped from a stream. The quality gate is the human plus
  superpowers' own gates, not a bespoke reviewer pass.
- **No unattended runs.** This is a deliberate trade: the overnight-factory aspiration is
  gone. If it ever comes back, it returns as a separate concern, not by reviving the loop.
- **Agent-agnostic.** Any interactive coding agent that boots to a prompt works, via config.
