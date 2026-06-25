---
name: homestead-local-complete
description: Use when the user wants to land/finish/integrate a local branch (e.g. "/homestead-local-complete 92", "complete branch 84", "merge and finish off this branch") — merges it into main, verifies, and runs `homestead complete`.
---

# homestead-local-complete

## Overview

Land a finished local branch: merge it into `main`, verify (typecheck + tests), then run `homestead complete <branch>` to close the issue and tear down the branch + worktree. Does NOT push `main` — that stays a manual step.

Invoked as `/homestead-local-complete <branch-name>` (branch name doubles as the issue number).

**Core rule — the destructive step is gated:** `homestead complete` deletes the branch locally AND on the remote, removes the worktree, and closes the GitHub issue. It is effectively irreversible. NEVER run it unless typecheck AND tests are green. If anything fails, STOP and report — do not complete.

## Steps

1. **Inspect divergence + cleanliness.** Confirm the branch exists and see how it relates to `main`:
   ```
   git log --oneline main..<branch>          # commits to land
   git log --oneline <branch>..main          # 0 = fast-forward; >0 = real merge
   git -C <worktree-path> status --short      # branch worktree clean?
   git status --short                         # main worktree clean?
   ```
   Find the worktree path with `git worktree list`.

2. **Merge into main.** From the primary checkout on `main`:
   - Fast-forward when `<branch>..main` is empty: `git merge --ff-only <branch>`
   - Otherwise a merge commit: `git merge --no-edit <branch>`
   - A merge that reports conflicts → resolve them, then continue. Do not run any later step until the tree is clean.

3. **Typecheck — MANDATORY, even on a "clean" merge.** A conflict-free *text* merge can still break the build when one branch renamed/deleted a symbol another branch still uses (a *semantic* merge conflict). Run the project's typecheck. If it fails because of the merge, fix it and fold the fix into the merge commit so history stays bisectable:
   ```
   git add <fixed-files> && git commit --amend --no-edit
   ```

4. **Tests.** Run the suite covering the changed area; run the full suite when the change is cross-cutting or you're unsure. Green is required.

5. **Complete.** Only now: `homestead complete <branch>`. It closes the issue, deletes the branch (local + remote), and removes the worktree. This does not push `main` — leave that to the user.

## Discovering this project's verify commands

Before merging, figure out how *this* repo typechecks and tests. In order of preference:

- `CLAUDE.md` / `AGENTS.md` — often states the exact commands.
- `package.json` `scripts` — look for `typecheck`, `check`, `test`, `lint` (and the package manager: `bun`, `pnpm`, `npm`, `yarn`).
- The project's run config / CI workflow files (`.github/workflows/*`).

Common shapes: `bun run typecheck && bun test`, `pnpm turbo run typecheck`, `npm run check`. If a suite needs services up (a database, etc.) or a migration applied after merge, do that before running tests.

## Red flags — STOP, do not run `homestead complete`

- Typecheck failed (including new errors that only appear after the merge)
- Any test failed, or you skipped tests because "the merge looked clean"
- Merge left conflict markers / the working tree isn't clean
- You can't find the branch or its worktree

Any of these → report what failed and stop. Completing on a red build closes the issue and destroys the branch with broken code on `main`.

## Common mistakes

| Mistake | Fix |
|---------|-----|
| Trusting a conflict-free merge | Always typecheck — text-clean ≠ compiles. |
| Leaving the conflict fix as a separate commit | `git commit --amend --no-edit` folds it into the merge. |
| Auto-pushing `main` | Don't — pushing stays a manual step the user runs themselves. |
| Forgetting a new migration | Apply it against the dev DB after merging, before tests. |
