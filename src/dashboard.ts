import { Effect, FileSystem, Option, Path, Schema } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import { parseWorktreePorcelain } from "./git/porcelain.ts";
import { capture } from "./process.ts";
import { readEnvVar, slugify } from "./text.ts";
import { listTrackedBranches, readAgentMarker } from "./tracking.ts";
import { Herdr } from "./herdr/service.ts";
import { openWorkspaceIdForBranch } from "./herdr/types.ts";
import { AGENT_STATUS_RELPATH } from "./agent/status.ts";
import type { Repo } from "./worktree/repo.ts";
import type { HomesteadConfig } from "./types.ts";

// The agent's self-reported state. `running` is forward-compat with the
// not-yet-built keystone (today's sentinel only writes done/blocked/failed);
// anything absent or unparseable degrades to `unknown`.
export type AgentState = "running" | "done" | "blocked" | "failed" | "unknown";

// A keyed env value resolved from a worktree's own .env. `value` is the raw
// string read; a key absent from .env simply isn't included.
export interface EnvCell {
  readonly key: string;
  readonly value: string;
}

// One worktree, joined across git / .env / tracking / herdr / sentinel /
// provenance. Structured so a future `--json` flag is a thin serializer and
// `renderTable` only formats. `issue`/`title` are carried for `--json` even
// though the phase-1 table doesn't print them.
export interface DashboardRow {
  readonly slug: string;
  readonly branch: string | undefined;
  readonly ports: ReadonlyArray<EnvCell>;
  readonly db: ReadonlyArray<EnvCell>;
  readonly agent: AgentState;
  // herdr `open_workspace_id` for this branch; `undefined` ⇒ no live pane OR
  // herdr unavailable (the whole column degrades together — see collectDashboard).
  readonly pane: string | undefined;
  readonly origin: { readonly auto: boolean; readonly spawnedBy: string | undefined };
  readonly issue: number | undefined;
  readonly title: string | undefined;
  // An orphaned tracking-state file whose worktree is gone — surfaced, not crashed.
  readonly stale: boolean;
}

// Lenient sentinel reader for the dashboard: only the `status` field matters and
// `running` is accepted (the strict AgentStatusFileSchema used by `agent wait`
// rejects it). Absent/unreadable/other ⇒ `unknown`.
const DashboardStatusSchema = Schema.Struct({
  status: Schema.Literals(["running", "done", "blocked", "failed"]),
});

const readAgentState = (worktreeDir: string): Effect.Effect<AgentState, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(worktreeDir, AGENT_STATUS_RELPATH);
    const exists = yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false));
    if (!exists) return "unknown";
    const content = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
    if (content === "") return "unknown";
    const decoded = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(DashboardStatusSchema))(content).pipe(
      Effect.map((s) => s.status as AgentState),
      Effect.orElseSucceed(() => "unknown" as AgentState),
    );
    return decoded;
  });

// Read a worktree's own .env once; resolve each requested key. A missing/empty
// .env returns no cells, so the caller renders the column as `—`.
const readEnvCells = (
  envContent: string | undefined,
  keys: ReadonlyArray<string>,
): ReadonlyArray<EnvCell> => {
  if (envContent === undefined) return [];
  const cells: Array<EnvCell> = [];
  for (const key of keys) {
    const value = readEnvVar(envContent, key);
    if (value !== undefined) cells.push({ key, value });
  }
  return cells;
};

