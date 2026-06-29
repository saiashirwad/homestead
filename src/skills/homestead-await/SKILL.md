---
name: homestead-await
description: Use after dispatching one or more coding agents, when you need to wait for an agent and act on its result — e.g. "wait for these agents", "are the agents done", "did the fan-out finish", "what happened with the agent I launched". Reads `homestead agent wait`'s 0/1/2/3 exit code as a decision contract so you never treat an unknown result as success.
---

# homestead-await

## Overview

You dispatched a coding agent into a worktree. This skill is the guard that runs the moment you go to collect its result: it turns `homestead agent wait`'s exit code into a decision so you never do the dangerous thing — poll until the command returns and treat any non-crash as "done."

**The one rule everything hangs off:** only an exit `0` from a *trustworthy* signal means land. Every other code (`1`, `2`, `3`) means **stop and do something other than land**. Exit `3` in particular is *no signal at all* — never success.

This skill is pure judgment over an already-built command. It runs *before* `homestead-local-complete` (which does the actual green-build merge) — it decides whether you're even allowed to get there.

## The command

One command, always the same shape. Always pass `--pane` (see below for why):

```
homestead agent wait <branch|issue#|url> --pane <paneId> --timeout 30m --poll 2s
# exit 0 done · 1 failed · 2 blocked · 3 no-signal
```

It blocks until the agent reaches an outcome, prints a one-line summary, and exits `0/1/2/3`. You branch on that code.

## The decision table — the spine

Read the exit code, then act. Do **not** improvise off the printed text; the **code** is the contract.

| Exit | Label (`statusLabel`) | What it means | What you do |
|---|---|---|---|
| **0** | `✅ done —` | Agent wrote a `done` sentinel — work complete *and it claims to have verified it* | **Land** — hand to `homestead-local-complete`. But first corroborate, unless autonomous (see below). |
| **1** | `❌ failed —` | Agent wrote `failed` — it tried and could not finish | **Retry or inspect the worktree.** Do **not** land. |
| **2** | `⏸ blocked —` | Agent wrote `blocked` — it hit a decision or dependency it can't resolve | **Escalate to a human.** A `blocked` is the agent saying "only a person can decide this." Never override it. |
| **3** | (no sentinel) | `no-signal`: the deadline elapsed (`timeout`) or the agent stopped without leaving a sentinel (`idle-pane`) | **Go look.** Still running, wedged, or it ignored the convention. **Never land.** |

The statuses `done`/`blocked`/`failed` are the only three an agent can write. The sentinel lives at `<worktree>/.homestead/agent-status.json`.

## Exit 3 is never "done"

This is why the codes are split `0/1/2/3` instead of the Unix default `0`-or-`1`. **`no-signal` is its own outcome — it is NOT success and NOT failure; it's "I have no trustworthy word from the agent."** Treating a `3` as done lands a branch off a coin-flip. The two `3` reasons:

- **`timeout`** — the wait deadline elapsed. The agent may still be working, may be wedged, or may have died silently. Go look at the pane / worktree before doing anything.
- **`idle-pane`** — the backstop tripped: herdr says the agent's pane stopped, but no sentinel was written. The agent finished *something* and left no word. Inspect the worktree to see what (if anything) it did.

Either way: **investigate, never land.**

## Always pass `--pane` — and why the backstop is trustworthy now

With `--pane <paneId>`, the wait gets a real second signal beyond the status file. It concludes "stopped without a sentinel" (`idle-pane`, exit 3) **only when herdr's structured `agent_status` reads `idle` or `done`** — not from any text on screen.

⚠️ **This used to be broken (#40 / finding #11).** The old backstop grepped pane text for the ready marker `❯`. But Claude Code's TUI *always* draws `❯`, even mid-work — so the text backstop fired against agents that were actively working and returned a false exit `3`. The fix reads herdr's `agent_status` instead, where only `idle`/`done` count as stopped (`working`, and a transient permission-prompt `blocked`, do not). `❯` is valid only as the *launch* signal ("the REPL is up, send the prompt"), never as an idle/done signal.

Practical consequence:

- **A pane-backed exit 3 is trustworthy** — it means "the agent genuinely stopped and left nothing." That's strong evidence to go inspect.
- **A no-pane exit 3 is weaker** — it's only "file-or-timeout," with no way to tell a still-running agent from a stopped one.

So **always pass `--pane`.** Without it you're flying on the timeout alone.

## Corroborate a non-autonomous `done` before landing (#41 / finding #10)

⚠️ **Exit 0 is not automatically safe to land.** The status sentinel is *best-effort*: in the wild, only ~50% of dispatched agents actually wrote it. A model "might" write the file as its last act — that's a request to the model, not a guarantee. So an exit `0` can come from a sentinel that happens to be there, not one you can trust.

The exception is **autonomous mode**, where `homestead agent finalize` writes the sentinel *deterministically* from the inner agent's exit code and the project's `check` command — not from the model's memory. That write is authoritative.

| Where the `done` came from | Trust | Action |
|---|---|---|
| **Autonomous mode** (`agent finalize` wrote it) | Authoritative | Land — hand to `homestead-local-complete`. |
| **Default / best-effort mode** (the model wrote it) | ~50% reliable | **Corroborate first:** glance at the worktree diff and herdr's pane status; confirm the work actually exists and the build looks sane. Only then land. |

This is the one piece that *can't* be a code change — it's a judgment about how much to trust a self-reported signal, which is exactly why it's a skill. **Outside autonomous mode, never auto-land on exit 0 alone.** That's deliberate friction: without it you land on a coin-flip.

## Hand off — don't reimplement the landing

On a trustworthy exit 0, this skill **defers** to `homestead-local-complete`, which does the real merge behind a green-build gate (typecheck + tests, then `homestead complete`). This skill does **not** merge, push, or close anything itself. It is the read-the-result guard that decides whether landing is even on the table.

## Red flags — STOP, do not land

- Exit was `1`, `2`, or `3` — anything but `0`. Only `0` is ever landable.
- Exit `3` (`timeout` or `idle-pane`) treated as "probably fine." It is *no signal* — go look.
- Exit `0` from a **non-autonomous** agent, landed without glancing at the worktree. Corroborate first.
- You ran `wait` **without `--pane`** and got a `3`, and you're inferring the agent stopped. You can't — that `3` is just "file-or-timeout."
- A `blocked` (exit 2) you're tempted to override and land anyway. Don't — escalate to a human.

## Common mistakes

| Mistake | Fix |
|---|---|
| Treating any non-crash return as "done" | Branch on the **exit code**, not on the command returning. Only `0` is land. |
| Reading exit `3` as success | `no-signal` is never done — investigate the pane/worktree. |
| Auto-landing every exit `0` | Corroborate a best-effort `done`; only autonomous-mode `done` is authoritative. |
| Running `wait` without `--pane` | Pass `--pane` so the idle backstop is real, not just a timeout. |
| This skill doing the merge | It doesn't — hand a trustworthy `0` to `homestead-local-complete`. |
