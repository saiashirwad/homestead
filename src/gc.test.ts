import { afterEach, beforeEach, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Context, Effect, FileSystem, Layer, Path } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import * as fsSync from "node:fs";
import * as os from "node:os";
import { resolve } from "node:path";
import {
  classifyGc,
  parseGitStatus,
  scanGc,
  type GcClassifyInput,
} from "./gc.ts";
import { Herdr } from "./herdr/service.ts";
import { HerdrError } from "./herdr/errors.ts";
import { openWorkspaceIdForBranch, type WorktreeEntry } from "./herdr/types.ts";
import { slugify } from "./text.ts";
import type { TrackedBranch, TrackingState } from "./tracking.ts";
import type { WorktreePorcelainEntry } from "./git/porcelain.ts";
import type { Repo } from "./worktree/repo.ts";

// ---------------------------------------------------------------------------
// classifyGc — the pure orphan classifier. No fs/git/gh: every disk fact is a
// pre-resolved Set, so the safety rules are exercised directly.
// ---------------------------------------------------------------------------

const PRIMARY = "/repo/primary";

const wt = (path: string, branch?: string): WorktreePorcelainEntry => ({ path, branch });

const state = (worktreeDir: string | undefined, over: Partial<TrackingState> = {}): TrackingState => ({
  kind: "issue",
  worktreeDir,
  ...over,
});

const trackedFile = (branch: string, st: TrackingState): TrackedBranch => ({ branch, state: st });

const base: Omit<GcClassifyInput, "stateFiles" | "gitWorktrees"> = {
  herdrWorktrees: undefined,
  primaryRoot: PRIMARY,
  existingDirs: new Set(),
  envDirs: new Set(),
  autoDirs: new Set(),
  dirtyDirs: new Set(),
  unpushedDirs: new Set(),
  localBranches: new Set(),
  options: { branches: false, keepRemote: false },
};

const classify = (over: Partial<GcClassifyInput>): ReturnType<typeof classifyGc> =>
  classifyGc({ stateFiles: [], gitWorktrees: [wt(PRIMARY, "main")], ...base, ...over });

test("stale state (worktreeDir gone) is reclaimed; live state is left alone", () => {
  const live = "/wt/live";
  const gone = "/wt/gone";
  const plan = classify({
    stateFiles: [
      trackedFile("live", state(live, { number: 1, title: "Live" })),
      trackedFile("gone", state(gone, { number: 2, title: "Gone" })),
    ],
    gitWorktrees: [wt(PRIMARY, "main"), wt(live, "live-branch")],
    existingDirs: new Set([resolve(live)]), // only the live dir is on disk + registered
  });

  expect(plan.reclaim.map((r) => r.slug)).toEqual(["gone"]);
  const r = plan.reclaim[0]!;
  expect(r.hasState).toBe(true);
  expect(r.reason).toBe("worktree-gone");
  expect(r.work).toEqual({ number: 2, url: "", title: "Gone" });
});

test("orphan git worktree (path absent) reclaimed; live non-auto worktree untouched", () => {
  const livePath = "/wt/live";
  const orphanPath = "/wt/orphan";
  const plan = classify({
    gitWorktrees: [wt(PRIMARY, "main"), wt(livePath, "live"), wt(orphanPath, "orphan")],
    existingDirs: new Set([resolve(livePath)]), // orphan dir is gone
  });

  expect(plan.reclaim.map((r) => r.worktreePath)).toEqual([orphanPath]);
  expect(plan.reclaim[0]!.branch).toBe("orphan");
  expect(plan.reclaim[0]!.hasState).toBe(false);
});

test("branch name is recovered by matching the state's worktreeDir to a git worktree", () => {
  const dir = "/wt/feature";
  const plan = classify({
    // state file is keyed by slug and does NOT store the raw branch name
    stateFiles: [trackedFile(slugify("feat/login"), state(dir, { number: 9 }))],
    gitWorktrees: [wt(PRIMARY, "main"), wt(dir, "feat/login")],
    existingDirs: new Set(), // dir gone → stale, but still registered so branch resolves
  });

  expect(plan.reclaim).toHaveLength(1);
  expect(plan.reclaim[0]!.branch).toBe("feat/login");
  expect(plan.reclaim[0]!.worktreePath).toBe(dir);
});

