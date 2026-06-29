import { expect, test } from "bun:test";
import { ManagedRuntime } from "effect";
import { z } from "zod";
import { AppLayer } from "./runtime.ts";
import { PortAllocator } from "./worktree/ports.ts";
import { PENDING_JSON, type AgentResult } from "./agent/result.ts";
import type { WaitOutcome } from "./agent/wait.ts";
import { buildTools, resultPayload, waitPayload, type Runner, type ToolDef } from "./mcp.ts";

// A Runner stub: ignores the Effect it's handed and resolves to a fixture. The
// tool handlers build their program lazily (Effect.gen) and only ever observe
// the stub's return, so handler-mapping can be tested without a real runtime.
const stubRun = (value: unknown): Runner => (() => Promise.resolve(value)) as Runner;

const byName = (tools: ReadonlyArray<ToolDef>, name: string): ToolDef => {
  const tool = tools.find((t) => t.name === name);
  if (tool === undefined) throw new Error(`no tool '${name}'`);
  return tool;
};

// A zod field accepts `undefined` (is optional input) iff it is `.optional()` or
// carries a `.default()`. Robust across zod versions — no reliance on internals.
const acceptsUndefined = (schema: z.ZodType): boolean => schema.safeParse(undefined).success;

const firstText = (result: { content: ReadonlyArray<unknown> }): string => {
  const block = result.content[0] as { type: string; text: string };
  return block.text;
};

// ── tool registry ───────────────────────────────────────────────────────────

test("exposes exactly the six orchestration tools, in order", () => {
  const tools = buildTools(stubRun(undefined));
  expect(tools.map((t) => t.name)).toEqual(["spawn", "wait", "result", "ls", "land", "plan"]);
});

test("each tool's input schema mirrors its CLI flags (names + optionality)", () => {
  const tools = buildTools(stubRun(undefined));
  // ZodRawShape values type as the zod-core base ($ZodType, no `.safeParse`); the
  // runtime objects are classic ZodType instances, so view them as such here.
  const schemaOf = (name: string): Record<string, z.ZodType> =>
    byName(tools, name).inputSchema as Record<string, z.ZodType>;

  // keys present (sorted for stable comparison)
  expect(Object.keys(schemaOf("spawn")).sort()).toEqual(["prompt", "slug"]);
  expect(Object.keys(schemaOf("wait")).sort()).toEqual(["pane", "poll", "target", "timeout"]);
  expect(Object.keys(schemaOf("result")).sort()).toEqual(["slug"]);
  expect(Object.keys(schemaOf("ls")).sort()).toEqual([]);
  expect(Object.keys(schemaOf("land")).sort()).toEqual([
    "allowSpawned",
    "branches",
    "complete",
    "keepRemote",
  ]);
  expect(Object.keys(schemaOf("plan")).sort()).toEqual(["issues"]);

  // optionality: required args reject `undefined`; flags with CLI defaults accept it
  const spawn = schemaOf("spawn");
  expect(acceptsUndefined(spawn.slug!)).toBe(false);
  expect(acceptsUndefined(spawn.prompt!)).toBe(false);

  const wait = schemaOf("wait");
  expect(acceptsUndefined(wait.target!)).toBe(false);
  expect(acceptsUndefined(wait.timeout!)).toBe(true);
  expect(acceptsUndefined(wait.pane!)).toBe(true);
  expect(acceptsUndefined(wait.poll!)).toBe(true);

  expect(acceptsUndefined(schemaOf("result").slug!)).toBe(false);

  const land = schemaOf("land");
  expect(acceptsUndefined(land.branches!)).toBe(false);
  expect(acceptsUndefined(land.complete!)).toBe(true);
  expect(acceptsUndefined(land.keepRemote!)).toBe(true);
  expect(acceptsUndefined(land.allowSpawned!)).toBe(true);

  expect(acceptsUndefined(schemaOf("plan").issues!)).toBe(false);
});

test("every tool carries a non-empty description", () => {
  for (const tool of buildTools(stubRun(undefined))) {
    expect(tool.description.length).toBeGreaterThan(0);
  }
});

// ── handler wiring ────────────────────────────────────────────────────────────

test("wait handler carries exitCodeFor for each WaitOutcome variant", async () => {
  const cases: ReadonlyArray<readonly [WaitOutcome, 0 | 1 | 2 | 3]> = [
    [{ _tag: "status", file: { status: "done", summary: "ok" } }, 0],
    [{ _tag: "status", file: { status: "failed", summary: "ok" } }, 1],
    [{ _tag: "status", file: { status: "blocked", summary: "ok" } }, 2],
    [{ _tag: "no-signal", reason: "timeout" }, 3],
    [{ _tag: "no-signal", reason: "idle-pane" }, 3],
  ];
  for (const [outcome, code] of cases) {
    const wait = byName(buildTools(stubRun(outcome)), "wait");
    const result = await wait.handler({ target: "x", timeout: "30m", poll: "2s" });
    const payload = JSON.parse(firstText(result));
    expect(payload.exitCode).toBe(code);
    expect(payload.outcome).toEqual(outcome);
  }
});

test("result handler maps status / pending / unknown to the right payload", async () => {
  const status: AgentResult = { _tag: "status", body: `{"status":"done","summary":"x"}` };
  const cases: ReadonlyArray<readonly [AgentResult, unknown]> = [
    [status, { _tag: "status", body: status._tag === "status" ? status.body : "" }],
    [{ _tag: "pending" }, { _tag: "pending", body: PENDING_JSON }],
    [{ _tag: "unknown" }, { _tag: "unknown" }],
  ];
  for (const [result, expected] of cases) {
    const tool = byName(buildTools(stubRun(result)), "result");
    const out = await tool.handler({ slug: "x" });
    expect(JSON.parse(firstText(out))).toEqual(expected);
  }
});

test("waitPayload / resultPayload are the pure mappers the handlers use", () => {
  expect(waitPayload({ _tag: "no-signal", reason: "timeout" }).exitCode).toBe(3);
  expect(waitPayload({ _tag: "status", file: { status: "done", summary: "s" } }).exitCode).toBe(0);
  expect(resultPayload({ _tag: "pending" })).toEqual({ _tag: "pending", body: PENDING_JSON });
  expect(resultPayload({ _tag: "unknown" })).toEqual({ _tag: "unknown" });
});

// ── shared-runtime invariant ──────────────────────────────────────────────────

test("a single runtime shares one PortAllocator across sequential calls", async () => {
  // The whole point of building the runtime ONCE (ManagedRuntime, not a per-call
  // Effect.provide): every tool call runs against the same PortAllocator
  // semaphore, so in-process port-collision serialization survives. An accidental
  // per-call provide would hand each call a fresh semaphore and break this.
  const runtime = ManagedRuntime.make(AppLayer);
  try {
    // A Context.Service tag is itself an Effect that yields the service.
    const a = await runtime.runPromise(PortAllocator);
    const b = await runtime.runPromise(PortAllocator);
    expect(a.semaphore).toBe(b.semaphore);
  } finally {
    await runtime.dispose();
  }
});
