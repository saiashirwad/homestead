import { expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { emit, teardownEvents, type HomesteadEvent } from "./events.ts";
import { runAfterTeardown, runBeforeTeardown } from "./hooks.ts";
import { makeContext } from "./context.ts";
import { HerdrTest } from "./herdr/test.ts";

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
