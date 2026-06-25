import { expect, test } from "bun:test";
import { formatEvent } from "./events.ts";

test("teardown start/done match legacy lines", () => {
  expect(formatEvent({ type: "teardown", verb: "kill", branch: "b", phase: "start" })).toBe("\n▸ Killing 'b'");
  expect(formatEvent({ type: "teardown", verb: "kill", branch: "b", phase: "done" })).toBe("  ✓ killed 'b'");
  expect(formatEvent({ type: "teardown", verb: "close", branch: "b", phase: "done", reviewLabel: "agent:review" }))
    .toBe("  ✓ closed 'b' (branch kept, issue → agent:review)");
});

test("worktree.creating matches legacy", () => {
  expect(formatEvent({ type: "worktree.creating", branch: "b", targetDir: "/d" }))
    .toBe("\n▸ Creating worktree 'b' at /d");
});

test("issues.summary matches legacy (all vs partial)", () => {
  expect(formatEvent({ type: "issues.summary", launched: 2, total: 2 }))
    .toBe("\n✅ 2 agent(s) launched. Switch into the issue-* workspaces to drive them.");
  expect(formatEvent({ type: "issues.summary", launched: 1, total: 2 }))
    .toBe("\n✅ 1/2 agent(s) launched (1 skipped). Switch into the issue-* workspaces to drive them.");
});

test("agent.launching/launched match legacy", () => {
  expect(
    formatEvent({
      type: "agent.launching",
      item: { number: 3, url: "u", title: "t" } as any,
      command: ["claude"],
      worktreeDir: "/d",
    }),
  ).toBe("\n▸ Launching claude for issue #3 in /d");
  expect(
    formatEvent({
      type: "agent.launched",
      item: { number: 3, url: "u", title: "t" } as any,
      command: ["claude"],
      paneId: "p1",
      worktreeDir: "/d",
    }),
  ).toBe("  ✓ #3: claude launched in herdr pane p1 — switch in to drive it");
});

test("pr.launching/launched match legacy", () => {
  const pr = { number: 42, title: "Fix bug", url: "u" } as any;
  expect(formatEvent({ type: "pr.launching", pr, mode: "review", branch: "feat/x" }))
    .toBe("\n▸ Reviewing PR #42: Fix bug");
  expect(formatEvent({ type: "pr.launching", pr, mode: "work", branch: "feat/x" }))
    .toBe("\n▸ Continuing PR #42: Fix bug");
  expect(formatEvent({ type: "pr.launched", pr, mode: "review", branch: "feat/x", paneId: "p1" }))
    .toBe(
      "  ✓ PR #42 ready on `feat/x` in herdr pane p1 — switch in to drive it.\n" +
        "    Tear down with: homestead kill feat/x",
    );
  expect(formatEvent({ type: "pr.launched", pr, mode: "work", branch: "feat/x", paneId: "p1" }))
    .toBe(
      "  ✓ PR #42 ready on `feat/x` in herdr pane p1 — switch in to drive it.\n" +
        "    Tear down with: homestead close feat/x",
    );
});
