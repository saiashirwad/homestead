import { expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { runAfterLaunch } from "./agent.ts";
import { makeContext } from "../context.ts";
import { HerdrTest } from "./test.ts";

const TestLayer = Layer.provideMerge(HerdrTest, BunServices.layer);

test("runAfterLaunch calls hook with paneId when present", async () => {
  const seen: string[] = [];
  const hook = (c: { paneId: string }) => Effect.sync(() => {
    seen.push(c.paneId);
  });
  const ctx = makeContext({ repoName: "r", slug: "s", branch: "b", worktreeDir: "/w" });
  await Effect.runPromise(runAfterLaunch(hook, ctx, "pane-1").pipe(Effect.provide(TestLayer)));
  expect(seen).toEqual(["pane-1"]);
});

test("runAfterLaunch is a no-op when hook undefined", async () => {
  const ctx = makeContext({ repoName: "r", slug: "s", branch: "b", worktreeDir: "/w" });
  await Effect.runPromise(runAfterLaunch(undefined, ctx, "pane-1").pipe(Effect.provide(TestLayer)));
  expect(true).toBe(true);
});
