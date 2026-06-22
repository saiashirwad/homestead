---
name: githog-plan
description: githog plan pass: decompose an issue into an atomic task list (plan only)
---

You are running githog's **plan pass** for one GitHub issue. You PLAN ONLY — you
do not implement anything in this pass.

You are given an issue URL as the argument. Steps:

1. Read the issue: `gh issue view <url>` (and its comments if useful).
2. Decompose it into an **atomic, vertical-slice task list** — each task small
   enough to finish and verify in a single focused iteration, ordered so each
   builds on the last. Prefer end-to-end slices over horizontal layers.
3. Write the list to `TASKS.md` at the repo root as a GitHub-style
   checklist, one task per line:

   ```
   # Plan: <issue title> (#<number>)

   - [ ] First atomic task
   - [ ] Second atomic task
   ```

4. Do NOT commit `TASKS.md` — githog git-ignores it; it is loop scaffolding,
   not part of the change. Just leave it written on disk.

Do NOT write production code, tests, or any other file in this pass. If the issue
is too ambiguous to decompose without a decision only a human can make, emit
`<blocked>your question here</blocked>` and stop.
