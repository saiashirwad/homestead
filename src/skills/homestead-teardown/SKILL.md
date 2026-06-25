---
name: homestead-teardown
description: Use when the user wants to tear down a homestead branch/worktree — triggers on the verbs "close", "kill", "complete" or intent like "I'm done with issue 42", "clean this up", "scrap this branch". Picks the right verb and gates the irreversible one (`complete`) before anything runs.
---

# homestead-teardown

## Overview

Homestead has three teardown verbs and they do very different things. Mixing them up is the #1 footgun, because **`complete` is irreversible** — it closes the GitHub issue, deletes the branch locally AND on the remote, and removes the worktree. There is no undo.

This skill makes you **state the blast radius back to the user and get explicit confirmation** before running a destructive verb. It does NOT run anything on its own initiative.

## Blast-radius decision table

| Verb | Branch | Worktree | Issue | Reversible? |
|---|---|---|---|---|
| `close` | kept | kept | → review label | **yes** |
| `kill` | kept | removed | labels reversed | **yes** |
| `complete` | deleted local **+ remote** | removed | closed | **NO** |

- **`close`** — the gentlest. Nothing is destroyed; the issue just moves to a review label. Use when the work is up for review and you want to step away without losing anything.
- **`kill`** — abandon the attempt. Worktree removed and labels reversed, but the branch is kept so you can come back. Reversible, but it does delete the worktree — confirm first.
- **`complete`** — the work is landed and you are done forever. Closes the issue and destroys the branch everywhere. **Irreversible — always confirm.**

## The gate

1. **Restate the blast radius.** Before running `kill` or `complete`, tell the user in plain terms exactly what will be destroyed (quote the relevant row of the table). Name the branch/issue.
2. **Require explicit human confirmation** for `kill` and `complete`. A vague "clean this up" is NOT confirmation to run `complete` — ask which verb they mean. `close` is safe to run once the user clearly asked for it.
3. **Never auto-chain `complete`.** Do not run `complete` as an automatic follow-up to merging, reviewing, or any other step. It is always its own deliberate, confirmed action.

When unsure which verb the user wants, default to asking — and if they describe "I'm done but might revisit", they almost certainly mean `kill` or `close`, not `complete`. **"Did you mean `kill`?"** is the right reflex.

## PR-vs-issue nuance — do not delete someone else's branch

Branch deletion is hard-floored on **tracking state**, not on the verb (see `src/teardown.ts`):

- The **issue flow** writes tracking state when it creates a worktree. `kill`/`complete` only delete the **remote** branch when that tracking state exists.
- **PR review** worktrees never write tracking state. So on a PR-review worktree, the **author's branch will NOT be deleted** — local-branch removal still applies to your checkout, but the remote head branch is safe. No flag overrides this floor.

Consequences:

- **Never reach for `complete` on someone else's PR.** You are not landing their issue; completing it makes no sense and the safety only protects the remote branch, not the issue state.
- Do not assume `kill`/`complete` will delete a remote branch — on a PR-review worktree it deliberately won't.
- `--keep-remote` is an *additional* opt-out (skips remote deletion even for your own tracked branches); the tracking-state floor sits underneath it regardless.

## Landing a finished branch — defer, don't duplicate

If the user wants to **land** a finished local branch (merge into `main`, verify, then complete), that is a separate, build-gated flow. **Use the `homestead-local-complete` skill** — it gates `complete` on a green typecheck + test run. Do not re-implement that merge/verify path here.

This skill is the broader "which verb, and did you mean `kill`?" guard that runs before any teardown. `homestead-local-complete` is the specific green-build merge-and-complete path.
