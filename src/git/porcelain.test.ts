import { expect, test } from "bun:test";
import { parseWorktreePorcelain, worktreePathForBranch } from "./porcelain.ts";

const SAMPLE_PORCELAIN = [
  "worktree /Users/dev/repos/githog",
  "HEAD abc123",
  "branch refs/heads/main",
  "",
  "worktree /Users/dev/worktrees/githog/feat_a",
  "HEAD def456",
  "branch refs/heads/feat/a",
  "",
  "worktree /Users/dev/worktrees/githog/feat_b",
  "HEAD 789ghi",
  "detached",
].join("\n");

test("parseWorktreePorcelain extracts path and branch", () => {
  expect(parseWorktreePorcelain(SAMPLE_PORCELAIN)).toEqual([
    { path: "/Users/dev/repos/githog", branch: "main" },
    { path: "/Users/dev/worktrees/githog/feat_a", branch: "feat/a" },
    { path: "/Users/dev/worktrees/githog/feat_b", branch: undefined },
  ]);
  expect(parseWorktreePorcelain("")).toEqual([]);
});

test("parseWorktreePorcelain paths", () => {
  expect(parseWorktreePorcelain(SAMPLE_PORCELAIN).map((entry) => entry.path)).toEqual([
    "/Users/dev/repos/githog",
    "/Users/dev/worktrees/githog/feat_a",
    "/Users/dev/worktrees/githog/feat_b",
  ]);
  expect(parseWorktreePorcelain("").map((entry) => entry.path)).toEqual([]);
});

test("worktreePathForBranch finds path by branch name", () => {
  expect(worktreePathForBranch(SAMPLE_PORCELAIN, "feat/a")).toBe("/Users/dev/worktrees/githog/feat_a");
  expect(worktreePathForBranch(SAMPLE_PORCELAIN, "missing")).toBeUndefined();
});
