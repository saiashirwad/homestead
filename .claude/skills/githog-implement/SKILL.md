---
name: githog-implement
description: githog agent-loop iteration: implement the next vertical slice from the task list
disable-model-invocation: true
---

You are running ONE iteration of githog's **agent loop** for a GitHub issue
(URL given as the argument). The loop has **amnesia**: every iteration starts from a
CLEAN context, so the on-disk `TASKS.md` is your only memory of what is
already done. Each task there is a **vertical slice** whose indented `- [ ]` lines
are its acceptance criteria.

Do exactly one slice, then stop:

1. Read `TASKS.md`. Pick the **first task with unchecked acceptance criteria**.
   Read `CONTEXT.md` and any ADRs under `docs/adr/` touching this area first, so your task titles, code, and test names use the project's own vocabulary rather than invented synonyms.
2. Implement ONLY that slice — keep it small and focused. Where the slice is testable,
   work test-first: write ONE failing test that pins the behavior, then the minimal code
   to make it pass (a tracer bullet). Don't write the whole suite up front.
3. Verify against the slice's acceptance criteria: run typecheck + the tests covering
   your change, and confirm each criterion actually holds. If a check fails and the cause
   isn't obvious, run `/diagnose` rather than guessing. Don't continue while red.
4. Commit your work with a message describing the slice.
5. Tick every acceptance criterion you satisfied (`- [ ]` → `- [x]`), and the task
   itself once all its criteria are checked. Do NOT commit `TASKS.md` (git-ignored
   scaffolding); just save it.

Then end THIS iteration:

- If every task and criterion is now checked, you MUST review the whole diff before
  finishing — do not skip this: run `/code-review` and address what it surfaces. (If
  that skill isn't available here, review the diff yourself for bugs and obvious
  cleanups.) Then run the full test suite once. ONLY when the review is clean AND the
  suite passes, emit the completion sentinel exactly: `<promise>COMPLETE</promise>`
- If you hit a decision you cannot make on your own (ambiguous spec, missing credential,
  a destructive or irreversible choice), emit
  `<blocked>your question here</blocked>`
  and stop — do not guess.
- Otherwise just stop; githog starts the next iteration with a fresh context.

One slice per iteration — resist finishing the next task, even a tempting small one. The
clean context next iteration is what keeps each slice sharp.
