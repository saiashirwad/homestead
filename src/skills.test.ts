import { expect, test } from "bun:test";
import { Effect, FileSystem, Path } from "effect";
import { BunServices } from "@effect/platform-bun";
import { resolveLoopSettings } from "./loop.ts";
import { NEW_ISSUE_SKILL, writeSkills } from "./skills.ts";

// Run an effect against the real Bun platform services (FileSystem + Path).
const run = <A, E>(eff: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
  Effect.runPromise(eff.pipe(Effect.provide(BunServices.layer)) as Effect.Effect<A, E, never>);

const seedAndRead = (readyLabel: string) =>
  run(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectory();
      yield* writeSkills(dir, resolveLoopSettings(), readyLabel);
      return yield* fs.readFileString(`${dir}/.claude/skills/${NEW_ISSUE_SKILL}/SKILL.md`);
    }),
  );

test("writeSkills: seeds the githog-new-issue skill with gh issue create and the default trigger label", async () => {
  const doc = await seedAndRead("agent:ready");
  expect(doc).toContain("gh issue create");
  expect(doc).toContain("agent:ready");
  // Model-invocable: it must NOT carry the loop skills' opt-out line.
  expect(doc).not.toContain("disable-model-invocation");
});

test("writeSkills: bakes an overridden trigger label into the seeded skill", async () => {
  const doc = await seedAndRead("queue:go");
  expect(doc).toContain("gh issue create");
  expect(doc).toContain("queue:go");
  expect(doc).not.toContain("agent:ready");
});

test("the committed githog-new-issue SKILL.md matches the seeded default byte-for-byte", async () => {
  const seeded = await seedAndRead("agent:ready");
  const committed = await run(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return yield* fs.readFileString(`.claude/skills/${NEW_ISSUE_SKILL}/SKILL.md`);
    }),
  );
  expect(committed).toBe(seeded);
});
