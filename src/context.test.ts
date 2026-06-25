import { expect, test } from "bun:test";
import { makeContext } from "./context.ts";

test("makeContext fills required fields and defaults env to undefined-returning", () => {
  const ctx = makeContext({ repoName: "githog", slug: "feat-x", branch: "feat-x", worktreeDir: "/tmp/wt" });
  expect(ctx.repoName).toBe("githog");
  expect(ctx.worktreeDir).toBe("/tmp/wt");
  expect(ctx.item).toBeUndefined();
  expect(ctx.pr).toBeUndefined();
  expect(ctx.env("ANY")).toBeUndefined();
});

test("makeContext passes through item, pr, and env accessor", () => {
  const env = (k: string) => (k === "PORT" ? "3000" : undefined);
  const item = { number: 7, url: "u", title: "t" } as const;
  const ctx = makeContext({ repoName: "r", slug: "s", branch: "b", worktreeDir: "/w", item, env });
  expect(ctx.item).toBe(item);
  expect(ctx.env("PORT")).toBe("3000");
});