// Join four read-only sources into one row per linked worktree. Git worktrees
// are the spine (the primary checkout is excluded); .env, tracking state, herdr,
// the agent sentinel, and the provenance marker each left-join and degrade
// independently. Orphaned tracking-state files are appended as `(stale state)`
// rows. STRICTLY READ-ONLY: only `capture`, FileSystem reads, the tracking
// loaders, and herdr's read surface (`worktree.list`) are touched.
export const collectDashboard = Effect.fn("homestead/collect-dashboard")(function* (
  repo: Repo,
  config: HomesteadConfig | undefined,
  // The git-worktree spine, injectable so tests can supply fixture porcelain
  // without a real repo. Defaults to the live read (`git worktree list`).
  gitWorktreeList: Effect.Effect<string, never, ChildProcessSpawner.ChildProcessSpawner> = capture(
    "git",
    ["worktree", "list", "--porcelain"],
    repo.startCwd,
  ),
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const herdr = yield* Herdr;

  const portKeys = (config?.ports ?? []).map((spec) => spec.key);
  const dbKeys = config?.env?.derivedKeys ?? [];

  // Pane column: one `worktree.list` call. Any herdr failure (errored, or simply
  // not inside a herdr terminal) degrades the ENTIRE column to `—`, never the
  // command. `Option.none` here means "herdr unavailable".
  const herdrWorktrees = yield* herdr.worktree.list(repo.startCwd).pipe(Effect.option);
  const paneFor = (branch: string | undefined): string | undefined =>
    Option.isNone(herdrWorktrees) || branch === undefined
      ? undefined
      : openWorkspaceIdForBranch(herdrWorktrees.value, branch);

  // Spine: git worktrees, minus the primary checkout (not an isolated env).
  const worktreeList = yield* gitWorktreeList;
  const entries = parseWorktreePorcelain(worktreeList).filter(
    (entry) => path.resolve(entry.path) !== path.resolve(repo.primaryRoot),
  );

  // Tracking state, keyed by branch-slug — supplies issue/title and lets us
  // detect orphans (state files whose worktree was removed).
  const tracked = yield* listTrackedBranches(repo.repoName);
  const trackedBySlug = new Map(tracked.map((t) => [t.branch, t] as const));
  const matchedSlugs = new Set<string>();

  const rows: Array<DashboardRow> = [];

  for (const entry of entries) {
    const branch = entry.branch;
    const slug = branch !== undefined ? slugify(branch) : slugify(path.basename(entry.path));

    const envPath = path.join(entry.path, ".env");
    const envExists = yield* fs.exists(envPath).pipe(Effect.orElseSucceed(() => false));
    const envContent = envExists
      ? yield* fs.readFileString(envPath).pipe(Effect.orElseSucceed(() => undefined))
      : undefined;

    const agent = yield* readAgentState(entry.path);
    const marker = yield* readAgentMarker(entry.path);

    const trackedEntry = trackedBySlug.get(slug);
    if (trackedEntry !== undefined) matchedSlugs.add(slug);

    rows.push({
      slug,
      branch,
      ports: readEnvCells(envContent, portKeys),
      db: readEnvCells(envContent, dbKeys),
      agent,
      pane: paneFor(branch),
      origin: Option.isSome(marker)
        ? { auto: true, spawnedBy: marker.value.spawnedBy }
        : { auto: false, spawnedBy: undefined },
      issue: trackedEntry?.state.number,
      title: trackedEntry?.state.title,
      stale: false,
    });
  }

  // Orphans: tracking-state files with no matching worktree on disk. Every
  // git/.env/pane cell is `—`; we still surface the issue/title we know.
  for (const t of tracked) {
    if (matchedSlugs.has(t.branch)) continue;
    rows.push({
      slug: t.branch,
      branch: undefined,
      ports: [],
      db: [],
      agent: "unknown",
      pane: undefined,
      origin: { auto: false, spawnedBy: undefined },
      issue: t.state.number,
      title: t.state.title,
      stale: true,
    });
  }

  return rows as ReadonlyArray<DashboardRow>;
});

const EM_DASH = "—";

const renderEnv = (cells: ReadonlyArray<EnvCell>): string =>
  cells.length === 0 ? EM_DASH : cells.map((c) => `${c.key}=${c.value}`).join(" ");

const renderOrigin = (origin: DashboardRow["origin"]): string => {
  if (!origin.auto) return "you";
  return origin.spawnedBy !== undefined ? `[auto] ${origin.spawnedBy}` : "[auto]";
};

const COLUMNS = ["SLUG", "BRANCH", "PORTS", "DB", "AGENT", "PANE", "ORIGIN"] as const;

const cellsFor = (row: DashboardRow): ReadonlyArray<string> => [
  row.slug,
  row.stale ? "(stale state)" : (row.branch ?? EM_DASH),
  renderEnv(row.ports),
  renderEnv(row.db),
  row.agent,
  row.pane ?? EM_DASH,
  renderOrigin(row.origin),
];

// Render an aligned, fixed-width table. Each column is padded to the widest
// cell (header included); a trailing column is left unpadded. Pure formatting.
export const renderTable = (rows: ReadonlyArray<DashboardRow>): string => {
  const body = rows.map(cellsFor);
  const widths = COLUMNS.map((header, col) =>
    Math.max(header.length, ...body.map((cells) => cells[col]!.length)),
  );
  const line = (cells: ReadonlyArray<string>): string =>
    cells
      .map((cell, col) => (col === cells.length - 1 ? cell : cell.padEnd(widths[col]!)))
      .join("  ")
      .trimEnd();
  return [line(COLUMNS), ...body.map(line)].join("\n");
};
