import { expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { runBeforeTeardown, runAfterTeardown } from "./teardown.ts";
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
