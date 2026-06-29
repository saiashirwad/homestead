---
name: homestead-triage
description: Use when the user asks what's running or what's stuck in homestead — "what's running?", "what's stuck?", "anything blocked/failed?", "show me the worktrees", "what needs attention" — to read the `homestead ls` dashboard and route each trouble signal to the right recovery command (`doctor` to diagnose, `gc` to reclaim) without skipping straight to a destructive step.
---

# homestead-triage

## Overview

`homestead ls` is the dashboard: one row per non-primary worktree. Each row is a **symptom, not a diagnosis** — your job is to read it correctly and route to the right recovery verb:

- **`homestead doctor`** — read-only auditor. Tells you *what's wrong*. `doctor --fix` repairs exactly one thing (see below).
- **`homestead gc`** — the reclaimer. Cleans up *what's abandoned*. **Dry-run until `--prune`.**

The one rule that prevents accidents: **never escalate from a dashboard read straight to a destructive command.** The path is always `ls` (read) → `doctor` (diagnose) → confirm with the user → `gc --prune` / `doctor --fix`. The destructive step is its own deliberate, confirmed action.

Two traps make this skill necessary:

1. **`AGENT=unknown` does NOT mean dead.** The agent's self-reported status file is only ~50% adherent in practice (project learnings #10). `unknown` means *absent or unparseable sentinel*, not "idle" or "crashed". Route it to checking the live pane, never to teardown.
2. **`complete` will surface-land machine-spawned work** unless you stop it. An `[auto]` row is *not your branch*.

## Reading the dashboard

`homestead ls` prints columns `SLUG  BRANCH  PORTS  DB  AGENT  PANE  ORIGIN`. (`ls --watch` / `-w` refreshes in place; still read-only.) What each column means:

| Column | Meaning |
|---|---|
| **SLUG** | The branch-slug key for the worktree. |
| **BRANCH** | The git branch, or **`(stale state)`** when the tracking file outlived its worktree (the worktree is gone — route to `gc`). |
| **PORTS** / **DB** | Keyed values read from the worktree's own `.env`; `—` when none. |
| **AGENT** | The agent's self-reported sentinel state — see the five states below. |
| **PANE** | The live herdr pane id, or `—`. |
| **ORIGIN** | Provenance: `you`, `[auto]`, or `[auto] <spawnedBy>` — see the provenance guard. |

**AGENT — all five states.** One of `running | done | blocked | failed | unknown`:

| State | Read it as | Route |
|---|---|---|
| `running` | Agent says it's still working. | Check the **PANE** to see live progress — don't tear down. |
| `done` | Agent reported success. | Verify, then land via the normal flow (defer to homestead-teardown / homestead-local-complete). |
| `blocked` | Agent needs a human decision or external dependency. | Read its summary; this needs *you*, not a recovery command. |
| `failed` | Agent tried and couldn't finish. | Read its summary; decide retry vs. abandon. Don't auto-reclaim. |
| `unknown` | ⚠ **Sentinel absent or unparseable — NOT dead.** The sentinel is only ~50% reliable. | Check the **PANE** for the real state. Never read `unknown` as "safe to delete". |

⚠ **`unknown` and `running` are never grounds for teardown.** Check the live pane first.

**PANE is ambiguous.** `—` means *either* no live pane *or* herdr is unavailable (the whole column degrades together). Don't infer "the agent is dead" from `—` alone — it can simply mean you're not running inside herdr.

**ORIGIN gates safe recovery.** `you` is your own work. `[auto]` / `[auto] <spawnedBy>` is machine-spawned (an `agent spawn` worktree) — *not your branch*. This column decides whether a teardown is safe to run unattended (see the provenance guard).

## Diagnose vs. reclaim

**`homestead doctor` — read-only diagnosis.** Audits four failure modes and changes nothing:

| Finding | Severity | What it means |
|---|---|---|
| Half-provisioned | **FAIL** | A crash left setup incomplete (`.env` present, but provisioning never finished). |
| Port conflict | **FAIL** | Two worktrees' `.env`s claim the same port value. |
| Live-bound port / untracked work | **WARN** | A port is in use, or an untracked worktree has uncommitted/unpushed changes. |
| Stale tracking state | **WARN** (global) | A state file points at a missing worktree. |

⚠ **`doctor --fix` repairs ONLY the half-provisioned case** — it re-runs the idempotent provisioning pipeline on those worktrees. It does **not** touch port conflicts, live-bound ports, or stale state. For everything else, `doctor` only tells you; it doesn't act.

**`homestead gc` — the reclaimer.** Removes orphaned worktrees (`worktree-gone` — the directory is gone), reclaims auto-created worktrees with no uncommitted/unpushed work (`auto-clean`), reverses GitHub WIP signals, and deletes stale state.

⚠ **`gc` is dry-run by default** — it prints a plan and changes nothing until you pass `--prune`. It deliberately **skips dirty/unpushed worktrees** as "still your live work" — it will never reclaim something with uncommitted or unpushed changes.

**The split to remember:** *doctor tells you what's wrong; gc cleans up what's abandoned; `--fix` is the one repair doctor itself performs.*

## Routing table — symptom → command

| What you see in `ls` (or `doctor`) | Route to |
|---|---|
| AGENT `blocked` / `failed` | Read the agent's summary — this needs a human. Not a recovery command. |
| AGENT `unknown` / `running` | Check the **PANE** for live state. **Never teardown on this alone.** |
| BRANCH shows `(stale state)` | `homestead gc` (dry-run) → confirm → `gc --prune`. |
| `doctor`: half-provisioned (FAIL) | `homestead doctor --fix`. |
| `doctor`: port conflict (FAIL) | `doctor` diagnoses only — resolve by hand or tear down the offending worktree. `--fix` won't touch it. |
| `doctor`: stale tracking state (WARN) | `homestead gc` → confirm → `gc --prune`. |
| Orphaned worktree (dir gone) / clean auto-work | `homestead gc` → confirm → `gc --prune`. |
| Auto-work that's dirty/unpushed | Leave it — `gc` skips it on purpose. Decide with the user. |

## The provenance guard (the one safety rule)

When recovery means tearing a worktree down, **ORIGIN decides which verb is safe** to run unattended:

- **`kill` is always allowed** on auto-work — it's reversible (keeps the branch), so there's no spawn gate to clear.
- **`complete` refuses** a machine-spawned (`[auto]`) branch unless you pass `--allow-spawned`, printing who spawned it and landing nothing.

So a row with `ORIGIN=[auto] …` is **not your branch**: route its teardown to `kill`, and treat a `complete` refusal as a real signal — **confirm with the user before ever passing `--allow-spawned`.** Never auto-pass it.

For the full destructive-verb gate (which verb destroys what, and the confirmation ritual), defer to the **homestead-teardown** skill — don't re-derive it here.

## Red flags — STOP

- About to run `gc --prune` straight off a dashboard read → **stop.** Run `gc` dry-run first, show the plan, get confirmation.
- About to run `complete --allow-spawned` to land an `[auto]` branch → **stop.** That's not your branch; confirm with the user first.
- Reading `AGENT=unknown` or `PANE=—` as "dead, safe to reclaim" → **wrong.** The sentinel is ~50% reliable and `—` can just mean no herdr. Check the live pane.
- Expecting `doctor --fix` to clear a port conflict or stale state → it won't. `--fix` only repairs half-provisioned worktrees.
- Reclaiming a dirty/unpushed auto-worktree → `gc` skips these on purpose; don't force it.
