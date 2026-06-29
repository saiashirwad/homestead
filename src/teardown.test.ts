import { expect, spyOn, test } from "bun:test";
import { BunFileSystem, BunPath, BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { TestConsole } from "effect/testing";
import { ChildProcessSpawner } from "effect/unstable/process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as childProcess from "node:child_process";
import * as os from "node:os";
import * as nodePath from "node:path";
import { emit, teardownEvents, type HomesteadEvent } from "./events.ts";
import { runAfterTeardown, runBeforeTeardown } from "./hooks.ts";
import { makeContext } from "./context.ts";
import { HerdrError } from "./herdr/errors.ts";
import { HerdrTest, HerdrTestHandle } from "./herdr/test.ts";
import { removeHerdrWorktree, completeBranch } from "./teardown.ts";
import { markCompleted, markFinished, markStopped } from "./tracking.ts";
import { slugify } from "./text.ts";

const TestLayer = Layer.provideMerge(HerdrTest, BunServices.layer);

// A spawner that records every command instead of running it — lets a test
// assert which subprocesses (git/gh) a teardown path did or did NOT invoke.
const recordingSpawner = (calls: Array<Array<string>>) =>
  Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, {
    exitCode: (cmd: { command: string; args: ReadonlyArray<string> }) =>
      Effect.sync(() => {
        calls.push([cmd.command, ...cmd.args]);
        return 0;
      }),
    string: (cmd: { command: string; args: ReadonlyArray<string> }) =>
      Effect.sync(() => {
        calls.push([cmd.command, ...cmd.args]);
        return "";
      }),
  } as unknown as ChildProcessSpawner.ChildProcessSpawner["Service"]);

const baseLayer = (calls: Array<Array<string>>) =>
  Layer.mergeAll(BunFileSystem.layer, BunPath.layer, recordingSpawner(calls));

// Stand up a fake ~/.homestead by pointing os.homedir() at a temp dir, then run
// `f`. (Bun caches os.homedir(), so a runtime $HOME change is ignored — spy it.)
const withHomestead = async (
  repoName: string,
  branch: string,
  stateJson: string | undefined,
  f: (paths: { primaryRoot: string; stateFile: string }) => Promise<void>,
) => {
  const home = mkdtempSync(nodePath.join(os.tmpdir(), "homestead-home-"));
  const spy = spyOn(os, "homedir").mockReturnValue(home);
  try {
    const dir = nodePath.join(home, ".homestead", "state", slugify(repoName));
    const stateFile = nodePath.join(dir, `${slugify(branch)}.json`);
    if (stateJson !== undefined) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(stateFile, stateJson);
    }
    await f({ primaryRoot: home, stateFile });
  } finally {
    spy.mockRestore();
    rmSync(home, { recursive: true, force: true });
  }
};

const spawnStateJson = JSON.stringify({
  kind: "spawn",
  worktreeDir: "/tmp/wt",
  spawn: { spawnedBy: "agent spawn", paneId: "pane_1", spawnedAt: "2026-06-29T00:00:00.000Z" },
});

const ghCalls = (calls: Array<Array<string>>) => calls.filter((c) => c[0] === "gh");

test("markStopped on spawn state deletes the file and issues no gh calls", async () => {
  await withHomestead("r", "spawn-x", spawnStateJson, async ({ stateFile }) => {
    const calls: Array<Array<string>> = [];
    await Effect.runPromise(markStopped("r", "spawn-x").pipe(Effect.provide(baseLayer(calls))));
    expect(existsSync(stateFile)).toBe(false);
    expect(ghCalls(calls)).toEqual([]);
  });
});

test("markCompleted on spawn state deletes the file and issues no gh calls", async () => {
  await withHomestead("r", "spawn-x", spawnStateJson, async ({ stateFile }) => {
    const calls: Array<Array<string>> = [];
    await Effect.runPromise(markCompleted("r", "spawn-x").pipe(Effect.provide(baseLayer(calls))));
    expect(existsSync(stateFile)).toBe(false);
    expect(ghCalls(calls)).toEqual([]);
  });
});

