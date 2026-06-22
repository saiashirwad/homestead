import { Console, Effect, FileSystem, Path } from "effect";
import type { ResolvedLoop } from "./loop.ts";
import type { LoopPromptContext } from "./types.ts";

// The prompt logic for each loop stage, shipped as versioned Claude skills that
// githog seeds into a worktree at provision time (CONTEXT.md → "Skills"). The
// skill BODY is the single source of truth: the runner invokes the skill by name
// when its SKILL.md is present in the worktree, and falls back to the same text
// inline when it isn't (so githog works in a repo that never installed them).
// The task-file name and sentinel tokens are baked in from the resolved config so
// a hand-run skill and a headless run behave identically.

// These skills are only ever fired by githog (the loop invokes them by name) or by
// hand — never autonomously by the model mid-work — so they carry
// `disable-model-invocation: true`: zero per-turn context load, still callable as
// `/<name> <url>`. The `description` is therefore human-facing.
const frontmatter = (name: string, description: string, body: string): string =>
  `---\nname: ${name}\ndescription: ${description}\ndisable-model-invocation: true\n---\n\n${body}\n`;

// The on-disk task file's shape — the single source of truth shared by both skills,
// so the plan pass that WRITES it and the iteration that READS it can never drift.
// Each task is a **vertical slice**; its indented `- [ ]` lines are the slice's
// **acceptance criteria** — the iteration's checkable done-test.
const taskFormat = (loop: ResolvedLoop): string =>
  `\`\`\`
   # Plan: <issue title> (#<number>)

   - [ ] First vertical slice — a thin end-to-end path, demoable on its own
     - [ ] Acceptance criterion (observable, checkable)
     - [ ] Another acceptance criterion
   - [ ] Second vertical slice
     - [ ] Acceptance criterion
   \`\`\``;

// One line both skills emit, so the "read the project's own words first" rule has a
// single source of truth.
const vocabularyNote = "Read `CONTEXT.md` and any ADRs under `docs/adr/` touching this area first, so your task titles, code, and test names use the project's own vocabulary rather than invented synonyms.";

// --- skill bodies (parameterised by the resolved loop settings) -------------

const planBody = (loop: ResolvedLoop): string =>
  `You are running githog's **plan pass** for one GitHub issue. You PLAN ONLY — write
no production code, tests, or other files in this pass.

You are given an issue URL as the argument. Steps:

1. Read the issue: \`gh issue view <url>\` (and its comments if useful). ${vocabularyNote}
2. Decompose the issue into **tracer bullets** — thin **vertical slices** that each
   cut end-to-end through every layer they touch (schema, logic, CLI/UI, tests),
   small enough to finish and verify in a single iteration, and ordered so each
   builds on the last. A slice is demoable or verifiable on its own; prefer end-to-end
   slices over horizontal layers. If a slice gets easier after a refactor, make that
   refactor its own first slice — make the change easy, then make the easy change.
3. Give every task **acceptance criteria**: a short checklist of observable conditions
   that prove the slice is done. They are the iteration's done-test, so make each one
   checkable (an agent can tell done from not-done) and together exhaustive for the
   slice. Write the list to \`${loop.taskFile}\` at the repo root in this exact shape:

   ${taskFormat(loop)}

4. Do NOT commit \`${loop.taskFile}\` — githog git-ignores it; it is loop scaffolding,
   not part of the change. Just leave it written on disk.

If the issue is too ambiguous to decompose without a decision only a human can make,
emit \`<${loop.sentinels.blockedTag}>your question here</${loop.sentinels.blockedTag}>\` and stop.`;

