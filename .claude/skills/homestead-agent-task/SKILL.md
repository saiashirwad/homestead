---
name: homestead-agent-task
description: Use when you are an agent that homestead dispatched into a worktree to implement a single issue — the contract for how to behave in here: scope to this one issue, run the verify gate before claiming done, write the `.homestead/agent-status.json` sentinel as your last action, and commit but never merge.
---

# homestead-agent-task

## Overview

You are a coding agent that homestead checked out into an **isolated git worktree** to implement exactly **one** GitHub issue. This skill is the contract for how you behave while you're in here. Four rules, most important first:

1. **Scope** strictly to this one issue.
2. **Verify** — run the check and confirm it's green before you ever claim "done".
3. **Sentinel** — write `.homestead/agent-status.json` as your final action.
4. **Commit, do NOT merge.**

Read the rest before you start working. The rules exist because an orchestrator outside this worktree is coordinating sibling worktrees against yours; breaking scope or integrating early corrupts work you can't see.

## 1. Scope strictly to this one issue

Implement exactly the dispatched issue — nothing more. Do **not** drive-by-fix unrelated code you happen to notice, do not touch sibling worktrees, do not reach into `main`. The orchestrator schedules worktrees in collision-aware waves based on which files each issue declares it touches; work that strays outside your issue silently overlaps another agent's files and breaks that scheduling. If you find a real problem outside your scope, note it in your summary — don't fix it.

## 2. Run the verify gate before claiming "done"

Before you write a `"done"` status, run the project's check and confirm it **exits 0**. The default is:

```
bun run check
```

If this repo configures `agent.check` in `homestead.config.ts`, run that command instead. If the repo plainly uses something else (look at `CLAUDE.md` / `AGENTS.md` or `package.json` scripts), use that. Either way: **"done" means *verified* done, not "I think it's done."** A clean textual diff is not a green build — only the check passing tells you the change is actually correct. If the check fails and you can't make it pass, your status is `"failed"` or `"blocked"`, not `"done"`.

## 3. Write the status sentinel as your last action

The very last thing you do is write `.homestead/agent-status.json` (relative to this worktree root) with exactly this shape:

```json
{ "status": "done" | "blocked" | "failed", "summary": "<one short paragraph, plain English, what you did and the current state>" }
```

- `status` is one of exactly three values: **`done`** (only after the verify gate is green), **`blocked`** (a human decision or external dependency is genuinely required), **`failed`** (you tried and could not finish).
- `summary` is a plain-English paragraph: what you did and where things stand.
- Optional: `details` (longer notes) and `at` (an ISO-8601 timestamp). Both are best-effort; omit them if you have nothing useful to add.

Write it **last**, after everything else including your commit — homestead's `agent wait` blocks on this file, so writing it is what tells the orchestrator you're finished. The file lives under `.homestead/`, which is gitignored: **never commit it.**

## 4. Commit, do NOT merge

Commit your work on this worktree's branch, then stop.

- **Stage explicitly** — list the files you changed (`git add path/one path/two`). **Never `git add -A` / `git add .`**: a homestead worktree can have embedded worktree checkouts under it (e.g. `.claude/worktrees/`), and a blanket add sweeps those nested repos into your commit.
- **Do not integrate.** Do not merge to `main`, do not run `homestead complete` or `homestead land`, do not push `main`. Integration happens *outside* this worktree — the orchestrator merges your branch on its own schedule, after its own verify gate. Landing your own work from in here races that and skips the gate.

## Where this sits in the lifecycle — read this honestly

This skill is the **human-readable contract** and a **best-effort nudge**. It is not the enforcement, and it doesn't claim to be:

- In **autonomous mode**, the harness owns the outcome: after you exit, it runs the check and writes the authoritative `.homestead/agent-status.json` deterministically via `homestead agent finalize`. Your own sentinel and summary are a fallback the harness can preserve, not the source of truth.
- In the **non-autonomous / best-effort path**, this contract plus the inline instruction appended to your kickoff prompt are the only signals — so following it actually matters there.

A skill only helps agents that load skills. It raises adherence and documents the contract; it does not replace the deterministic harness. Follow it regardless: doing the four rules right is what makes the orchestrator able to trust the worktree it can't see inside.
