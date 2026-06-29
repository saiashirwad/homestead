import { expect, test } from "bun:test";
import { exitCodeFor, type WaitOutcome } from "../../agent/wait.ts";
import type { AgentStatusFile } from "../../agent/status.ts";

// Drift guard for the homestead-await skill's decision table. The skill's whole
// value is the 0/1/2/3 → action mapping; if a future change renumbers the codes,
// this fails and signals that SKILL.md needs updating. Pure mapping assertions,
// no I/O — distinct from wait.test.ts, which exercises the same codes through the
// full polling loop.

const status = (s: AgentStatusFile["status"]): WaitOutcome => ({
  _tag: "status",
  file: { status: s, summary: "x" },
});

test("status:done → exit 0 (land)", () => {
  expect(exitCodeFor(status("done"))).toBe(0);
});

test("status:failed → exit 1 (retry/inspect)", () => {
  expect(exitCodeFor(status("failed"))).toBe(1);
});

test("status:blocked → exit 2 (escalate to a human)", () => {
  expect(exitCodeFor(status("blocked"))).toBe(2);
});

test("no-signal:timeout → exit 3 (investigate, never land)", () => {
  expect(exitCodeFor({ _tag: "no-signal", reason: "timeout" })).toBe(3);
});

test("no-signal:idle-pane → exit 3 (investigate, never land)", () => {
  expect(exitCodeFor({ _tag: "no-signal", reason: "idle-pane" })).toBe(3);
});