test("auto-created worktree that is dirty/unpushed is skipped, never reclaimed", () => {
  const dirtyPath = "/wt/dirty";
  const unpushedPath = "/wt/unpushed";
  const cleanPath = "/wt/clean";
  const plan = classify({
    gitWorktrees: [wt(PRIMARY, "main"), wt(dirtyPath, "dirty"), wt(unpushedPath, "unpushed"), wt(cleanPath, "clean")],
    existingDirs: new Set([resolve(dirtyPath), resolve(unpushedPath), resolve(cleanPath)]),
    autoDirs: new Set([resolve(dirtyPath), resolve(unpushedPath), resolve(cleanPath)]),
    dirtyDirs: new Set([resolve(dirtyPath)]),
    unpushedDirs: new Set([resolve(unpushedPath)]),
  });

  expect(plan.skipped.map((s) => ({ b: s.branch, r: s.reason }))).toEqual([
    { b: "dirty", r: "dirty" },
    { b: "unpushed", r: "unpushed" },
  ]);
  // only the clean auto worktree is reclaimed
  expect(plan.reclaim.map((r) => r.branch)).toEqual(["clean"]);
  expect(plan.reclaim[0]!.reason).toBe("auto-clean");
});

test("a still-present worktree with no provenance is never a candidate", () => {
  const mine = "/wt/mine";
  const plan = classify({
    gitWorktrees: [wt(PRIMARY, "main"), wt(mine, "mine")],
    existingDirs: new Set([resolve(mine)]),
    // not in autoDirs → user's own live work
  });
  expect(plan.reclaim).toEqual([]);
  expect(plan.skipped).toEqual([]);
});

test("a stale state and its orphan git worktree collapse to one reclaim item", () => {
  const dir = "/wt/x";
  const plan = classify({
    stateFiles: [trackedFile("x", state(dir, { number: 5, title: "X" }))],
    gitWorktrees: [wt(PRIMARY, "main"), wt(dir, "x-branch")],
    existingDirs: new Set(), // dir gone
  });
  expect(plan.reclaim).toHaveLength(1);
  expect(plan.reclaim[0]!.slug).toBe("x");
  expect(plan.reclaim[0]!.branch).toBe("x-branch");
});

test("envAvailable reflects whether the worktree .env still exists", () => {
  const withEnv = "/wt/withenv";
  const noEnv = "/wt/noenv";
  const plan = classify({
    stateFiles: [
      trackedFile("withenv", state(withEnv, { number: 1 })),
      trackedFile("noenv", state(noEnv, { number: 2 })),
    ],
    gitWorktrees: [wt(PRIMARY, "main")],
    // neither is a registered worktree → both stale; only one has a .env on disk
    existingDirs: new Set(),
    envDirs: new Set([resolve(withEnv)]),
  });
  const bySlug = new Map(plan.reclaim.map((r) => [r.slug, r.envAvailable]));
  expect(bySlug.get("withenv")).toBe(true);
  expect(bySlug.get("noenv")).toBe(false);
});

test("branches are excluded unless --branches, and remote honors --keep-remote", () => {
  const dir = "/wt/feat";
  const input: Partial<GcClassifyInput> = {
    stateFiles: [trackedFile("feat", state(dir, { number: 3 }))],
    gitWorktrees: [wt(PRIMARY, "main"), wt(dir, "feat")],
    existingDirs: new Set(), // orphan, branch "feat" recovered
    localBranches: new Set(["feat"]),
  };

  // default: no branch items
  expect(classify(input).branches).toEqual([]);

  // --branches: owned branch planned, remote deleted
  const withBranches = classify({ ...input, options: { branches: true, keepRemote: false } });
  expect(withBranches.branches).toEqual([{ branch: "feat", owned: true, deleteRemote: true }]);

  // --keep-remote: local only
  const keepRemote = classify({ ...input, options: { branches: true, keepRemote: true } });
  expect(keepRemote.branches).toEqual([{ branch: "feat", owned: true, deleteRemote: false }]);
});

test("--branches never plans a branch homestead doesn't own", () => {
  const orphanPath = "/wt/orphan";
  const plan = classify({
    gitWorktrees: [wt(PRIMARY, "main"), wt(orphanPath, "someones-branch")],
    existingDirs: new Set(), // orphan worktree, but no tracking state ⇒ unowned
    localBranches: new Set(["someones-branch"]),
    options: { branches: true, keepRemote: false },
  });
  expect(plan.reclaim).toHaveLength(1); // the worktree is still reclaimed
  expect(plan.branches).toEqual([]); // but the branch is never deleted
});

