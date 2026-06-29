import { expect, test } from "bun:test";
import { Effect, Option, Schema } from "effect";
import { AGENT_STATUS_RELPATH, AgentStatusFileSchema } from "./status.ts";

const decode = (input: unknown) => {
  const result = Effect.runSync(
    Schema.decodeUnknownEffect(AgentStatusFileSchema)(input).pipe(Effect.option),
  );
  return Option.isSome(result)
    ? ({ ok: true as const, value: result.value })
    : ({ ok: false as const });
};

test("relpath points inside the worktree .homestead dir", () => {
  expect(AGENT_STATUS_RELPATH).toBe(".homestead/agent-status.json");
});

test("decodes a valid done file", () => {
  const res = decode({ status: "done", summary: "shipped it" });
  expect(res.ok).toBe(true);
  if (res.ok) {
    expect(res.value.status).toBe("done");
    expect(res.value.summary).toBe("shipped it");
  }
});

test("accepts blocked and failed", () => {
  expect(decode({ status: "blocked", summary: "need a decision" }).ok).toBe(true);
  expect(decode({ status: "failed", summary: "could not finish" }).ok).toBe(true);
});

test("rejects an unknown status", () => {
  expect(decode({ status: "done-ish", summary: "x" }).ok).toBe(false);
});

test("rejects a missing summary", () => {
  expect(decode({ status: "done" }).ok).toBe(false);
});

test("tolerates optional details and at fields", () => {
  const res = decode({
    status: "done",
    summary: "ok",
    details: "ran bun test",
    at: "2026-06-29T12:00:00.000Z",
  });
  expect(res.ok).toBe(true);
  if (res.ok) {
    expect(res.value.details).toBe("ran bun test");
    expect(res.value.at).toBe("2026-06-29T12:00:00.000Z");
  }
});

test("ignores extra unknown fields", () => {
  expect(decode({ status: "done", summary: "ok", mood: "great" }).ok).toBe(true);
});
