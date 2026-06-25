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
