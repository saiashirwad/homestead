import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import {
  resolveCloseComment,
  resolveCloseReason,
  resolveLabelColor,
  resolveReviewComment,
  resolveStopComment,
  TrackingStateSchema,
} from "./tracking.ts";

test("TrackingState decodes legacy state without title/worktreeDir", () => {
  const decode = Schema.decodeUnknownSync(TrackingStateSchema);
  const legacy = decode({ number: 7, url: "u", label: "agent:wip" });
  expect(legacy.number).toBe(7);
  expect(legacy.title).toBeUndefined();
  expect(legacy.worktreeDir).toBeUndefined();
});

test("TrackingState round-trips title + worktreeDir", () => {
  const decode = Schema.decodeUnknownSync(TrackingStateSchema);
  const s = decode({ number: 7, url: "u", title: "Fix bug", worktreeDir: "/tmp/wt" });
  expect(s.title).toBe("Fix bug");
  expect(s.worktreeDir).toBe("/tmp/wt");
});

test("tracking state encode/decode round-trip", async () => {
  const state = {
    number: 42,
    url: "https://github.com/o/r/issues/42",
    label: "agent:working",
    assigned: true,
    commented: true,
  };
  const encoded = await Effect.runPromise(Schema.encodeUnknownEffect(TrackingStateSchema)(state));
  const json = JSON.stringify(encoded);
  const decoded = await Effect.runPromise(
    Schema.decodeUnknownEffect(Schema.fromJsonString(TrackingStateSchema))(json),
  );
  expect(decoded).toEqual(state);
});

test("resolveStopComment default body matches legacy", () => {
  const body = resolveStopComment(undefined, { branch: "feat-x", host: "mac", worktreeDir: "/w" } as any);
  expect(body).toBe("homestead: agent stopped on `feat-x` (mac)");
});

test("resolveStopComment false suppresses", () => {
  expect(resolveStopComment(false, { branch: "feat-x", host: "mac" } as any)).toBeUndefined();
});

test("resolveStopComment function form wins", () => {
  const body = resolveStopComment((c: any) => `bye ${c.branch}`, { branch: "feat-x", host: "mac" } as any);
  expect(body).toBe("bye feat-x");
});

test("review/close comments default to undefined (off)", () => {
  expect(resolveReviewComment(undefined, { branch: "b", host: "h" } as any)).toBeUndefined();
  expect(resolveCloseComment(undefined, { branch: "b", host: "h" } as any)).toBeUndefined();
});

test("review/close comments true uses default body", () => {
  expect(resolveReviewComment(true, { branch: "b", host: "h" } as any)).toBe("homestead: `b` moved to review (h)");
  expect(resolveCloseComment(true, { branch: "b", host: "h" } as any)).toBe("homestead: `b` completed (h)");
});

test("review/close comments function form wins", () => {
  expect(resolveReviewComment((c: any) => `r ${c.branch}`, { branch: "b" } as any)).toBe("r b");
  expect(resolveCloseComment((c: any) => `c ${c.branch}`, { branch: "b" } as any)).toBe("c b");
});

test("closeReason default is completed", () => {
  expect(resolveCloseReason(undefined, {} as any)).toBe("completed");
  expect(resolveCloseReason("not planned", {} as any)).toBe("not planned");
  expect(resolveCloseReason((_: any) => "not planned", {} as any)).toBe("not planned");
});

test("labelColor default is 1D76DB", () => {
  expect(resolveLabelColor(undefined, { label: "agent:wip", kind: "wip" })).toBe("1D76DB");
  expect(resolveLabelColor("FF0000", { label: "x", kind: "wip" })).toBe("FF0000");
  expect(resolveLabelColor((c) => (c.kind === "review" ? "00FF00" : "0000FF"), { label: "x", kind: "review" })).toBe(
    "00FF00",
  );
});
