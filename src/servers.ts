import { Effect, FileSystem, Path } from "effect";
import * as os from "node:os";
import { killPid } from "./process.ts";
import { slugify } from "./text.ts";

// Per-branch dev-server PID tracking. PIDs live in a sibling of the tracking
// JSON — `~/.homestead/state/<repo-slug>/<branch-slug>.pid`, one PID per line.
//
// ⚠ The pidfile MUST live here (the state dir), NOT inside the worktree:
// `git worktree remove --force` wipes the worktree dir, so a pidfile there would
// be gone before teardown could read it. The state dir survives worktree
// removal, so teardownWorktree can always find the PIDs it needs to kill.
//
// The state-dir layout is deliberately mirrored from tracking.ts (rather than
// importing its private `stateDir`) to keep tracking.ts's surface unchanged.

const stateDir = (path: Path.Path, repoName: string) =>
  path.join(os.homedir(), ".homestead", "state", slugify(repoName));

export const serverPidPath = (path: Path.Path, repoName: string, branch: string): string =>
  path.join(stateDir(path, repoName), `${slugify(branch)}.pid`);

// Append one PID to the branch's pidfile, creating the state dir if absent
// (mirrors markStarted in tracking.ts). The hook that starts a dev server calls
// this with the PID from spawnDetached.
export const recordServerPid = Effect.fn("homestead/record-server-pid")(function* (
  repoName: string,
  branch: string,
  pid: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(stateDir(path, repoName), { recursive: true });
  yield* fs.writeFileString(serverPidPath(path, repoName, branch), `${pid}\n`, { flag: "a" });
});

// `process.kill(pid, 0)` probes liveness without sending a signal: ESRCH ⇒ gone,
// EPERM ⇒ exists but not ours (still alive).
const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

// Grace period between SIGTERM and the SIGKILL escalation — long enough for a
// dev server to shut down cleanly, short enough to keep teardown snappy.
const GRACE_MS = 500;

// Kill every dev server recorded for a branch, then delete the pidfile.
// SIGTERM each PID, wait a short grace, SIGKILL any still alive, remove the file.
// A missing pidfile or an already-dead PID (ESRCH) is a silent no-op — this is
// the FIRST teardown step, so it must never fail the teardown it precedes.
export const killServers = Effect.fn("homestead/kill-servers")(function* (
  repoName: string,
  branch: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = serverPidPath(path, repoName, branch);

  const exists = yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false));
  if (!exists) return;

  const content = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
  const pids = content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => Number(line))
    .filter((n) => Number.isInteger(n) && n > 0);

  if (pids.length > 0) {
    for (const pid of pids) killPid(pid, "SIGTERM");
    yield* Effect.sleep(`${GRACE_MS} millis`);
    for (const pid of pids) {
      if (isAlive(pid)) killPid(pid, "SIGKILL");
    }
  }

  yield* fs.remove(file).pipe(Effect.orElseSucceed(() => undefined));
});
