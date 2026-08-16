import { expect, test } from "bun:test";
import { Effect } from "effect";
import { GitTest, GitTestHandle } from "../../src/git/test.ts";
import { branchFromOriginHead, resolveDefaultBaseRef } from "../../src/worktree/base-ref.ts";

test("branchFromOriginHead strips origin/ prefix", () => {
  expect(branchFromOriginHead("origin/main")).toBe("main");
  expect(branchFromOriginHead("origin/master")).toBe("master");
});

test("branchFromOriginHead passes through refs without origin/ prefix", () => {
  expect(branchFromOriginHead("main")).toBe("main");
  expect(branchFromOriginHead("develop")).toBe("develop");
});

test("resolveDefaultBaseRef: uses origin/HEAD when present", async () => {
  const branch = await Effect.runPromise(
    Effect.gen(function* () {
      const handle = yield* GitTestHandle;
      yield* handle.setSymbolicRef("/repo", "refs/remotes/origin/HEAD", "origin/trunk");
      return yield* resolveDefaultBaseRef("/repo");
    }).pipe(Effect.provide(GitTest)),
  );
  expect(branch).toBe("trunk");
});

test("resolveDefaultBaseRef: falls back to main when origin/HEAD absent", async () => {
  const branch = await Effect.runPromise(
    Effect.gen(function* () {
      const handle = yield* GitTestHandle;
      yield* handle.setRefExists("/repo", "refs/heads/main", true);
      return yield* resolveDefaultBaseRef("/repo");
    }).pipe(Effect.provide(GitTest)),
  );
  expect(branch).toBe("main");
});