const implementBody = (loop: ResolvedLoop): string =>
  `You are running ONE iteration of githog's **agent loop** for a GitHub issue
(URL given as the argument). The loop has **amnesia**: every iteration starts from a
CLEAN context, so the on-disk \`${loop.taskFile}\` is your only memory of what is
already done. Each task there is a **vertical slice** whose indented \`- [ ]\` lines
are its acceptance criteria.

Do exactly one slice, then stop:

1. Read \`${loop.taskFile}\`. Pick the **first task with unchecked acceptance criteria**.
   ${vocabularyNote}
2. Implement ONLY that slice — keep it small and focused. Where the slice is testable,
   work test-first: write ONE failing test that pins the behavior, then the minimal code
   to make it pass (a tracer bullet). Don't write the whole suite up front.
3. Verify against the slice's acceptance criteria: run typecheck + the tests covering
   your change, and confirm each criterion actually holds. If a check fails and the cause
   isn't obvious, run \`/diagnose\` rather than guessing. Don't continue while red.
4. Commit your work with a message describing the slice.
5. Tick every acceptance criterion you satisfied (\`- [ ]\` → \`- [x]\`), and the task
   itself once all its criteria are checked. Do NOT commit \`${loop.taskFile}\` (git-ignored
   scaffolding); just save it.

Then end THIS iteration:

- If every task and criterion is now checked, you MUST review the whole diff before
  finishing — do not skip this: run \`/code-review\` and address what it surfaces. (If
  that skill isn't available here, review the diff yourself for bugs and obvious
  cleanups.) Then run the full test suite once. ONLY when the review is clean AND the
  suite passes, emit the completion sentinel exactly: \`${loop.sentinels.completion}\`
- If you hit a decision you cannot make on your own (ambiguous spec, missing credential,
  a destructive or irreversible choice), emit
  \`<${loop.sentinels.blockedTag}>your question here</${loop.sentinels.blockedTag}>\`
  and stop — do not guess.
- Otherwise just stop; githog starts the next iteration with a fresh context.

One slice per iteration — resist finishing the next task, even a tempting small one. The
clean context next iteration is what keeps each slice sharp.`;

const planDoc = (loop: ResolvedLoop, name: string): string =>
  frontmatter(name, "githog plan pass: decompose an issue into a vertical-slice task list with acceptance criteria (plan only)", planBody(loop));

const implementDoc = (loop: ResolvedLoop, name: string): string =>
  frontmatter(name, "githog agent-loop iteration: implement the next vertical slice from the task list", implementBody(loop));

const skillPath = (path: Path.Path, targetDir: string, name: string): string =>
  path.join(targetDir, ".claude", "skills", name, "SKILL.md");

// True when the worktree already carries the skill's SKILL.md — a repo that
// committed or customised it wins over githog's bundled default.
export const skillPresent = Effect.fn("githog/skills/present")(function* (targetDir: string, name: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fs
    .exists(skillPath(path, targetDir, name))
    .pipe(Effect.catchCause(() => Effect.succeed(false)));
});

// Write the bundled plan/implement skills into a repo's .claude/skills, skipping
// any the repo already provides. Called by `githog init` (once, on the default
// branch) so worktrees inherit the skills already-committed and never carry them in
// an issue branch's diff. Best-effort: a write failure warns and continues (the
// runner's inline fallback still works for a repo that never ran init).
export const writeSkills = Effect.fn("githog/skills/write")(function* (targetDir: string, loop: ResolvedLoop) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const skills: ReadonlyArray<readonly [string, string]> = [
    [loop.planSkill, planDoc(loop, loop.planSkill)],
    [loop.implementSkill, implementDoc(loop, loop.implementSkill)],
  ];

  for (const [name, doc] of skills) {
    const file = skillPath(path, targetDir, name);
    const exists = yield* fs.exists(file).pipe(Effect.catchCause(() => Effect.succeed(false)));
    if (exists) continue;
    yield* Effect.gen(function* () {
      yield* fs.makeDirectory(path.dirname(file), { recursive: true });
      yield* fs.writeFileString(file, doc);
      yield* Console.log(`  ✓ seeded skill ${name} -> ${file}`);
    }).pipe(Effect.catchCause(() => Console.log(`  ⚠ could not seed skill ${name} (continuing)`)));
  }
});

// --- prompt builders (pure) -------------------------------------------------
// When the skill is present we invoke it by name (parity with a hand-run
// \`/${name} <url>\`); otherwise we inline the full instructions so the loop works
// with no skills installed.

const inline = (header: string, body: string): string => `${header}\n\n${body}`;

export const planPrompt = (skillName: string, present: boolean, ctx: LoopPromptContext): string =>
  present
    ? `/${skillName} ${ctx.item.url}`
    : inline(
        `Plan GitHub issue ${ctx.item.url}. Write the task list to ${ctx.taskFile}.`,
        planBody({
          maxIterations: 0,
          sentinels: { completion: ctx.completionSentinel, blockedTag: ctx.blockedTag },
          planSkill: skillName,
          implementSkill: skillName,
          taskFile: ctx.taskFile,
          resume: false,
        }),
      );

export const iterationPrompt = (skillName: string, present: boolean, ctx: LoopPromptContext): string =>
  present
    ? `/${skillName} ${ctx.item.url}`
    : inline(
        `Work the next task for GitHub issue ${ctx.item.url}. The task list is in ${ctx.taskFile}.`,
        implementBody({
          maxIterations: 0,
          sentinels: { completion: ctx.completionSentinel, blockedTag: ctx.blockedTag },
          planSkill: skillName,
          implementSkill: skillName,
          taskFile: ctx.taskFile,
          resume: false,
        }),
      );
