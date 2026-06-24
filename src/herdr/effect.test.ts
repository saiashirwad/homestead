import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { matcher, openWorkspaceIdForBranch, WorktreeListSchema } from "./types.ts";

test("matcher substring vs regex", () => {
  const sub = matcher("hello", false);
  expect(sub("say hello world")).toBe(true);
  expect(sub("nope")).toBe(false);

  const re = matcher("^ready>", true);
  expect(re("ready> ok")).toBe(true);
  expect(re("not ready")).toBe(false);
});

test("openWorkspaceIdForBranch returns workspace id when branch matches", () => {
  const worktrees = [
    { branch: "main", open_workspace_id: "ws-main" },
    { branch: "42", open_workspace_id: "ws-42" },
  ];
  expect(openWorkspaceIdForBranch(worktrees, "42")).toBe("ws-42");
});

test("openWorkspaceIdForBranch returns undefined when branch absent", () => {
  const worktrees = [{ branch: "main", open_workspace_id: "ws-main" }];
  expect(openWorkspaceIdForBranch(worktrees, "missing")).toBeUndefined();
});

test("openWorkspaceIdForBranch returns undefined when open_workspace_id is null", () => {
  const worktrees = [{ branch: "42", open_workspace_id: null }];
  expect(openWorkspaceIdForBranch(worktrees, "42")).toBeUndefined();
});

test("WorktreeListSchema decodes herdr worktree list JSON", async () => {
  const json = JSON.stringify({
    result: {
      worktrees: [
        { branch: "42", open_workspace_id: "ws-42" },
        { branch: "main", open_workspace_id: null },
      ],
    },
  });
  const decoded = await Effect.runPromise(
    Schema.decodeUnknownEffect(Schema.fromJsonString(WorktreeListSchema))(json),
  );
  expect(openWorkspaceIdForBranch(decoded.result.worktrees, "42")).toBe("ws-42");
  expect(openWorkspaceIdForBranch(decoded.result.worktrees, "main")).toBeUndefined();
});
