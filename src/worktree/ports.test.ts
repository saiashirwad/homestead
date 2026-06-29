import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Path, Semaphore } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { nextFreePort } from "../text.ts";
import type { PortSpec } from "../types.ts";
import {
  type Reservation,
  claimReservations,
  finalizeReservations,
  liveReservations,
  PortAllocator,
  readReservations,
  reservationsToClaim,
  withRegistryLock,
  writeReservations,
} from "./ports.ts";

// The registry lives under ~/.homestead/state/<repo-slug>/. Mock os.homedir() to
// a fresh temp dir per test (the same pattern spawn.test.ts uses) so each test is
// isolated and we never touch the real home dir.
let home: string;
let homeSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  home = mkdtempSync(join(os.tmpdir(), "homestead-ports-home-"));
  homeSpy = spyOn(os, "homedir").mockReturnValue(home);
});
afterEach(() => {
  homeSpy.mockRestore();
  rmSync(home, { recursive: true, force: true });
});

const run = <A, E>(eff: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
  Effect.runPromise(eff.pipe(Effect.provide(BunServices.layer)));

const at = (iso: string, key: string, port: number, branch: string, pid: number): Reservation => ({
  key,
  port,
  branch,
  pid,
  claimedAt: iso,
});

const alive = (_pid: number) => true;
const dead = (_pid: number) => false;

// ---------------------------------------------------------------------------
// Pure expiry + claim-shaping
// ---------------------------------------------------------------------------

test("liveReservations keeps young, live-pid entries", () => {
  const now = Date.parse("2026-06-29T12:00:00Z");
  const all = [at("2026-06-29T11:59:00Z", "PORT", 3001, "a", 1)];
  expect(liveReservations(all, now, alive, 10 * 60_000)).toEqual(all);
});

test("liveReservations drops entries past the TTL", () => {
  const now = Date.parse("2026-06-29T12:00:00Z");
  const fresh = at("2026-06-29T11:59:00Z", "PORT", 3001, "a", 1);
  const stale = at("2026-06-29T11:30:00Z", "PORT", 3002, "b", 1); // 30m old, TTL 10m
  expect(liveReservations([fresh, stale], now, alive, 10 * 60_000)).toEqual([fresh]);
});

test("liveReservations drops entries whose pid is dead", () => {
  const now = Date.parse("2026-06-29T12:00:00Z");
  const r = at("2026-06-29T11:59:00Z", "PORT", 3001, "a", 999999);
  expect(liveReservations([r], now, dead, 10 * 60_000)).toEqual([]);
});

test("liveReservations treats an unparseable claimedAt as expired", () => {
  const now = Date.parse("2026-06-29T12:00:00Z");
  const r = at("not-a-date", "PORT", 3001, "a", 1);
  expect(liveReservations([r], now, alive, 10 * 60_000)).toEqual([]);
});

test("reservationsToClaim only claims freshly-picked port keys", () => {
  const ports: ReadonlyArray<PortSpec> = [
    { key: "PORT", base: 3000 },
    { key: "VITE_PORT", base: 5173 },
  ];
  // PORT already in target .env (reused, no claim); VITE_PORT freshly picked.
  const targetEnv = "PORT=3099\n";
  const envEdits: ReadonlyArray<readonly [string, string]> = [
    ["PORT", "3099"],
    ["VITE_PORT", "5174"],
    ["DATABASE_URL", "postgres://x"], // non-port key: never claimed
  ];
  const claims = reservationsToClaim(ports, targetEnv, envEdits, "feat-x", 4242, "2026-06-29T12:00:00Z");
  expect(claims).toEqual([{ key: "VITE_PORT", port: 5174, branch: "feat-x", pid: 4242, claimedAt: "2026-06-29T12:00:00Z" }]);
});

// ---------------------------------------------------------------------------
// Registry I/O + lockfile (isolated per test via the mocked home dir)
// ---------------------------------------------------------------------------

test("claim → finalize lifecycle: picking writes a reservation, finalize removes it", async () => {
  const repo = "lifecycle-repo";
  const claim = at("2026-06-29T12:00:00Z", "PORT", 3001, "feat-x", 4242);

  const afterClaim = await run(
    Effect.gen(function* () {
      yield* claimReservations(repo, [claim], Date.parse("2026-06-29T12:00:00Z"), alive);
      return yield* withRegistryLock(repo, readReservations(repo));
    }),
  );
  expect(afterClaim).toEqual([claim]);

  const afterFinalize = await run(
    Effect.gen(function* () {
      yield* finalizeReservations(repo, "feat-x", 4242, Date.parse("2026-06-29T12:00:00Z"), alive);
      return yield* withRegistryLock(repo, readReservations(repo));
    }),
  );
  expect(afterFinalize).toEqual([]);
});

test("claim prunes expired/dead entries while appending", async () => {
  const repo = "prune-repo";
  const now = Date.parse("2026-06-29T12:00:00Z");
  const stale = at("2026-06-29T11:00:00Z", "PORT", 3001, "old", 1); // 60m old
  const fresh = at("2026-06-29T12:00:00Z", "PORT", 3002, "new", 2);

  const result = await run(
    Effect.gen(function* () {
      yield* withRegistryLock(repo, writeReservations(repo, [stale]));
      yield* claimReservations(repo, [fresh], now, alive);
      return yield* withRegistryLock(repo, readReservations(repo));
    }),
  );
  expect(result).toEqual([fresh]); // stale dropped, fresh kept
});

test("finalize only removes the matching branch+pid, leaving others", async () => {
  const repo = "finalize-repo";
  const now = Date.parse("2026-06-29T12:00:00Z");
  const mine = at("2026-06-29T12:00:00Z", "PORT", 3001, "mine", 10);
  const theirs = at("2026-06-29T12:00:00Z", "PORT", 3002, "theirs", 20);

  const result = await run(
    Effect.gen(function* () {
      yield* claimReservations(repo, [mine, theirs], now, alive);
      yield* finalizeReservations(repo, "mine", 10, now, alive);
      return yield* withRegistryLock(repo, readReservations(repo));
    }),
  );
  expect(result).toEqual([theirs]);
});

test("lockfile mutual exclusion: concurrent claims both survive (no lost write)", async () => {
  const repo = "mutex-repo";
  const now = Date.parse("2026-06-29T12:00:00Z");
  const a = at("2026-06-29T12:00:00Z", "PORT", 3001, "a", 1);
  const b = at("2026-06-29T12:00:00Z", "PORT", 3002, "b", 2);

  const result = await run(
    Effect.gen(function* () {
      // Both read-modify-write the registry at once. Without the lock this is a
      // classic lost-update (last writer wins, one claim vanishes). With it,
      // both must survive.
      yield* Effect.all([claimReservations(repo, [a], now, alive), claimReservations(repo, [b], now, alive)], {
        concurrency: "unbounded",
      });
      return yield* withRegistryLock(repo, readReservations(repo));
    }),
  );
  expect(result.length).toBe(2);
  expect(result.map((r) => r.port).sort()).toEqual([3001, 3002]);
});

test("lockfile is released even when the guarded effect fails", async () => {
  const repo = "release-repo";

  const reAcquired = await run(
    Effect.gen(function* () {
      // First holder fails inside the lock — release must still run.
      yield* withRegistryLock(repo, Effect.fail("boom")).pipe(Effect.ignore);
      // If the lock were stranded, this second acquire would hang then die.
      return yield* withRegistryLock(repo, Effect.succeed("got-it"));
    }),
  );
  expect(reAcquired).toBe("got-it");
});

test("PortAllocator semaphore serializes the read-pick-write critical section", async () => {
  // N fibers each: read the shared 'claimed' set, yield (provoking interleave),
  // pick the next free port, write it back. Serialized by the permit, they must
  // produce N DISTINCT ports; unserialized they'd collide on the same nextFree.
  const N = 8;
  const base = 4000;

  const picks = await Effect.runPromise(
    Effect.gen(function* () {
      const { semaphore } = yield* PortAllocator;
      const claimed = new Set<number>();
      const pickOne = semaphore.withPermit(
        Effect.gen(function* () {
          const candidate = nextFreePort(base, claimed);
          yield* Effect.yieldNow; // interleave point: races here without the permit
          claimed.add(candidate);
          return candidate;
        }),
      );
      return yield* Effect.all(Array.from({ length: N }, () => pickOne), { concurrency: "unbounded" });
    }).pipe(Effect.provide(PortAllocator.layer)),
  );

  expect(new Set(picks).size).toBe(N);
  expect([...picks].sort((x, y) => x - y)).toEqual(Array.from({ length: N }, (_, i) => base + i));
});
