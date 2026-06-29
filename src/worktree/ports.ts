import { Context, Effect, FileSystem, Layer, Path, Schema, Semaphore } from "effect";
import * as os from "node:os";
import { readEnvVar, slugify } from "../text.ts";
import type { PortSpec } from "../types.ts";

// Cross-process port-reservations registry. A `Semaphore` (Layer 1) makes the
// fibers of ONE `homestead` process take turns through the pick→write gap; it is
// invisible to other processes. This file is Layer 2: a persistent record of
// in-flight port claims so two SEPARATE `homestead` processes can't both hand
// out the same port in the window between picking it and writing it to a
// worktree's `.env`. Its read-modify-write is guarded by an exclusive lockfile.

// One in-flight claim: branch `branch` (pid `pid`) intends to use `port` for env
// key `key`, picked at `claimedAt` (ISO). It only has to bridge pick→write; once
// the worktree's `.env` carries the port, `collectUsedPorts` finds it the normal
// way and the reservation is finalized (removed).
export const ReservationSchema = Schema.Struct({
  key: Schema.String,
  port: Schema.Number,
  branch: Schema.String,
  pid: Schema.Number,
  claimedAt: Schema.String,
});
export type Reservation = typeof ReservationSchema.Type;

// `reservations` defaults to `[]` so an absent/older file still decodes — mirrors
// the zero-touch decoding defaults in tracking.ts / config-schema.ts.
export const ReservationsFileSchema = Schema.Struct({
  reservations: Schema.Array(ReservationSchema).pipe(
    Schema.optional,
    Schema.withDecodingDefault(Effect.succeed([] as Array<Reservation>)),
  ),
});
export type ReservationsFile = typeof ReservationsFileSchema.Type;

// A crashed provision must not sink a port forever: a reservation is only honored
// while its process is alive AND it is younger than this. `collectUsedPorts` sees
// only the survivors.
export const RESERVATION_TTL_MS = 10 * 60_000;

// Is `pid` a live process on THIS host? `kill(pid, 0)` sends no signal — it just
// probes existence. ESRCH ⇒ gone; EPERM ⇒ alive but not ours (still counts).
export const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

// Pure: keep only reservations whose pid is alive and whose age is under the TTL.
// An unparseable `claimedAt` is treated as expired. Injectable `nowMs`/`isAlive`
// make expiry deterministically testable.
export const liveReservations = (
  all: ReadonlyArray<Reservation>,
  nowMs: number,
  isAlive: (pid: number) => boolean = isPidAlive,
  ttlMs: number = RESERVATION_TTL_MS,
): ReadonlyArray<Reservation> =>
  all.filter((r) => {
    const claimedMs = Date.parse(r.claimedAt);
    if (Number.isNaN(claimedMs) || nowMs - claimedMs >= ttlMs) return false;
    return isAlive(r.pid);
  });

// Pure: which port keys does THIS provision need to reserve? Only the configured
// port keys that were freshly picked — a key the worktree's own `.env` already
// carried is reused verbatim (idempotent re-run) and is discoverable without a
// reservation, so it is skipped.
export const reservationsToClaim = (
  ports: ReadonlyArray<PortSpec>,
  targetEnv: string,
  envEdits: ReadonlyArray<readonly [string, string]>,
  branch: string,
  pid: number,
  claimedAt: string,
): ReadonlyArray<Reservation> => {
  const portKeys = new Set(ports.map((spec) => spec.key));
  const claims: Array<Reservation> = [];
  for (const [key, value] of envEdits) {
    if (!portKeys.has(key)) continue;
    if (readEnvVar(targetEnv, key) !== undefined) continue;
    const port = Number(value);
    if (Number.isInteger(port)) claims.push({ key, port, branch, pid, claimedAt });
  }
  return claims;
};

const stateDir = (path: Path.Path, repoName: string) =>
  path.join(os.homedir(), ".homestead", "state", slugify(repoName));
const reservationsPath = (path: Path.Path, repoName: string) =>
  path.join(stateDir(path, repoName), "reservations.json");
const lockPath = (path: Path.Path, repoName: string) =>
  path.join(stateDir(path, repoName), "provision.lock");

// Raw registry read — NO lock. Callers hold the lockfile. Missing/empty/garbage
// file ⇒ `[]` (never an error): the registry is advisory, sibling `.env`s + live
// sockets remain the source of truth.
export const readReservations = Effect.fn("homestead/read-reservations")(function* (repoName: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = reservationsPath(path, repoName);

  const exists = yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false));
  if (!exists) return [] as ReadonlyArray<Reservation>;
  const content = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
  if (content === "") return [] as ReadonlyArray<Reservation>;

  const decoded = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ReservationsFileSchema))(content).pipe(
    Effect.orElseSucceed(() => undefined),
  );
  return (decoded?.reservations ?? []) as ReadonlyArray<Reservation>;
});

