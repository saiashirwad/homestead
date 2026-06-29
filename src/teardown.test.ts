import { expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { TestConsole } from "effect/testing";
import { emit, teardownEvents, type HomesteadEvent } from "./events.ts";
import { runAfterTeardown, runBeforeTeardown } from "./hooks.ts";
import { makeContext } from "./context.ts";
import { HerdrError } from "./herdr/errors.ts";
import { HerdrTest, HerdrTestHandle } from "./herdr/test.ts";
import { removeHerdrWorktree } from "./teardown.ts";

const TestLayer = Layer.provideMerge(HerdrTest, BunServices.layer);

test("runBeforeTeardown passes verb + tracked", async () => {
  const seen: Array<{ verb: string; tracked: boolean }> = [];
  const hook = (c: { verb: string; tracked: boolean }) =>
    Effect.sync(() => seen.push({ verb: c.verb, tracked: c.tracked }));
  const ctx = makeContext({ repoName: "r", slug: "b", branch: "b", worktreeDir: "/w" });
  await Effect.runPromise(runBeforeTeardown(hook, ctx, "kill", false).pipe(Effect.provide(TestLayer)));
  expect(seen).toEqual([{ verb: "kill", tracked: false }]);
});

test("runAfterTeardown no-op when undefined", async () => {
  const ctx = makeContext({ repoName: "r", slug: "b", branch: "b", worktreeDir: "/w" });
  await Effect.runPromise(runAfterTeardown(undefined, ctx, "close", "agent:review").pipe(Effect.provide(TestLayer)));
  expect(true).toBe(true);
});

test("runAfterTeardown awaits a Promise-returning hook (no effect import needed)", async () => {
  const seen: string[] = [];
  // A plain async hook — the shape a self-contained config uses when it can't
  // import `effect`. normalizeHookResult must await it before teardown proceeds.
  const hook = async (c: { verb: string }) => {
    await Promise.resolve();
    seen.push(c.verb);
  };
  const ctx = makeContext({ repoName: "r", slug: "b", branch: "b", worktreeDir: "/w" });
  await Effect.runPromise(runAfterTeardown(hook, ctx, "kill").pipe(Effect.provide(TestLayer)));
  expect(seen).toEqual(["kill"]);
});

test("runAfterTeardown ignores a non-thenable return", async () => {
  const ctx = makeContext({ repoName: "r", slug: "b", branch: "b", worktreeDir: "/w" });
  // Returning undefined/void must not crash the `yield*` in teardown.
  await Effect.runPromise(runAfterTeardown(() => undefined, ctx, "kill").pipe(Effect.provide(TestLayer)));
  expect(true).toBe(true);
});

test("teardownEvents constructs start/done pairs", () => {
  expect(teardownEvents("kill", "feat/x", "start")).toEqual({
    type: "teardown",
    verb: "kill",
    branch: "feat/x",
    phase: "start",
  });
  expect(teardownEvents("kill", "feat/x", "done")).toEqual({
    type: "teardown",
    verb: "kill",
    branch: "feat/x",
    phase: "done",
  });
  expect(teardownEvents("close", "feat/x", "done", "agent:review")).toEqual({
    type: "teardown",
    verb: "close",
    branch: "feat/x",
    phase: "done",
    reviewLabel: "agent:review",
  });
});

test("removeHerdrWorktree surfaces a failed remove (op + cause) and does not abort teardown", async () => {
  const PRIMARY = "/repo/primary";
  const BRANCH = "feat/x";

  const program = Effect.gen(function* () {
    const handle = yield* HerdrTestHandle;
    yield* handle.setWorktrees(PRIMARY, [{ branch: BRANCH, open_workspace_id: "ws-7" }]);
    yield* handle.failRemove(new HerdrError({ op: "worktree.remove", cause: "herdr exited 1: socket closed" }));
    // If the HerdrError were not caught, this effect would fail and the test
    // would reject — proving control reaches the git-side teardown that follows.
    yield* removeHerdrWorktree(PRIMARY, BRANCH);
    return yield* TestConsole.logLines;
  });

  const lines = await Effect.runPromise(
    program.pipe(Effect.provide(Layer.mergeAll(HerdrTest, BunServices.layer, TestConsole.layer))),
  );
  const text = lines.map((l) => (Array.isArray(l) ? l.join(" ") : String(l))).join("\n");

  expect(text).toContain("op=worktree.remove");
  expect(text).toContain("herdr exited 1: socket closed");
  expect(text).toContain("herdr worktree list");
});

test("emit delivers teardown events to custom onEvent", async () => {
  const events: HomesteadEvent[] = [];
  const onEvent = (e: HomesteadEvent) => Effect.sync(() => void events.push(e));
  await Effect.runPromise(emit(onEvent, teardownEvents("kill", "b", "start")).pipe(Effect.provide(TestLayer)));
  await Effect.runPromise(emit(onEvent, teardownEvents("kill", "b", "done")).pipe(Effect.provide(TestLayer)));
  expect(events).toEqual([
    { type: "teardown", verb: "kill", branch: "b", phase: "start" },
    { type: "teardown", verb: "kill", branch: "b", phase: "done" },
  ]);
});
