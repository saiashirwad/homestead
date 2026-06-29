import { expect, spyOn, test } from "bun:test";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Layer, Path } from "effect";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as childProcess from "node:child_process";
import * as os from "node:os";
import * as nodePath from "node:path";
import { killServers, recordServerPid, serverPidPath } from "./servers.ts";
import { slugify } from "./text.ts";

const BaseLayer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

// Stand up a fake ~/.homestead by pointing os.homedir() at a temp dir. Bun caches
// os.homedir() so a runtime $HOME change is ignored — spy it (mirrors teardown.test.ts).
const withHome = async (f: (home: string) => Promise<void>) => {
  const home = mkdtempSync(nodePath.join(os.tmpdir(), "homestead-srv-"));
  const spy = spyOn(os, "homedir").mockReturnValue(home);
  try {
    await f(home);
  } finally {
    spy.mockRestore();
    rmSync(home, { recursive: true, force: true });
  }
};

const pidFileFor = (home: string, repo: string, branch: string) =>
  nodePath.join(home, ".homestead", "state", slugify(repo), `${slugify(branch)}.pid`);

// Spawn a real, long-lived child we can later assert was (or wasn't) killed.
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

// Poll until a PID is gone (SIGTERM/SIGKILL delivery is async).
const waitGone = async (pid: number, timeoutMs = 2000): Promise<boolean> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return !isAlive(pid);
};

test("serverPidPath is a .pid sibling of the tracking state dir", async () => {
  await withHome(async (home) => {
    const got = await Effect.runPromise(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        return serverPidPath(path, "my-repo", "feat/x");
      }).pipe(Effect.provide(BaseLayer)),
    );
    expect(got).toBe(pidFileFor(home, "my-repo", "feat/x"));
  });
});

test("recordServerPid creates the state dir and appends one PID per line", async () => {
  await withHome(async (home) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* recordServerPid("r", "b", 111);
        yield* recordServerPid("r", "b", 222);
      }).pipe(Effect.provide(BaseLayer)),
    );
    const file = pidFileFor(home, "r", "b");
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("111\n222\n");
  });
});

test("killServers SIGTERMs each recorded PID and deletes the pidfile", async () => {
  await withHome(async (home) => {
    const a = spawnSleeper();
    const b = spawnSleeper();
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* recordServerPid("r", "b", a);
        yield* recordServerPid("r", "b", b);
        yield* killServers("r", "b");
      }).pipe(Effect.provide(BaseLayer)),
    );
    expect(await waitGone(a)).toBe(true);
    expect(await waitGone(b)).toBe(true);
    expect(existsSync(pidFileFor(home, "r", "b"))).toBe(false);
  });
});

test("killServers is a silent no-op when the pidfile is missing", async () => {
  await withHome(async () => {
    await Effect.runPromise(killServers("r", "nope").pipe(Effect.provide(BaseLayer)));
    expect(true).toBe(true);
  });
});

test("killServers tolerates an already-dead PID (no failure) and removes the file", async () => {
  await withHome(async (home) => {
    const dead = spawnSleeper();
    process.kill(dead, "SIGKILL");
    await waitGone(dead);
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* recordServerPid("r", "b", dead);
        yield* killServers("r", "b");
      }).pipe(Effect.provide(BaseLayer)),
    );
    expect(existsSync(pidFileFor(home, "r", "b"))).toBe(false);
  });
});

test("tearing down branch B leaves branch A's recorded PID alive", async () => {
  await withHome(async (home) => {
    const aPid = spawnSleeper();
    const bPid = spawnSleeper();
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* recordServerPid("r", "a", aPid);
        yield* recordServerPid("r", "b", bPid);
        yield* killServers("r", "b");
      }).pipe(Effect.provide(BaseLayer)),
    );
    expect(await waitGone(bPid)).toBe(true);
    expect(isAlive(aPid)).toBe(true);
    expect(existsSync(pidFileFor(home, "r", "a"))).toBe(true);
    // cleanup
    process.kill(aPid, "SIGKILL");
  });
});