// Raw registry write — NO lock. Callers hold the lockfile.
export const writeReservations = Effect.fn("homestead/write-reservations")(function* (
  repoName: string,
  reservations: ReadonlyArray<Reservation>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(stateDir(path, repoName), { recursive: true }).pipe(Effect.orElseSucceed(() => undefined));
  const encoded = yield* Schema.encodeUnknownEffect(ReservationsFileSchema)({ reservations: [...reservations] }).pipe(
    Effect.orDie,
  );
  yield* fs.writeFileString(reservationsPath(path, repoName), `${JSON.stringify(encoded, null, 2)}\n`);
});

const LOCK_RETRY_DELAY_MS = 25;
const LOCK_MAX_ATTEMPTS = 200; // ~5s of contention before giving up loudly

// Acquire the exclusive provision lock for a repo. `flag: "wx"` is fs.open's
// O_CREAT|O_EXCL: it fails if the file already exists, which is exactly mutual
// exclusion. On contention we retry with a fixed backoff. The lockfile guards
// only the registry's read-modify-write, so it is held for milliseconds.
const acquireLock = Effect.fn("homestead/acquire-provision-lock")(function* (repoName: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(stateDir(path, repoName), { recursive: true }).pipe(Effect.orElseSucceed(() => undefined));
  const file = lockPath(path, repoName);

  for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt++) {
    const got = yield* fs
      .writeFileString(file, `${process.pid}\n`, { flag: "wx" })
      .pipe(Effect.as(true), Effect.orElseSucceed(() => false));
    if (got) return file;
    yield* Effect.sleep(`${LOCK_RETRY_DELAY_MS} millis`);
  }
  return yield* Effect.die(
    new Error(
      `[homestead] could not acquire provision lock ${file} after ${LOCK_MAX_ATTEMPTS} attempts — ` +
        `a stale ${file} may be left from a crash; remove it if no homestead is running.`,
    ),
  );
});

const releaseLock = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(file).pipe(Effect.orElseSucceed(() => undefined));
  });

// Run `use` while holding the repo's exclusive provision lock. The lock is ALWAYS
// released — success, failure, or interrupt — via acquireUseRelease, so a crash
// mid-registry-mutation can't strand it.
export const withRegistryLock = <A, E, R>(repoName: string, use: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    acquireLock(repoName),
    () => use,
    (file) => releaseLock(file),
  );

// Append `toClaim` to the registry under the lock, pruning expired/dead entries
// in the same write. Standalone entry point (resolvePlan claims inline under one
// lock with its pick); used by tests and any caller that just needs to record a
// claim atomically.
export const claimReservations = (
  repoName: string,
  toClaim: ReadonlyArray<Reservation>,
  nowMs: number = Date.now(),
  isAlive: (pid: number) => boolean = isPidAlive,
) =>
  withRegistryLock(
    repoName,
    Effect.gen(function* () {
      const all = yield* readReservations(repoName);
      const live = liveReservations(all, nowMs, isAlive);
      yield* writeReservations(repoName, [...live, ...toClaim]);
    }),
  );

// Drop a branch's reservations once its `.env` is written (or its provision
// failed). Prunes expired/dead entries too. A no-op when the registry is empty,
// so the common no-ports path never creates the file.
export const finalizeReservations = (
  repoName: string,
  branch: string,
  pid: number,
  nowMs: number = Date.now(),
  isAlive: (pid: number) => boolean = isPidAlive,
) =>
  withRegistryLock(
    repoName,
    Effect.gen(function* () {
      const all = yield* readReservations(repoName);
      if (all.length === 0) return;
      const live = liveReservations(all, nowMs, isAlive);
      const remaining = live.filter((r) => !(r.branch === branch && r.pid === pid));
      yield* writeReservations(repoName, remaining);
    }),
  );

// Layer 1: a single shared `Semaphore` (one permit) created at the layer level so
// every worktree fiber of one `homestead` invocation serializes the read-pick-
// write critical section (resolvePlan's port pick → writeEnv).
export class PortAllocator extends Context.Service<PortAllocator>()("homestead/PortAllocator", {
  make: Effect.gen(function* () {
    const semaphore = yield* Semaphore.make(1);
    return { semaphore };
  }),
}) {
  static readonly layer = Layer.effect(PortAllocator, PortAllocator.make);
}
