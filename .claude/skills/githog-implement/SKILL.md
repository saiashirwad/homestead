---
name: githog-implement
description: githog Ralph-loop iteration: implement the next task from the task list
---

You are running ONE iteration of githog's **Ralph loop** for a GitHub issue
(URL given as the argument). Every iteration starts with a CLEAN context, so the
on-disk `TASKS.md` is your only memory of what is already done.

Do exactly one task, then stop:

1. Read `TASKS.md`. Pick the **first unchecked** `- [ ]` task.
2. Implement ONLY that task. Keep the change small and focused.
3. Run the relevant checks (typecheck + the tests touching your change). Fix what
   you broke before continuing.
4. Commit your work with a message describing the task.
5. Mark the task done — change its `- [ ]` to `- [x]` in `TASKS.md`.
   Do NOT commit `TASKS.md` (it is git-ignored loop scaffolding); just save it.

Then decide how to end THIS iteration:

- If every task is now checked AND the issue is fully satisfied, run the full
  test suite once; if it passes, emit the completion sentinel exactly:
  `<promise>COMPLETE</promise>`
- If you hit a decision you cannot make on your own (ambiguous spec, missing
  credential, a destructive or irreversible choice), emit
  `<blocked>your question here</blocked>`
  and stop — do not guess.
- Otherwise just stop; githog will start the next iteration with a fresh context.

Do NOT try to finish multiple tasks in one iteration — one task per pass keeps the
loop's context clean.