test("markFinished on spawn state deletes the file and issues no gh calls", async () => {
  await withHomestead("r", "spawn-x", spawnStateJson, async ({ stateFile }) => {
    const calls: Array<Array<string>> = [];
    await Effect.runPromise(markFinished("r", "spawn-x", "agent:review").pipe(Effect.provide(baseLayer(calls))));
    expect(existsSync(stateFile)).toBe(false);
    expect(ghCalls(calls)).toEqual([]);
  });
});

test("completeBranch refuses spawn work without --allow-spawned (no side effects)", async () => {
  await withHomestead("r", "spawn-x", spawnStateJson, async ({ primaryRoot, stateFile }) => {
    const calls: Array<Array<string>> = [];
    const layer = Layer.provideMerge(HerdrTest, baseLayer(calls));
    await Effect.runPromise(
      completeBranch(primaryRoot, "r", "spawn-x", false, undefined, false).pipe(Effect.provide(layer)),
    );
    // Aborted before any destructive step: no subprocess ran, state file intact.
    expect(calls).toEqual([]);
    expect(existsSync(stateFile)).toBe(true);
  });
});

test("completeBranch proceeds on spawn work with --allow-spawned", async () => {
  await withHomestead("r", "spawn-x", spawnStateJson, async ({ primaryRoot, stateFile }) => {
    const calls: Array<Array<string>> = [];
    const layer = Layer.provideMerge(HerdrTest, baseLayer(calls));
    await Effect.runPromise(
      completeBranch(primaryRoot, "r", "spawn-x", false, undefined, true).pipe(Effect.provide(layer)),
    );
    // Proceeded into teardown: git ran, markCompleted removed the state file,
    // and (spawn work) still no gh issue calls.
    expect(calls.length).toBeGreaterThan(0);
    expect(ghCalls(calls)).toEqual([]);
    expect(existsSync(stateFile)).toBe(false);
  });
});

const spawnSleeper = (): number => {
  const child = childProcess.spawn("sleep", ["60"], { stdio: "ignore", detached: true });
  child.unref();
  return child.pid!;
};

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

const waitGone = async (pid: number, timeoutMs = 2000): Promise<boolean> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return !isAlive(pid);
};

test("teardownWorktree kills the branch's dev servers BEFORE git worktree removal", async () => {
  await withHomestead("r", "spawn-x", spawnStateJson, async ({ primaryRoot, stateFile }) => {
    const pid = spawnSleeper();
    const pidFile = nodePath.join(nodePath.dirname(stateFile), `${slugify("spawn-x")}.pid`);
    writeFileSync(pidFile, `${pid}\n`);

    // Snapshot, at the moment the FIRST git subprocess runs, whether the pidfile
    // was already removed — proving killServers (the first teardown step)
    // completed before any git-side removal.
    let pidfileGoneAtFirstGit: boolean | undefined;
    const recordOrdering = (cmd: { command: string; args: ReadonlyArray<string> }) => {
      if (cmd.command === "git" && pidfileGoneAtFirstGit === undefined) {
        pidfileGoneAtFirstGit = !existsSync(pidFile);
      }
    };
    const orderingSpawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, {
      exitCode: (cmd: { command: string; args: ReadonlyArray<string> }) =>
        Effect.sync(() => {
          recordOrdering(cmd);
          return 0;
        }),
      string: (cmd: { command: string; args: ReadonlyArray<string> }) =>
        Effect.sync(() => {
          recordOrdering(cmd);
          return "";
        }),
    } as unknown as ChildProcessSpawner.ChildProcessSpawner["Service"]);

    const layer = Layer.provideMerge(
      HerdrTest,
      Layer.mergeAll(BunFileSystem.layer, BunPath.layer, orderingSpawner),
    );
    await Effect.runPromise(
      completeBranch(primaryRoot, "r", "spawn-x", false, undefined, true).pipe(Effect.provide(layer)),
    );

    expect(await waitGone(pid)).toBe(true);
    expect(existsSync(pidFile)).toBe(false);
    expect(pidfileGoneAtFirstGit).toBe(true);
  });
});

test("runBeforeTeardown passes verb + tracked", async () => {
  const seen: Array<{ verb: string; tracked: boolean }> = [];
  const hook = (c: { verb: string; tracked: boolean }) =>
    Effect.sync(() => seen.push({ verb: c.verb, tracked: c.tracked }));
  const ctx = makeContext({ repoName: "r", slug: "b", branch: "b", worktreeDir: "/w" });
  await Effect.runPromise(runBeforeTeardown(hook, ctx, "kill", false).pipe(Effect.provide(TestLayer)));
  expect(seen).toEqual([{ verb: "kill", tracked: false }]);
});

