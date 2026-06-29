import { afterEach, beforeEach, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Context, Effect, FileSystem, Layer, Path } from "effect";
import * as fsSync from "node:fs";
import * as os from "node:os";
import { collectDashboard, renderDashboard, renderTable, type AgentState, type DashboardRow } from "./dashboard.ts";
import type { WorktreePorcelainEntry } from "./git/porcelain.ts";
import { Git, GitLive } from "./git/service.ts";
import { Herdr } from "./herdr/service.ts";
import { HerdrError } from "./herdr/errors.ts";
import { openWorkspaceIdForBranch, type WorktreeEntry } from "./herdr/types.ts";
import { slugify } from "./text.ts";
import type { Repo } from "./worktree/repo.ts";
import type { HomesteadConfig } from "./types.ts";

// ---------------------------------------------------------------------------
// Test scaffolding. `os.homedir()` caches and ignores a mid-process $HOME, so we
// can't sandbox it — instead each test uses a UNIQUE repo name and writes its
// tracking-state files under the real ~/.homestead/state/<repo>/, then removes
// exactly that dir in afterEach. The Herdr stub's every MUTATING method dies if
// touched — collectDashboard must never reach them.
// ---------------------------------------------------------------------------

let sandbox: string; // tmp dir for worktree .env / sentinel / provenance fixtures
let repoName: string; // unique per test, isolates the tracking-state dir
let REPO: Repo;

const stateDirFor = (name: string) => `${os.homedir()}/.homestead/state/${slugify(name)}`;

beforeEach(() => {
  sandbox = fsSync.mkdtempSync(`${os.tmpdir()}/homestead-dash-`);
  repoName = `demo_${sandbox.slice(sandbox.lastIndexOf("/") + 1)}`;
  REPO = { startCwd: "/repo/primary", primaryRoot: "/repo/primary", repoName };
});

afterEach(() => {
  fsSync.rmSync(sandbox, { recursive: true, force: true });
  fsSync.rmSync(stateDirFor(repoName), { recursive: true, force: true });
});

const writeFile = (file: string, content: string) => {
  fsSync.mkdirSync(file.slice(0, file.lastIndexOf("/")), { recursive: true });
  fsSync.writeFileSync(file, content);
};

const writeTrackingState = (branch: string, state: object) =>
  writeFile(`${stateDirFor(repoName)}/${slugify(branch)}.json`, JSON.stringify(state));

