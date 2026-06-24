# 1. homestead drives a headless agent loop instead of an interactive agent

Date: 2026-06-22

## Status

Accepted

## Context

Until now, homestead provisioned a worktree, opened a herdr pane, launched `claude`
interactively, waited for a ready marker, and typed a single prompt (e.g.
`/implement <url>`). After sending that one prompt, homestead was hands-off — herdr owned
the live interactive process and homestead never observed the agent's output again.

This "launch once and forget" model has no quality floor and no completion signal: the
agent gets one shot in one context window, and there is no way for homestead to know whether
the issue was finished, to react to it, or to introspect what happened. We want a
"software factory" that can work issues unattended and hand back reviewable results.

## Decision

homestead owns a **agent loop** per issue: the agent is re-invoked headlessly with a clean
context each **iteration** until the issue is done.

- A **plan pass** runs first — a one-shot headless invocation that decomposes the issue
  into an atomic **task list** committed to the worktree. The task list is the
  cross-iteration memory and doubles as the progress log.
- Each **iteration** is a fresh headless invocation that picks the next incomplete task,
  implements it, runs its own checks, commits, and marks the task done.
- The loop stops when the agent emits a **completion sentinel**
  (`<promise>COMPLETE</promise>`); homestead then opens a PR and moves the issue to
  `agent:review`. An iteration cap or an agent-emitted `<blocked>` sentinel moves it to
  `agent:blocked` instead.
- The loop is a single mechanism: headless re-invocation. It runs *inside* the herdr pane
  so it can be watched live, but the pane is a window, not a driver — there is no separate
  interactive execution path.
- The loop proceeds autonomously: the committed plan is visible (in the pane and as an
  issue comment) but does not block on human approval, so the `listen` daemon stays
  walk-away. Human review happens at the PR, not before the loop.

## Consequences

- homestead becomes a stateful orchestrator that observes agent output, not just a launcher.
  It must parse a noisy output stream for sentinels — fiddlier than typing one prompt.
- Clean-context-per-iteration (the source of the loop's quality) holds for free, because
  every iteration is a fresh process.
- The factory is introspectable: homestead sees every iteration and can log it.
- A bad task decomposition is not caught until PR/blocked time, since there is no plan
  gate. This is an accepted cost of true unattended operation; the iteration cap and PR
  review are the safety nets.
- The previous `agent.prompt` / ready-marker interactive model is superseded. Prompt logic
  moves into shipped skills (`/homestead-plan`, `/homestead-implement`) seeded into the worktree.