// ---------------------------------------------------------------------------
// parseGitStatus — porcelain v2 → {dirty, unpushed}
// ---------------------------------------------------------------------------

test("parseGitStatus: clean tree with upstream, all pushed", () => {
  const out = ["# branch.oid abc", "# branch.head feat", "# branch.upstream origin/feat", "# branch.ab +0 -0"].join("\n");
  expect(parseGitStatus(out)).toEqual({ dirty: false, unpushed: false });
});

test("parseGitStatus: commits ahead of upstream ⇒ unpushed", () => {
  const out = ["# branch.upstream origin/feat", "# branch.ab +2 -0"].join("\n");
  expect(parseGitStatus(out).unpushed).toBe(true);
});

test("parseGitStatus: no upstream ⇒ unpushed (can't prove pushed)", () => {
  const out = ["# branch.oid abc", "# branch.head feat"].join("\n");
  expect(parseGitStatus(out).unpushed).toBe(true);
});

test("parseGitStatus: tracked change ⇒ dirty; homestead artifacts don't count", () => {
  const tracked = ["# branch.upstream origin/feat", "# branch.ab +0 -0", "1 .M N... 100644 100644 100644 a a src/x.ts"].join("\n");
  expect(parseGitStatus(tracked).dirty).toBe(true);

  const onlyArtifacts = [
    "# branch.upstream origin/feat",
    "# branch.ab +0 -0",
    "? .env",
    "? .homestead-agent.json",
    "? .homestead/agent-status.json",
  ].join("\n");
  expect(parseGitStatus(onlyArtifacts).dirty).toBe(false);

  const realUntracked = ["# branch.upstream origin/feat", "# branch.ab +0 -0", "? notes.md"].join("\n");
  expect(parseGitStatus(realUntracked).dirty).toBe(true);
});

// ---------------------------------------------------------------------------
// scanGc — read-only end-to-end. Same sandbox approach as dashboard.test.ts:
// unique repo name isolates the real ~/.homestead/state dir; the Herdr stub's
// mutators die on contact, so reaching success proves the scan never mutates.
// ---------------------------------------------------------------------------

let sandbox: string;
let repoName: string;
let REPO: Repo;

const stateDirFor = (name: string) => `${os.homedir()}/.homestead/state/${slugify(name)}`;

beforeEach(() => {
  sandbox = fsSync.mkdtempSync(`${os.tmpdir()}/homestead-gc-`);
  repoName = `gcdemo_${sandbox.slice(sandbox.lastIndexOf("/") + 1)}`;
  REPO = { startCwd: sandbox, primaryRoot: `${sandbox}/primary`, repoName };
  fsSync.mkdirSync(REPO.primaryRoot, { recursive: true });
});

afterEach(() => {
  fsSync.rmSync(sandbox, { recursive: true, force: true });
  fsSync.rmSync(stateDirFor(repoName), { recursive: true, force: true });
});

const writeFile = (file: string, content: string) => {
  fsSync.mkdirSync(file.slice(0, file.lastIndexOf("/")), { recursive: true });
  fsSync.writeFileSync(file, content);
};

const writeTrackingState = (branch: string, st: object) =>
  writeFile(`${stateDirFor(repoName)}/${slugify(branch)}.json`, JSON.stringify(st));

const porcelain = (entries: ReadonlyArray<{ path: string; branch?: string }>): string =>
  entries
    .map((e) => `worktree ${e.path}\n${e.branch !== undefined ? `branch refs/heads/${e.branch}\n` : ""}`)
    .join("\n");

