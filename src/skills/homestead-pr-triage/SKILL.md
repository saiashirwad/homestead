---
name: homestead-pr-triage
description: Use when the user wants to look at someone's pull request via homestead (e.g. "review PR 42", "continue PR 42", or a pasted GitHub PR URL) — disambiguates `homestead review` (read-only) from `homestead pr` (continue + push), and sets the "this is not your branch" posture.
---

# homestead-pr-triage

## Overview

Two homestead verbs pull a PR into a worktree and they look interchangeable, but they are not:

- **`homestead review <PR>`** — pull the PR into a worktree so Claude can **summarize it and run the checks. Read-only.** Do NOT edit, commit, or push.
- **`homestead pr <PR>`** — check the PR out to **continue the work**: read what's done, run checks, fix failures, address feedback, and **commit**. On a same-repo PR that means committing to the **author's own head branch**.

The mental model that prevents accidents: **this is not your branch.** Whichever verb you used, you've landed on someone else's HEAD. Pushing rewrites *their* work, and teardown treats these worktrees differently from your own issue branches (see below).

## Which verb? (pick from the user's intent)

| The user said… | Verb | What you may do |
|---|---|---|
| "review PR 42", "take a look at this PR", "what does this PR do" | `homestead review 42` | Summarize + run checks. **No edits, no commits, no push.** |
| "continue PR 42", "finish this PR", "fix the failing checks on PR 42" | `homestead pr 42` | Read, run checks, then keep working and **commit**. |

When in doubt, prefer `review` — it can't damage anything. Only reach for `pr` when the user clearly wants to *change* the PR.

## `review` — read-only posture

`homestead review` opens the worktree and asks Claude to (1) summarize what the PR does and why, (2) run the project's checks, (3) flag bugs/risks/gaps. That's the whole job. The prompt ends with **"Do not edit code — this is a review."** Honour it: no edits, no commits, no `git push`. If you spot something that needs fixing, report it — don't fix it.

## `pr` — continue posture (you're committing to someone else's branch)

`homestead pr` is for *changing* the PR. The critical detail is **where your commits land**:

- **Same-repo PR** → the worktree is attached to the PR's actual head branch (`headRefName`). Commit and push and you're pushing **straight to the author's branch** on the shared remote. That's the intended behaviour, but treat it with care: never force-push or rewrite history — homestead deliberately never force-resets this branch because the author may have **unpushed commits** on it. Add commits on top; don't rebase away their work.
- **Fork PR** → the worktree gets a throwaway local `pr-<N>` branch fetched from the pull ref. It is **not** pushed anywhere, so you can't push your continuation back to a fork this way. Useful for running/iterating locally; tell the user a fork PR can't be pushed back via homestead.

Always show your plan before large changes.

## Repo-mismatch failure mode

If you paste a **full GitHub PR URL** that points at a different repository than the one you're standing in, homestead refuses with an `IssueRepoMismatch` error:

> PR URL points at `owner/repo`, but you're in `here`. Run homestead from inside `owner/repo`, or pass the bare PR number.

Fix it one of two ways: `cd` into a checkout of the URL's repo and retry, **or** pass just the bare PR number (`homestead pr 42`) so it resolves against the repo you're already in. A bare number is always interpreted against the current repo.

## Teardown nuance — these worktrees are not torn down like your own

A PR worktree (from `review` or `pr`) writes **no homestead tracking state** — only the issue flow does. Teardown has a **hard floor: it only ever deletes a remote branch it owns** (one with tracking state). So:

- `homestead kill` / `homestead complete` on a PR worktree will remove the worktree but will **NOT delete the PR author's remote head branch** — even on a same-repo PR. That guard has no override flag; it's there precisely so you can't nuke an author's branch.
- The local branch may still be deleted, but the remote stays. That's correct and intended.

If a **homestead-teardown** skill is installed (in `.claude/skills/`), consult it for the full destructive-verb rules; otherwise the guard above is the rule that matters here.

## Red flags — STOP

- About to `git commit`/`git push` during a `homestead review` → don't. Review is read-only.
- About to `git push --force` / rebase on a `homestead pr` same-repo branch → don't. You'd rewrite the author's history.
- Trying to push a continuation back to a **fork** PR → not possible via homestead; report it instead.
- A pasted PR URL errored with a repo mismatch → cd into the right repo or use the bare number; don't work around it.
