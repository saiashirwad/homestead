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

const frontmatter = (name: string, description: string, body: string): string =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

// --- skill bodies (parameterised by the resolved loop settings) -------------

const planBody = (loop: ResolvedLoop): string =>
  `You are running githog's **plan pass** for one GitHub issue. You PLAN ONLY — you
do not implement anything in this pass.

You are given an issue URL as the argument. Steps:

1. Read the issue: \`gh issue view <url>\` (and its comments if useful).
2. Decompose it into an **atomic, vertical-slice task list** — each task small
   enough to finish and verify in a single focused iteration, ordered so each
   builds on the last. Prefer end-to-end slices over horizontal layers.
3. Write the list to \`${loop.taskFile}\` at the repo root as a GitHub-style
   checklist, one task per line:

   \`\`\`
   # Plan: <issue title> (#<number>)

   - [ ] First atomic task
   - [ ] Second atomic task
   \`\`\`

4. Do NOT commit \`${loop.taskFile}\` — githog git-ignores it; it is loop scaffolding,
   not part of the change. Just leave it written on disk.

Do NOT write production code, tests, or any other file in this pass. If the issue
is too ambiguous to decompose without a decision only a human can make, emit
\`<${loop.sentinels.blockedTag}>your question here</${loop.sentinels.blockedTag}>\` and stop.`;

const implementBody = (loop: ResolvedLoop): string =>
  `You are running ONE iteration of githog's **Ralph loop** for a GitHub issue
(URL given as the argument). Every iteration starts with a CLEAN context, so the
on-disk \`${loop.taskFile}\` is your only memory of what is already done.

Do exactly one task, then stop:

1. Read \`${loop.taskFile}\`. Pick the **first unchecked** \`- [ ]\` task.
2. Implement ONLY that task. Keep the change small and focused.
3. Run the relevant checks (typecheck + the tests touching your change). Fix what
   you broke before continuing.
4. Commit your work with a message describing the task.
5. Mark the task done — change its \`- [ ]\` to \`- [x]\` in \`${loop.taskFile}\`.
   Do NOT commit \`${loop.taskFile}\` (it is git-ignored loop scaffolding); just save it.

Then decide how to end THIS iteration:

- If every task is now checked AND the issue is fully satisfied, run the full
  test suite once; if it passes, emit the completion sentinel exactly:
  \`${loop.sentinels.completion}\`
- If you hit a decision you cannot make on your own (ambiguous spec, missing
  credential, a destructive or irreversible choice), emit
  \`<${loop.sentinels.blockedTag}>your question here</${loop.sentinels.blockedTag}>\`
  and stop — do not guess.
- Otherwise just stop; githog will start the next iteration with a fresh context.

Do NOT try to finish multiple tasks in one iteration — one task per pass keeps the
loop's context clean.`;

const planDoc = (loop: ResolvedLoop, name: string): string =>
  frontmatter(name, "githog plan pass: decompose an issue into an atomic task list (plan only)", planBody(loop));

const implementDoc = (loop: ResolvedLoop, name: string): string =>
  frontmatter(name, "githog Ralph-loop iteration: implement the next task from the task list", implementBody(loop));

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
        }),
      );
