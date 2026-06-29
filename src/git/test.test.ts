import { expect, test } from "bun:test";
import { Effect } from "effect";
import { Git } from "./service.ts";
import { GitTest, GitTestHandle } from "./test.ts";

test("GitTest stages a merge conflict and journals the abort", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const handle = yield* GitTestHandle;
      const git = yield* Git;
      yield* handle.setMergeResult("/repo", "feature", { _tag: "Conflict", files: ["src/a.ts"] });

      const result = yield* git.merge("/repo", "feature");
      yield* git.abortMerge("/repo");

      expect(result).toEqual({ _tag: "Conflict", files: ["src/a.ts"] });
      const journal = yield* handle.journal();
      expect(journal.merges).toEqual([{ cwd: "/repo", branch: "feature" }]);
      expect(journal.aborts).toEqual(["/repo"]);
    }).pipe(Effect.provide(GitTest)),
  );
});

test("GitTest stages refExists and symbolicRef responses", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const handle = yield* GitTestHandle;
      const git = yield* Git;
      yield* handle.setRefExists("/repo", "refs/heads/main", true);
      yield* handle.setSymbolicRef("/repo", "refs/remotes/origin/HEAD", "origin/main");

      expect(yield* git.refExists("/repo", "refs/heads/main")).toBe(true);
      expect(yield* git.refExists("/repo", "refs/heads/other")).toBe(false);
      expect(yield* git.symbolicRef("/repo", "refs/remotes/origin/HEAD")).toBe("origin/main");
      expect(yield* git.symbolicRef("/repo", "refs/remotes/origin/HEAD2")).toBeUndefined();
    }).pipe(Effect.provide(GitTest)),
  );
});