// A Herdr whose mutators die on contact; `list` behavior is injected per-test.
const stubHerdr = (
  list: (cwd: string) => Effect.Effect<ReadonlyArray<WorktreeEntry>, HerdrError>,
): Layer.Layer<Herdr> => {
  const die = (op: string) => () => Effect.die(new Error(`collectDashboard touched herdr.${op}`));
  const service = {
    createSurface: die("createSurface"),
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
  effect: Effect.Effect<A, unknown, FileSystem.FileSystem | Path.Path | Git | Herdr>,
  herdr: Layer.Layer<Herdr> = noWorktrees,
): Promise<A> => Effect.runPromise(effect.pipe(Effect.provide(Layer.provideMerge(Layer.mergeAll(GitLive, herdr), BunServices.layer))));

const collect = (
  config: HomesteadConfig | undefined,
  entries: ReadonlyArray<WorktreePorcelainEntry>,
  herdr?: Layer.Layer<Herdr>,
  repo: Repo = REPO,
) => run(collectDashboard(repo, config, Effect.succeed(entries)), herdr);

const renderOnce = (
  config: HomesteadConfig | undefined,
  entries: ReadonlyArray<WorktreePorcelainEntry>,
  herdr?: Layer.Layer<Herdr>,
  repo: Repo = REPO,
) => run(renderDashboard(repo, config, Effect.succeed(entries)), herdr);

const CONFIG: HomesteadConfig = {
  ports: [{ key: "WEB", base: 3000 }, { key: "API", base: 4000 }],
  env: { derivedKeys: ["DATABASE_URL"] },
};

// ---------------------------------------------------------------------------

test("join shape: slug/branch/ports/DB/issue from porcelain + .env + tracking", async () => {
  const wt = `${sandbox}/wt/auth-rework`;
  writeFile(`${wt}/.env`, "WEB=3001\nAPI=4001\nDATABASE_URL=hs_authrework\n");
  writeTrackingState("auth-rework", { number: 142, url: "u", title: "Auth rework" });

  const rows = await collect(CONFIG, [{ path: "/repo/primary", branch: "main" }, { path: wt, branch: "auth-rework" }]);

  expect(rows.length).toBe(1);
  const r = rows[0]!;
  expect(r.slug).toBe("auth_rework");
  expect(r.branch).toBe("auth-rework");
  expect(r.ports).toEqual([{ key: "WEB", value: "3001" }, { key: "API", value: "4001" }]);
  expect(r.db).toEqual([{ key: "DATABASE_URL", value: "hs_authrework" }]);
  expect(r.issue).toBe(142);
  expect(r.title).toBe("Auth rework");
  expect(r.stale).toBe(false);
});

test("primary checkout is excluded from the spine", async () => {
  const rows = await collect(CONFIG, [{ path: "/repo/primary", branch: "main" }]);
  expect(rows).toEqual([]);
});

test("degraded: no .env ⇒ ports + DB empty; no tracking ⇒ issue undefined; row still present", async () => {
  const wt = `${sandbox}/wt/spike`;
  fsSync.mkdirSync(wt, { recursive: true }); // worktree exists, but no .env, no tracking
  const rows = await collect(CONFIG, [{ path: "/repo/primary", branch: "main" }, { path: wt, branch: "spike-redis" }]);

  expect(rows.length).toBe(1);
  const r = rows[0]!;
  expect(r.slug).toBe("spike_redis");
  expect(r.ports).toEqual([]);
  expect(r.db).toEqual([]);
  expect(r.issue).toBeUndefined();
  expect(r.title).toBeUndefined();
});

test("orphan tracking-state (worktree gone) ⇒ one (stale state) row", async () => {
  writeTrackingState("ghost-branch", { number: 7, url: "u", title: "Ghost" });
  const rows = await collect(CONFIG, [{ path: "/repo/primary", branch: "main" }]);

  expect(rows.length).toBe(1);
  const r = rows[0]!;
  expect(r.stale).toBe(true);
  expect(r.slug).toBe("ghost_branch");
  expect(r.branch).toBeUndefined();
  expect(r.issue).toBe(7);
  expect(r.ports).toEqual([]);
  expect(r.pane).toBeUndefined();
});

test("herdr down: worktree.list fails ⇒ pane undefined, command still succeeds", async () => {
  const wt = `${sandbox}/wt/x`;
  fsSync.mkdirSync(wt, { recursive: true });
  const failing = stubHerdr(() => Effect.fail(new HerdrError({ op: "worktree.list", cause: "boom" })));
  const rows = await collect(
    CONFIG,
    [{ path: "/repo/primary", branch: "main" }, { path: wt, branch: "feat-x" }],
    failing,
  );
  expect(rows.length).toBe(1);
  expect(rows[0]!.pane).toBeUndefined();
});

test("pane: live open_workspace_id is surfaced for the matching branch", async () => {
  const wt = `${sandbox}/wt/x`;
  fsSync.mkdirSync(wt, { recursive: true });
  const live = stubHerdr(() => Effect.succeed([{ branch: "feat-x", open_workspace_id: "ws-7" }]));
  const rows = await collect(
    CONFIG,
    [{ path: "/repo/primary", branch: "main" }, { path: wt, branch: "feat-x" }],
    live,
  );
  expect(rows[0]!.pane).toBe("ws-7");
});

test("agent-state mapping: running/done/blocked/failed pass through; missing ⇒ unknown", async () => {
  const make = (branch: string, status: string | undefined) => {
    const wt = `${sandbox}/wt/${branch}`;
    fsSync.mkdirSync(wt, { recursive: true });
    if (status !== undefined) {
      writeFile(`${wt}/.homestead/agent-status.json`, JSON.stringify({ status, summary: "s" }));
    }
    return { path: wt, branch };
  };
  const specs: ReadonlyArray<readonly [string, string | undefined, AgentState]> = [
    ["run-b", "running", "running"],
    ["done-b", "done", "done"],
    ["block-b", "blocked", "blocked"],
    ["fail-b", "failed", "failed"],
    ["none-b", undefined, "unknown"],
    ["junk-b", "garbage", "unknown"], // unparseable status ⇒ unknown
  ];
  const entries = [{ path: "/repo/primary", branch: "main" }, ...specs.map(([b, s]) => make(b, s))];
  const rows = await collect(CONFIG, entries);
  const bySlug = new Map(rows.map((r) => [r.slug, r.agent]));
  for (const [branch, , expected] of specs) {
    expect(bySlug.get(slugify(branch))).toBe(expected);
  }
});

test("read-only: collectDashboard never invokes any mutating herdr method", async () => {
  const wt = `${sandbox}/wt/x`;
  writeFile(`${wt}/.env`, "WEB=3001\n");
  writeTrackingState("feat-x", { number: 1, url: "u", title: "t" });
  // stubHerdr's mutators die on contact; reaching collect() success proves none ran.
  const rows = await collect(
    CONFIG,
    [{ path: "/repo/primary", branch: "main" }, { path: wt, branch: "feat-x" }],
  );
  expect(rows.length).toBe(1);
});

test("runs with no config: ports/DB degrade to empty, row still emitted", async () => {
  const wt = `${sandbox}/wt/x`;
  writeFile(`${wt}/.env`, "WEB=3001\n");
  const rows = await collect(undefined, [{ path: "/repo/primary", branch: "main" }, { path: wt, branch: "feat-x" }]);
  expect(rows.length).toBe(1);
  expect(rows[0]!.ports).toEqual([]);
  expect(rows[0]!.db).toEqual([]);
});

test("origin: provenance marker ⇒ [auto] + spawnedBy; absent ⇒ you", async () => {
  const auto = `${sandbox}/wt/auto`;
  const mine = `${sandbox}/wt/mine`;
  fsSync.mkdirSync(mine, { recursive: true });
  writeFile(
    `${auto}/.homestead-agent.json`,
    JSON.stringify({ kind: "spawn", spawnedBy: "agent spawn", createdAt: "2026-06-29T00:00:00.000Z" }),
  );
  const rows = await collect(
    CONFIG,
    [{ path: "/repo/primary", branch: "main" }, { path: auto, branch: "auto-b" }, { path: mine, branch: "mine-b" }],
  );
  const bySlug = new Map(rows.map((r) => [r.slug, r.origin]));
  expect(bySlug.get("auto_b")).toEqual({ auto: true, spawnedBy: "agent spawn" });
  expect(bySlug.get("mine_b")).toEqual({ auto: false, spawnedBy: undefined });
});

// ---------------------------------------------------------------------------
// renderDashboard — one watch tick == one-shot `ls` (shared render)
// ---------------------------------------------------------------------------

test("renderDashboard returns exactly renderTable(rows) — one tick == one-shot ls", async () => {
  const wt = `${sandbox}/wt/auth-rework`;
  writeFile(`${wt}/.env`, "WEB=3001\nAPI=4001\nDATABASE_URL=hs_authrework\n");
  writeTrackingState("auth-rework", { number: 142, url: "u", title: "Auth rework" });
  const list: ReadonlyArray<WorktreePorcelainEntry> = [{ path: "/repo/primary", branch: "main" }, { path: wt, branch: "auth-rework" }];

  const rows = await collect(CONFIG, list);
  const frame = await renderOnce(CONFIG, list);
  expect(frame).toBe(renderTable(rows));
});

test("renderDashboard shows the empty sentinel when there are no linked worktrees", async () => {
  const frame = await renderOnce(CONFIG, [{ path: "/repo/primary", branch: "main" }]);
  expect(frame).toBe("No linked worktrees.");
});

// ---------------------------------------------------------------------------
// renderTable — pure formatting
// ---------------------------------------------------------------------------

const row = (over: Partial<DashboardRow>): DashboardRow => ({
  slug: "s",
  branch: "s",
  ports: [],
  db: [],
  agent: "unknown",
  pane: undefined,
  origin: { auto: false, spawnedBy: undefined },
  issue: undefined,
  title: undefined,
  stale: false,
  ...over,
});

test("renderTable aligns columns to the widest cell", () => {
  const rows: ReadonlyArray<DashboardRow> = [
    row({
      slug: "auth-rework",
      branch: "auth-rework",
      ports: [{ key: "WEB", value: "3001" }, { key: "API", value: "4001" }],
      db: [{ key: "DB", value: "hs_authrework" }],
      agent: "running",
      pane: "ws-7",
    }),
    row({ slug: "issue-142", branch: "142", agent: "done", origin: { auto: true, spawnedBy: undefined } }),
  ];
  const out = renderTable(rows);
  const lines = out.split("\n");

  expect(lines[0]!.startsWith("SLUG")).toBe(true);
  // Each non-final column header is padded to the widest cell in that column.
  const slugWidth = "auth-rework".length;
  expect(lines[0]!.slice(0, slugWidth)).toBe("SLUG".padEnd(slugWidth));
  expect(lines[1]).toContain("WEB=3001 API=4001");
  expect(lines[2]).toContain("issue-142");
  // The em-dash fallback shows for the empty cells of the second row.
  expect(lines[2]).toContain("—");
  // The SLUG column in every row aligns to the same start position.
  expect(lines[1]!.indexOf("auth-rework")).toBe(0);
  expect(lines[2]!.indexOf("issue-142")).toBe(0);
});
