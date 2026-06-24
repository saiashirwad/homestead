import { expect, test } from "bun:test";
import { Effect } from "effect";
import { launchAndSeed, toSpec } from "./launch.ts";
import { Herdr } from "./service.ts";
import { HerdrTest, HerdrTestHandle } from "./test.ts";
import { resolveAgentDefaults } from "../types.ts";

test("toSpec applies mechanical agent defaults", () => {
  const spec = toSpec({});
  expect(spec.command).toBe("claude");
  expect(spec.readyMarker).toBe("❯");
  expect(spec.trustPrompt).toBeUndefined();
});

test("toSpec trustPrompt false disables trust gate", () => {
  const spec = toSpec({ command: ["claude"], trustPrompt: false });
  expect(spec.trustPrompt).toBeUndefined();
});

test("toSpec preserves explicit trust prompt", () => {
  const spec = toSpec({
    command: ["my-agent"],
    trustPrompt: { marker: "allow?", confirm: ["y", "Enter"] },
  });
  expect(spec.trustPrompt).toEqual({ marker: "allow?", confirm: ["y", "Enter"] });
});

test("resolveAgentDefaults applies Claude trust gate", () => {
  const agent = resolveAgentDefaults({});
  expect(agent.trustPrompt).toEqual({ marker: "trust this folder", confirm: ["Enter"] });
  expect(agent.prompt).toBeTypeOf("function");
});

test("resolveAgentDefaults skips trust gate for non-claude agents", () => {
  const agent = resolveAgentDefaults({ command: ["cursor", "agent"] });
  expect(agent.trustPrompt).toBeUndefined();
});

test("resolveAgentDefaults trustPrompt false disables trust gate", () => {
  const agent = resolveAgentDefaults({ command: ["claude"], trustPrompt: false });
  expect(agent.trustPrompt).toBe(false);
});

const fastLaunch = {
  bootSettleMs: 0,
  submitPauseMs: 0,
  pollMs: 1,
  trustTimeoutMs: 200,
  readyTimeoutMs: 200,
} as const;

test("launchAndSeed clears trust gate then seeds prompt", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const handle = yield* HerdrTestHandle;
      const herdr = yield* Herdr;
      const paneId = yield* herdr.createSurface("worktree", "/tmp/wt", "issue-1");
      yield* handle.script(paneId, ["trust this folder?", "", "❯ "]);

      yield* launchAndSeed(
        paneId,
        toSpec({
          command: ["claude"],
          trustPrompt: { marker: "trust this folder", confirm: ["Enter"] },
        }),
        "kickoff",
        fastLaunch,
      );

      const journal = yield* handle.journal();
      expect(journal.runs).toEqual([{ paneId, command: "claude", args: [] }]);
      expect(journal.sendText).toEqual([{ paneId, text: "kickoff" }]);
      expect(journal.sendKeys).toEqual([
        { paneId, keys: ["Enter"] },
        { paneId, keys: ["Enter"] },
      ]);
    }).pipe(Effect.provide(HerdrTest)),
  );
});

test("launchAndSeed skips trust gate when marker never appears", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const handle = yield* HerdrTestHandle;
      const herdr = yield* Herdr;
      const paneId = yield* herdr.createSurface("worktree", "/tmp/wt", "issue-2");
      yield* handle.script(paneId, ["❯ "]);

      yield* launchAndSeed(
        paneId,
        toSpec({
          command: ["claude"],
          trustPrompt: { marker: "trust this folder", confirm: ["Enter"] },
        }),
        "kickoff",
        fastLaunch,
      );

      const journal = yield* handle.journal();
      expect(journal.sendKeys).toEqual([{ paneId, keys: ["Enter"] }]);
    }).pipe(Effect.provide(HerdrTest)),
  );
});

test("launchAndSeed fails when ready marker never appears", async () => {
  const run = Effect.gen(function* () {
    const handle = yield* HerdrTestHandle;
    const herdr = yield* Herdr;
    const paneId = yield* herdr.createSurface("worktree", "/tmp/wt", "issue-3");
    yield* handle.script(paneId, ["booting..."]);

    yield* launchAndSeed(
      paneId,
      toSpec({ command: ["claude"], trustPrompt: false }),
      "kickoff",
      fastLaunch,
    );
  }).pipe(Effect.provide(HerdrTest));

  await expect(Effect.runPromise(run)).rejects.toMatchObject({ _tag: "HerdrTimeout" });
});
