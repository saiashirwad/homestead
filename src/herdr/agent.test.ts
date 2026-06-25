import { expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { resolveSurfaceLabel, runAfterLaunch } from "./agent.ts";
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

test("surfaceLabel default issue/pr", () => {
  const issueCtx = { ...makeContext({ repoName: "r", slug: "s", branch: "b", worktreeDir: "/w", item: { number: 3, url: "u", title: "t" } as any }), kind: "issue" as const };
  expect(resolveSurfaceLabel(undefined, issueCtx)).toBe("issue-3");
  const prCtx = { ...makeContext({ repoName: "r", slug: "s", branch: "b", worktreeDir: "/w", pr: { number: 9 } as any }), kind: "pr" as const };
  expect(resolveSurfaceLabel(undefined, prCtx)).toBe("pr-9");
  expect(resolveSurfaceLabel((c) => `x-${c.kind}`, prCtx)).toBe("x-pr");
});

test("runAfterLaunch is a no-op when hook undefined", async () => {
  const ctx = makeContext({ repoName: "r", slug: "s", branch: "b", worktreeDir: "/w" });
  await Effect.runPromise(runAfterLaunch(undefined, ctx, "pane-1").pipe(Effect.provide(TestLayer)));
  expect(true).toBe(true);
});
