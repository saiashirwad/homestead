import { expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Option, Path } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { decideAutonomousStatus, finalizeAgentStatus, finalSummary } from "./finalize.ts";
import { AGENT_STATUS_RELPATH, type AgentStatusFile } from "./status.ts";

const some = (f: AgentStatusFile) => Option.some(f);
const none = Option.none<AgentStatusFile>();

// --- decideAutonomousStatus --------------------------------------------------

test("check pass (exit 0) → done", () => {
  const d = decideAutonomousStatus({ existing: none, checkCode: 0, agentExit: 0 });
  expect(Option.getOrNull(d)).toBe("done");
});

test("check fail (non-zero) → failed, even if the agent exited 0", () => {
  const d = decideAutonomousStatus({ existing: none, checkCode: 1, agentExit: 0 });
  expect(Option.getOrNull(d)).toBe("failed");
});

test("no check → falls back to the agent's exit code", () => {
  expect(Option.getOrNull(decideAutonomousStatus({ existing: none, checkCode: undefined, agentExit: 0 }))).toBe(
    "done",
  );
  expect(Option.getOrNull(decideAutonomousStatus({ existing: none, checkCode: undefined, agentExit: 3 }))).toBe(
    "failed",
  );
});

test("no signal at all defaults to done", () => {
  const d = decideAutonomousStatus({ existing: none, checkCode: undefined, agentExit: undefined });
  expect(Option.getOrNull(d)).toBe("done");
});

test("a model-written `blocked` is preserved (None), check is ignored", () => {
  const d = decideAutonomousStatus({
    existing: some({ status: "blocked", summary: "needs a human" }),
    checkCode: 0,
    agentExit: 0,
  });
  expect(Option.isNone(d)).toBe(true);
});

test("a model-written `done`/`failed` does NOT block the harness re-deciding", () => {
  const d = decideAutonomousStatus({
    existing: some({ status: "done", summary: "I think I'm done" }),
    checkCode: 1,
    agentExit: 0,
  });
  expect(Option.getOrNull(d)).toBe("failed");
});

// --- finalSummary ------------------------------------------------------------

test("finalSummary keeps the model's summary when present", () => {
  const s = finalSummary(some({ status: "done", summary: "Refactored the parser." }), "done", true);
  expect(s).toBe("Refactored the parser.");
});

test("finalSummary synthesizes a message when the model left none", () => {
  expect(finalSummary(none, "done", true)).toContain("check passed");
  expect(finalSummary(none, "failed", true)).toContain("check failed");
  expect(finalSummary(none, "done", false)).toContain("no check configured");
});

// --- finalizeAgentStatus (integration) ---------------------------------------

let dir: string;
const setup = () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "homestead-finalize-"));
  return dir;
};
const teardown = () => rmSync(dir, { recursive: true, force: true });
const sentinelPath = () => path.join(dir, AGENT_STATUS_RELPATH);
const readSentinel = () => JSON.parse(readFileSync(sentinelPath(), "utf8"));

const run = <A, E>(
  eff: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner>,
) => Effect.runPromise(eff.pipe(Effect.provide(BunServices.layer)));

test("finalizeAgentStatus writes done when the check passes (creates .homestead)", async () => {
  setup();
  try {
    const status = await run(finalizeAgentStatus({ worktreeDir: dir, check: ["sh", "-c", "exit 0"], agentExit: 0 }));
    expect(Option.getOrNull(status)).toBe("done");
    const s = readSentinel();
    expect(s.status).toBe("done");
    expect(typeof s.summary).toBe("string");
  } finally {
    teardown();
  }
});

test("finalizeAgentStatus writes failed when the check fails", async () => {
  setup();
  try {
    const status = await run(finalizeAgentStatus({ worktreeDir: dir, check: ["sh", "-c", "exit 1"], agentExit: 0 }));
    expect(Option.getOrNull(status)).toBe("failed");
    expect(readSentinel().status).toBe("failed");
  } finally {
    teardown();
  }
});

test("finalizeAgentStatus preserves the model's summary but overrides the status", async () => {
  setup();
  try {
    mkdirSync(path.join(dir, ".homestead"), { recursive: true });
    writeFileSync(sentinelPath(), JSON.stringify({ status: "done", summary: "Did the thing." }));
    await run(finalizeAgentStatus({ worktreeDir: dir, check: ["sh", "-c", "exit 1"], agentExit: 0 }));
    const s = readSentinel();
    expect(s.status).toBe("failed"); // harness wins on status
    expect(s.summary).toBe("Did the thing."); // model wins on summary
  } finally {
    teardown();
  }
});

test("finalizeAgentStatus leaves a model-written `blocked` untouched", async () => {
  setup();
  try {
    mkdirSync(path.join(dir, ".homestead"), { recursive: true });
    writeFileSync(sentinelPath(), JSON.stringify({ status: "blocked", summary: "Need an API key." }));
    const status = await run(finalizeAgentStatus({ worktreeDir: dir, check: ["sh", "-c", "exit 0"], agentExit: 0 }));
    expect(Option.isNone(status)).toBe(true);
    const s = readSentinel();
    expect(s.status).toBe("blocked");
    expect(s.summary).toBe("Need an API key.");
  } finally {
    teardown();
  }
});

test("finalizeAgentStatus with no check uses the agent's exit code", async () => {
  setup();
  try {
    await run(finalizeAgentStatus({ worktreeDir: dir, agentExit: 2 }));
    expect(readSentinel().status).toBe("failed");
    expect(existsSync(sentinelPath())).toBe(true);
  } finally {
    teardown();
  }
});