test("runAfterTeardown no-op when undefined", async () => {
  const ctx = makeContext({ repoName: "r", slug: "b", branch: "b", worktreeDir: "/w" });
  await Effect.runPromise(runAfterTeardown(undefined, ctx, "close", "agent:review").pipe(Effect.provide(TestLayer)));
  expect(true).toBe(true);
});

test("runAfterTeardown awaits a Promise-returning hook (no effect import needed)", async () => {
  const seen: string[] = [];
  // A plain async hook — the shape a self-contained config uses when it can't
  // import `effect`. normalizeHookResult must await it before teardown proceeds.
  const hook = async (c: { verb: string }) => {
    await Promise.resolve();
    seen.push(c.verb);
  };
  const ctx = makeContext({ repoName: "r", slug: "b", branch: "b", worktreeDir: "/w" });
  await Effect.runPromise(runAfterTeardown(hook, ctx, "kill").pipe(Effect.provide(TestLayer)));
  expect(seen).toEqual(["kill"]);
});

test("runAfterTeardown ignores a non-thenable return", async () => {
  const ctx = makeContext({ repoName: "r", slug: "b", branch: "b", worktreeDir: "/w" });
  // Returning undefined/void must not crash the `yield*` in teardown.
  await Effect.runPromise(runAfterTeardown(() => undefined, ctx, "kill").pipe(Effect.provide(TestLayer)));
  expect(true).toBe(true);
});

test("teardownEvents constructs start/done pairs", () => {
  expect(teardownEvents("kill", "feat/x", "start")).toEqual({
    type: "teardown",
    verb: "kill",
    branch: "feat/x",
    phase: "start",
  });
  expect(teardownEvents("kill", "feat/x", "done")).toEqual({
    type: "teardown",
    verb: "kill",
    branch: "feat/x",
    phase: "done",
  });
  expect(teardownEvents("close", "feat/x", "done", "agent:review")).toEqual({
    type: "teardown",
    verb: "close",
    branch: "feat/x",
    phase: "done",
    reviewLabel: "agent:review",
  });
});

test("removeHerdrWorktree surfaces a failed remove (op + cause) and does not abort teardown", async () => {
  const PRIMARY = "/repo/primary";
  const BRANCH = "feat/x";

  const program = Effect.gen(function* () {
    const handle = yield* HerdrTestHandle;
    yield* handle.setWorktrees(PRIMARY, [{ branch: BRANCH, open_workspace_id: "ws-7" }]);
    yield* handle.failRemove(new HerdrError({ op: "worktree.remove", cause: "herdr exited 1: socket closed" }));
    // If the HerdrError were not caught, this effect would fail and the test
    // would reject — proving control reaches the git-side teardown that follows.
    yield* removeHerdrWorktree(PRIMARY, BRANCH);
    return yield* TestConsole.logLines;
  });

  const lines = await Effect.runPromise(
    program.pipe(Effect.provide(Layer.mergeAll(HerdrTest, BunServices.layer, TestConsole.layer))),
  );
  const text = lines.map((l) => (Array.isArray(l) ? l.join(" ") : String(l))).join("\n");

  expect(text).toContain("op=worktree.remove");
  expect(text).toContain("herdr exited 1: socket closed");
  expect(text).toContain("herdr worktree list");
});

test("emit delivers teardown events to custom onEvent", async () => {
  const events: HomesteadEvent[] = [];
  const onEvent = (e: HomesteadEvent) => Effect.sync(() => void events.push(e));
  await Effect.runPromise(emit(onEvent, teardownEvents("kill", "b", "start")).pipe(Effect.provide(TestLayer)));
  await Effect.runPromise(emit(onEvent, teardownEvents("kill", "b", "done")).pipe(Effect.provide(TestLayer)));
  expect(events).toEqual([
    { type: "teardown", verb: "kill", branch: "b", phase: "start" },
    { type: "teardown", verb: "kill", branch: "b", phase: "done" },
  ]);
});
