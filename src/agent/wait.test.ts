import { afterEach, beforeEach, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer, Option } from "effect";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HerdrTest, HerdrTestHandle } from "../herdr/test.ts";
import { slugify } from "../text.ts";
import { AGENT_STATUS_RELPATH } from "./status.ts";
import {
  exitCodeFor,
  parseCompactDuration,
  pickWorktreeDir,
  resolveWorktreeDir,
  waitForAgent,
} from "./wait.ts";

const TestLayer = Layer.provideMerge(HerdrTest, BunServices.layer);

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "homestead-wait-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const writeStatus = (body: string) => {
  fs.mkdirSync(path.join(dir, ".homestead"), { recursive: true });
  fs.writeFileSync(path.join(dir, AGENT_STATUS_RELPATH), body);
};

const run = (opts: Parameters<typeof waitForAgent>[0], script?: ReadonlyArray<string>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      if (script !== undefined && opts.paneId !== undefined) {
        const handle = yield* HerdrTestHandle;
        yield* handle.script(opts.paneId, script);
      }
      return yield* waitForAgent(opts);
    }).pipe(Effect.provide(TestLayer)),
  );

const base = { worktreeDir: "", timeoutMs: 3000, pollMs: 5, graceMs: 0, consecutiveIdle: 3 };

test("status 'done' → exit 0", async () => {
  writeStatus(JSON.stringify({ status: "done", summary: "shipped" }));
  const outcome = await run({ ...base, worktreeDir: dir });
  expect(outcome._tag).toBe("status");
  expect(exitCodeFor(outcome)).toBe(0);
});

test("status 'failed' → exit 1", async () => {
  writeStatus(JSON.stringify({ status: "failed", summary: "nope" }));
  const outcome = await run({ ...base, worktreeDir: dir });
  expect(exitCodeFor(outcome)).toBe(1);
});

test("status 'blocked' → exit 2", async () => {
  writeStatus(JSON.stringify({ status: "blocked", summary: "need input" }));
  const outcome = await run({ ...base, worktreeDir: dir });
  expect(exitCodeFor(outcome)).toBe(2);
});

test("absent file + idle ❯ pane → no-signal (exit 3) via backstop", async () => {
  const outcome = await run({ ...base, worktreeDir: dir, paneId: "pane-1" }, ["❯"]);
  expect(outcome._tag).toBe("no-signal");
  expect(exitCodeFor(outcome)).toBe(3);
});

test("absent file + no pane + elapsed timeout → no-signal (exit 3)", async () => {
  const outcome = await run({ ...base, worktreeDir: dir, timeoutMs: 40 });
  expect(outcome._tag).toBe("no-signal");
  expect(exitCodeFor(outcome)).toBe(3);
});

test("malformed status file keeps polling, then times out to exit 3", async () => {
  writeStatus("{ not valid json");
  const outcome = await run({ ...base, worktreeDir: dir, timeoutMs: 40 });
  expect(outcome._tag).toBe("no-signal");
  expect(exitCodeFor(outcome)).toBe(3);
});

test("partial status file (missing summary) is treated as no status yet", async () => {
  writeStatus(JSON.stringify({ status: "done" }));
  const outcome = await run({ ...base, worktreeDir: dir, timeoutMs: 40 });
  expect(outcome._tag).toBe("no-signal");
});

test("parseCompactDuration handles ms/s/m/h", () => {
  expect(parseCompactDuration("500ms")).toBe(500);
  expect(parseCompactDuration("2s")).toBe(2000);
  expect(parseCompactDuration("30m")).toBe(30 * 60 * 1000);
  expect(parseCompactDuration("1h")).toBe(60 * 60 * 1000);
});

test("parseCompactDuration tolerates whitespace and case", () => {
  expect(parseCompactDuration("  45M ")).toBe(45 * 60 * 1000);
});

test("parseCompactDuration rejects garbage", () => {
  expect(parseCompactDuration("soon")).toBeUndefined();
  expect(parseCompactDuration("10")).toBeUndefined();
  expect(parseCompactDuration("")).toBeUndefined();
  expect(parseCompactDuration("-5s")).toBeUndefined();
  expect(parseCompactDuration("5d")).toBeUndefined();
});

test("pickWorktreeDir prefers the tracking-state worktreeDir over the fallback", () => {
  expect(
    pickWorktreeDir(
      Option.some({ number: 7, url: "u", worktreeDir: "/explicit/dir" }),
      "/fallback",
    ),
  ).toBe("/explicit/dir");
});

test("pickWorktreeDir uses the fallback when state is absent", () => {
  expect(pickWorktreeDir(Option.none(), "/fallback")).toBe("/fallback");
});

test("pickWorktreeDir uses the fallback when state lacks a worktreeDir", () => {
  expect(pickWorktreeDir(Option.some({ number: 7, url: "u" }), "/fallback")).toBe("/fallback");
});

test("resolveWorktreeDir falls back to the ~/worktrees convention when no state on disk", async () => {
  // Random repo name so no real tracking-state file can collide.
  const repoName = `homestead-test-${process.pid}-${dir.split("-").pop()}`;
  const resolved = await Effect.runPromise(
    resolveWorktreeDir(repoName, "feature-x", undefined).pipe(Effect.provide(TestLayer)),
  );
  expect(resolved).toBe(path.join(os.homedir(), "worktrees", repoName, slugify("feature-x")));
});