const stubHerdr = (
  list: (cwd: string) => Effect.Effect<ReadonlyArray<WorktreeEntry>, HerdrError>,
): Layer.Layer<Herdr> => {
  const die = (op: string) => () => Effect.die(new Error(`scanGc touched herdr.${op}`));
  const service = {
    createSurface: die("createSurface"),
    findOrCreateWorkspace: die("findOrCreateWorkspace"),
    pane: { run: die("pane.run"), sendText: die("pane.sendText"), sendKeys: die("pane.sendKeys"), read: die("pane.read") },
    worktree: {
      list,
      remove: die("worktree.remove"),
      findOpenWorkspaceId: (cwd: string, branch: string) =>
        list(cwd).pipe(Effect.map((w) => openWorkspaceIdForBranch(w, branch))),
    },
    waitForMarker: die("waitForMarker"),
    waitUntilGone: die("waitUntilGone"),
  } as unknown as typeof Herdr.Service;
  return Layer.succeedContext(Context.make(Herdr, service));
};

const noWorktrees = stubHerdr(() => Effect.succeed([]));

const run = <A>(
  effect: Effect.Effect<A, unknown, FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner | Herdr>,
  herdr: Layer.Layer<Herdr> = noWorktrees,
): Promise<A> => Effect.runPromise(effect.pipe(Effect.provide(Layer.mergeAll(BunServices.layer, herdr))));

const OPTIONS = { prune: false, yes: false, branches: false, keepRemote: false, json: false };

test("scanGc: stale state (worktreeDir absent on disk) ⇒ reclaim, and it mutates nothing", async () => {
  const gone = `${sandbox}/wt/ghost`;
  writeTrackingState("ghost", { number: 7, url: "u", title: "Ghost", worktreeDir: gone });

  const stateFile = `${stateDirFor(repoName)}/ghost.json`;
  expect(fsSync.existsSync(stateFile)).toBe(true);

  const plan = await run(
    scanGc(REPO, OPTIONS, Effect.succeed(porcelain([{ path: REPO.primaryRoot, branch: "main" }]))),
  );

  expect(plan.reclaim).toHaveLength(1);
  expect(plan.reclaim[0]!.slug).toBe("ghost");
  expect(plan.reclaim[0]!.envAvailable).toBe(false);
  // read-only: the state file is still there (the Herdr stub would have died on any mutation).
  expect(fsSync.existsSync(stateFile)).toBe(true);
});

test("scanGc: a live tracked worktree on disk is not reclaimed", async () => {
  const live = `${sandbox}/wt/live`;
  fsSync.mkdirSync(live, { recursive: true });
  writeTrackingState("live", { number: 1, url: "u", title: "Live", worktreeDir: live });

  const plan = await run(
    scanGc(
      REPO,
      OPTIONS,
      Effect.succeed(porcelain([{ path: REPO.primaryRoot, branch: "main" }, { path: live, branch: "live" }])),
    ),
  );
  expect(plan.reclaim).toEqual([]);
});

test("scanGc: auto-created worktree (.homestead-agent.json) with a clean .env-only tree is reclaimable", async () => {
  // We can't make `git status` clean without a real repo, so this asserts the
  // provenance path: an auto worktree IS picked up as a candidate (its dirtiness
  // is then decided by statusOf, which fails-safe to skip in this non-git dir).
  const auto = `${sandbox}/wt/auto`;
  writeFile(`${auto}/.homestead-agent.json`, JSON.stringify({ kind: "spawn", spawnedBy: "agent spawn", createdAt: "2026-06-29T00:00:00.000Z" }));

  const plan = await run(
    scanGc(
      REPO,
      OPTIONS,
      Effect.succeed(porcelain([{ path: REPO.primaryRoot, branch: "main" }, { path: auto, branch: "auto-b" }])),
    ),
  );
  // statusOf can't run git here ⇒ fails safe to dirty/unpushed ⇒ skipped, never reclaimed.
  expect(plan.reclaim).toEqual([]);
  expect(plan.skipped.map((s) => s.branch)).toEqual(["auto-b"]);
});

test("scanGc: herdr unavailable still yields a plan (pane ids just degrade)", async () => {
  const gone = `${sandbox}/wt/ghost`;
  writeTrackingState("ghost", { number: 7, url: "u", title: "Ghost", worktreeDir: gone });
  const failing = stubHerdr(() => Effect.fail(new HerdrError({ op: "worktree.list", cause: "boom" })));

  const plan = await run(
    scanGc(REPO, OPTIONS, Effect.succeed(porcelain([{ path: REPO.primaryRoot, branch: "main" }]))),
    failing,
  );
  expect(plan.reclaim).toHaveLength(1);
  expect(plan.reclaim[0]!.herdrWorkspaceId).toBeUndefined();
});
