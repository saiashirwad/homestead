import { Console, Effect, FileSystem, Option, Path } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import { resolve as resolvePath } from "node:path";
import * as readline from "node:readline";
import { parseWorktreePorcelain, type WorktreePorcelainEntry } from "./git/porcelain.ts";
import { Herdr } from "./herdr/service.ts";
import { openWorkspaceIdForBranch, type WorktreeEntry } from "./herdr/types.ts";
import { runAfterTeardown } from "./hooks.ts";
import { capture, runExit } from "./process.ts";
import { makeContext } from "./context.ts";
import { readEnvVar, slugify } from "./text.ts";
import {
  deleteLocalBranch,
  pushDeleteRemoteBranch,
  removeHerdrWorktree,
} from "./teardown.ts";
import {
  AGENT_MARKER_FILE,
  itemFromState,
  listTrackedBranches,
  markStopped,
  readAgentMarker,
  type TrackedBranch,
  type TrackingState,
} from "./tracking.ts";
import type { Repo } from "./worktree/repo.ts";
import type { HomesteadConfig, WorkItem } from "./types.ts";

// `homestead gc` — the reconciler for every case the normal teardown path
// (kill/close/complete in src/teardown.ts) was skipped: a `rm -rf`'d worktree, a
// crash mid-run, a config without `afterTeardown`. It SCANS (always read-only,
// builds a plan) then ACTS (only with `--prune`). The scan/classify split keeps
// the safety-critical logic — which worktrees are orphans, which are still the
// user's live work — a pure function with no fs/git/gh, exercised directly in
// gc.test.ts.

export interface GcOptions {
  readonly prune: boolean;
  readonly yes: boolean;
  readonly branches: boolean;
  readonly keepRemote: boolean;
  readonly json: boolean;
}

// Why a worktree is being reclaimed:
//   worktree-gone — its checkout directory is absent on disk (the unambiguous
//     orphan: a `rm -rf` or crash that the teardown path never saw).
//   auto-clean    — the directory still exists but provenance marks it
//     auto-created (an `agent spawn` worktree) AND it has no uncommitted or
//     unpushed work, so reclaiming it can't lose anything.
export type GcReason = "worktree-gone" | "auto-clean";

export interface GcReclaimItem {
  // State-file key (`slugify(branch)`) when a tracking-state file exists.
  readonly slug: string | undefined;
  // Real branch name, recovered by matching the state's worktreeDir to a git
  // worktree entry (state files are keyed by slug and don't store the raw name).
  readonly branch: string | undefined;
  // The registered git worktree path (for `git worktree remove`), if any.
  readonly worktreePath: string | undefined;
  // Where to look for `.env` to reconstruct afterTeardown's context.
  readonly worktreeDir: string | undefined;
  readonly herdrWorkspaceId: string | undefined;
  readonly hasState: boolean;
  // The GitHub work item, carried so afterTeardown's ctx can be rebuilt AFTER
  // markStopped has deleted the state file. Present only when state had a title.
  readonly work: WorkItem | undefined;
  // Whether the worktree's `.env` is still readable. When false, afterTeardown
  // cannot know which DB/bucket to drop and is reported skipped, not guessed.
  readonly envAvailable: boolean;
  readonly reason: GcReason;
}

export interface GcSkipItem {
  readonly branch: string | undefined;
  readonly worktreePath: string;
  readonly reason: "dirty" | "unpushed";
}

export interface GcBranchItem {
  readonly branch: string;
  // Always true in the plan — gc only ever deletes branches it owns (the hard
  // floor deleteRemoteBranch uses). Unowned branches are never planned.
  readonly owned: boolean;
  readonly deleteRemote: boolean;
}

export interface GcPlan {
  readonly reclaim: ReadonlyArray<GcReclaimItem>;
  readonly skipped: ReadonlyArray<GcSkipItem>;
  readonly branches: ReadonlyArray<GcBranchItem>;
}

export interface GcClassifyInput {
  readonly stateFiles: ReadonlyArray<TrackedBranch>;
  readonly gitWorktrees: ReadonlyArray<WorktreePorcelainEntry>;
  // herdr's worktree list, or undefined when herdr is unavailable (degrades the
  // whole pane-id column to undefined, never the command — see scanGc).
  readonly herdrWorktrees: ReadonlyArray<WorktreeEntry> | undefined;
  readonly primaryRoot: string;
  // Resolved (node:path) paths that exist on disk — covers both git worktree
  // paths and the worktreeDir recorded in each state file.
  readonly existingDirs: ReadonlySet<string>;
  // Resolved worktree dirs whose `.env` is still readable.
  readonly envDirs: ReadonlySet<string>;
  // Resolved paths provenance marks auto-created (`.homestead-agent.json` marker
  // or `kind: "spawn"` tracking state).
  readonly autoDirs: ReadonlySet<string>;
  // Resolved paths with an uncommitted tree / unpushed commits (live auto dirs).
  readonly dirtyDirs: ReadonlySet<string>;
  readonly unpushedDirs: ReadonlySet<string>;
  // `refs/heads/<name>` short names that exist locally.
  readonly localBranches: ReadonlySet<string>;
  readonly options: { readonly branches: boolean; readonly keepRemote: boolean };
}

const key = (p: string) => resolvePath(p);

// Pure orphan classifier. No fs/git/gh — every disk/herdr fact is pre-resolved
// into the input sets so the safety rules (orphan vs. live, dirty vs. clean,
// owned vs. not) are unit-testable without a repo.
export const classifyGc = (input: GcClassifyInput): GcPlan => {
  const {
    stateFiles,
    gitWorktrees,
    herdrWorktrees,
    primaryRoot,
    existingDirs,
    envDirs,
    autoDirs,
    dirtyDirs,
    unpushedDirs,
    localBranches,
    options,
  } = input;

  const primary = key(primaryRoot);
  const worktrees = gitWorktrees.filter((e) => key(e.path) !== primary);
  const byPath = new Map(worktrees.map((e) => [key(e.path), e] as const));
  const ownedSlugs = new Set(stateFiles.map((s) => s.branch));

  const herdrId = (branch: string | undefined): string | undefined =>
    branch === undefined || herdrWorktrees === undefined
      ? undefined
      : openWorkspaceIdForBranch(herdrWorktrees, branch);

  const reclaim: Array<GcReclaimItem> = [];
  const skipped: Array<GcSkipItem> = [];
  const reclaimedPaths = new Set<string>(); // resolved paths already turned into items
  const candidateBranches: Array<string> = []; // branches a reclaim touched

  // --- Category 1: stale tracking state ----------------------------------
  // A state file is stale when its worktreeDir is gone on disk OR is no longer a
  // registered git worktree — markStopped never ran, so the issue's WIP signals
  // are still set. Live state (dir present AND registered) is left untouched.
  for (const { branch: slug, state } of stateFiles) {
    const wtDir = state.worktreeDir;
    const exists = wtDir !== undefined && existingDirs.has(key(wtDir));
    const registered = wtDir !== undefined && byPath.has(key(wtDir));
    if (wtDir !== undefined && exists && registered) continue; // live — leave alone

    const entry = wtDir !== undefined ? byPath.get(key(wtDir)) : undefined;
    const realBranch = entry?.branch;
    reclaim.push({
      slug,
      branch: realBranch,
      worktreePath: entry?.path,
      worktreeDir: wtDir,
      herdrWorkspaceId: herdrId(realBranch),
      hasState: true,
      work: state.title !== undefined ? itemFromState(state) : undefined,
      envAvailable: wtDir !== undefined && envDirs.has(key(wtDir)),
      reason: "worktree-gone",
    });
    if (entry?.path !== undefined) reclaimedPaths.add(key(entry.path));
    if (realBranch !== undefined) candidateBranches.push(realBranch);
  }

  // --- Category 2: orphan git worktrees + auto-clean present -------------
  for (const entry of worktrees) {
    const p = key(entry.path);
    if (reclaimedPaths.has(p)) continue; // already reclaimed via its state file
    const exists = existingDirs.has(p);
    const slug = entry.branch !== undefined ? slugify(entry.branch) : undefined;

    if (!exists) {
      // Directory gone but git still registers it — the classic orphan.
      reclaim.push({
        slug,
        branch: entry.branch,
        worktreePath: entry.path,
        worktreeDir: entry.path,
        herdrWorkspaceId: herdrId(entry.branch),
        hasState: slug !== undefined && ownedSlugs.has(slug),
        work: undefined,
        envAvailable: false, // dir gone
        reason: "worktree-gone",
      });
      reclaimedPaths.add(p);
      if (entry.branch !== undefined) candidateBranches.push(entry.branch);
      continue;
    }

    // Directory still exists: only auto-created worktrees are candidates — a
    // worktree without provenance is the user's own live work, never touched.
    if (!autoDirs.has(p)) continue;
    if (dirtyDirs.has(p) || unpushedDirs.has(p)) {
      skipped.push({
        branch: entry.branch,
        worktreePath: entry.path,
        reason: dirtyDirs.has(p) ? "dirty" : "unpushed",
      });
      continue;
    }
    reclaim.push({
      slug,
      branch: entry.branch,
      worktreePath: entry.path,
      worktreeDir: entry.path,
      herdrWorkspaceId: herdrId(entry.branch),
      hasState: slug !== undefined && ownedSlugs.has(slug),
      work: undefined,
      envAvailable: envDirs.has(p),
      reason: "auto-clean",
    });
    reclaimedPaths.add(p);
    if (entry.branch !== undefined) candidateBranches.push(entry.branch);
  }

  // --- Category 4: branches from completed/abandoned work -----------------
  // Off unless --branches. Only branches homestead owns (have tracking state)
  // are ever planned; remote deletion further honors --keep-remote.
  const branches: Array<GcBranchItem> = [];
  if (options.branches) {
    const liveBranches = new Set(
      worktrees
        .filter((e) => existingDirs.has(key(e.path)) && e.branch !== undefined)
        .map((e) => e.branch as string),
    );
    const seen = new Set<string>();
    for (const branch of candidateBranches) {
      if (seen.has(branch)) continue;
      seen.add(branch);
      if (!localBranches.has(branch)) continue; // no local ref — nothing to delete
      if (liveBranches.has(branch)) continue; // still checked out somewhere live
      if (!ownedSlugs.has(slugify(branch))) continue; // hard floor: only our branches
      branches.push({ branch, owned: true, deleteRemote: !options.keepRemote });
    }
  }

  return { reclaim, skipped, branches };
};

// homestead's own artifacts inside an auto worktree — never count them as
// "uncommitted work" when judging whether an auto-clean worktree is reclaimable.
const HOMESTEAD_ARTIFACTS = new Set([".env", AGENT_MARKER_FILE]);

// Parse `git status --porcelain=v2 --branch` into the two facts gc needs: is the
// tree dirty (any tracked change or non-homestead untracked file), and is there
// unpushed work (no upstream, or commits ahead of it). Pure — unit-tested.
export const parseGitStatus = (out: string): { dirty: boolean; unpushed: boolean } => {
  let dirty = false;
  let hasUpstream = false;
  let ahead = 0;
  for (const line of out.split("\n")) {
    if (line === "") continue;
    if (line.startsWith("# branch.upstream ")) {
      hasUpstream = true;
      continue;
    }
    if (line.startsWith("# branch.ab ")) {
      const m = line.match(/\+(\d+)\s+-(\d+)/);
      if (m !== null) ahead = Number(m[1]);
      continue;
    }
    if (line.startsWith("#")) continue;
    if (line.startsWith("? ")) {
      const p = line.slice(2);
      if (HOMESTEAD_ARTIFACTS.has(p) || p.startsWith(".homestead/")) continue;
      dirty = true;
      continue;
    }
    // porcelain v2 changed entries: "1 ", "2 " (rename/copy), "u " (unmerged).
    if (line.startsWith("1 ") || line.startsWith("2 ") || line.startsWith("u ")) dirty = true;
  }
  return { dirty, unpushed: !hasUpstream || ahead > 0 };
};

// capture() demotes spawn/IO failure to a defect (it's dev tooling); the scan
// must survive a git hiccup without dying, so recover defects to "".
const safeCapture = (
  command: string,
  args: ReadonlyArray<string>,
  cwd?: string,
): Effect.Effect<string, never, ChildProcessSpawner.ChildProcessSpawner> =>
  capture(command, args, cwd).pipe(Effect.catchDefect(() => Effect.succeed("")));

// `--branch --porcelain=v2` always prints the `# branch.*` header for a valid
// git dir, so an empty result means the command failed — fail safe (dirty +
// unpushed) so a probe error never lets gc reclaim live work.
const statusOf = (dir: string) =>
  safeCapture("git", ["status", "--porcelain=v2", "--branch"], dir).pipe(
    Effect.map((out) => (out === "" ? { dirty: true, unpushed: true } : parseGitStatus(out))),
  );

// ---------------------------------------------------------------------------
// Scan — read-only. Gathers every disk/git/herdr fact classifyGc needs and
// returns the plan. Touches only `capture`, FileSystem reads, the tracking
// loaders, and herdr's read surface (`worktree.list`) — never a mutation.
// ---------------------------------------------------------------------------
export const scanGc = Effect.fn("homestead/scan-gc")(function* (
  repo: Repo,
  options: GcOptions,
  gitWorktreeList: Effect.Effect<string, never, ChildProcessSpawner.ChildProcessSpawner> = capture(
    "git",
    ["worktree", "list", "--porcelain"],
    repo.startCwd,
  ),
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const herdr = yield* Herdr;

  const gitWorktrees = parseWorktreePorcelain(yield* gitWorktreeList);
  const stateFiles = yield* listTrackedBranches(repo.repoName);
  const herdrWorktrees = Option.getOrUndefined(
    yield* herdr.worktree.list(repo.startCwd).pipe(Effect.option),
  );
  const stateBySlug = new Map(stateFiles.map((s) => [s.branch, s] as const));

  const existingDirs = new Set<string>();
  const envDirs = new Set<string>();
  const autoDirs = new Set<string>();
  const dirtyDirs = new Set<string>();
  const unpushedDirs = new Set<string>();

  // Stat a dir (and its .env); records into existingDirs/envDirs. Returns exists.
  const statDir = (dir: string) =>
    Effect.gen(function* () {
      const k = key(dir);
      const exists = yield* fs.exists(dir).pipe(Effect.orElseSucceed(() => false));
      if (!exists) return false;
      existingDirs.add(k);
      const envExists = yield* fs
        .exists(path.join(dir, ".env"))
        .pipe(Effect.orElseSucceed(() => false));
      if (envExists) envDirs.add(k);
      return true;
    });

  for (const s of stateFiles) {
    if (s.state.worktreeDir !== undefined) yield* statDir(s.state.worktreeDir);
  }

  const primary = key(repo.primaryRoot);
  for (const e of gitWorktrees) {
    if (key(e.path) === primary) continue;
    const exists = yield* statDir(e.path);
    if (!exists) continue;

    // Provenance: the worktree-local marker (like the dashboard) OR a spawn-kind
    // tracking-state file. Only auto-created worktrees that still exist are
    // reclaim candidates; we probe dirtiness only for those.
    const marker = yield* readAgentMarker(e.path);
    const slug = e.branch !== undefined ? slugify(e.branch) : undefined;
    const spawnState = slug !== undefined ? stateBySlug.get(slug) : undefined;
    const auto = Option.isSome(marker) || spawnState?.state.kind === "spawn";
    if (!auto) continue;

    const k = key(e.path);
    autoDirs.add(k);
    const status = yield* statusOf(e.path);
    if (status.dirty) dirtyDirs.add(k);
    if (status.unpushed) unpushedDirs.add(k);
  }

  const localBranches = new Set(
    (yield* safeCapture("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads"], repo.startCwd))
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== ""),
  );

  return classifyGc({
    stateFiles,
    gitWorktrees,
    herdrWorktrees,
    primaryRoot: repo.primaryRoot,
    existingDirs,
    envDirs,
    autoDirs,
    dirtyDirs,
    unpushedDirs,
    localBranches,
    options: { branches: options.branches, keepRemote: options.keepRemote },
  });
});

// ---------------------------------------------------------------------------
// Report — printing + JSON serialization + the freed-ports informational pass.
// ---------------------------------------------------------------------------
export interface FreedPorts {
  readonly branch: string | undefined;
  readonly slug: string | undefined;
  readonly ports: ReadonlyArray<{ readonly key: string; readonly value: string }>;
}

const collectFreedPorts = Effect.fn("homestead/gc-freed-ports")(function* (
  reclaim: ReadonlyArray<GcReclaimItem>,
  config: HomesteadConfig | undefined,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const portKeys = (config?.ports ?? []).map((s) => s.key);
  if (portKeys.length === 0) return [] as ReadonlyArray<FreedPorts>;

  const out: Array<FreedPorts> = [];
  for (const item of reclaim) {
    if (!item.envAvailable || item.worktreeDir === undefined) continue;
    const content = yield* fs
      .readFileString(path.join(item.worktreeDir, ".env"))
      .pipe(Effect.orElseSucceed(() => ""));
    const ports = portKeys
      .map((k) => ({ key: k, value: readEnvVar(content, k) }))
      .filter((p): p is { key: string; value: string } => p.value !== undefined);
    if (ports.length > 0) out.push({ branch: item.branch, slug: item.slug, ports });
  }
  return out as ReadonlyArray<FreedPorts>;
});

const printPlan = Effect.fn("homestead/gc-print-plan")(function* (
  plan: GcPlan,
  freedPorts: ReadonlyArray<FreedPorts>,
  config: HomesteadConfig | undefined,
) {
  yield* Console.log("homestead gc — reclaim plan\n");
  if (plan.reclaim.length === 0 && plan.skipped.length === 0 && plan.branches.length === 0) {
    yield* Console.log("  (no orphaned worktrees, state, or branches found)");
    return;
  }
  if (plan.reclaim.length > 0) {
    yield* Console.log("Reclaim:");
    for (const item of plan.reclaim) {
      const name = item.branch ?? item.slug ?? item.worktreePath ?? "(unknown)";
      const bits: Array<string> = [item.reason];
      if (item.hasState) bits.push("reverse GitHub WIP + delete state");
      if (config?.afterTeardown !== undefined) {
        bits.push(item.envAvailable ? "afterTeardown" : "afterTeardown skipped (env gone)");
      }
      yield* Console.log(`  • ${name} — ${bits.join(", ")}`);
    }
  }
  if (plan.branches.length > 0) {
    yield* Console.log("\nBranches:");
    for (const b of plan.branches) {
      yield* Console.log(`  • ${b.branch}${b.deleteRemote ? " (local + remote)" : " (local only)"}`);
    }
  }
  if (plan.skipped.length > 0) {
    yield* Console.log("\nSkipped — still your live work, never reclaimed:");
    for (const s of plan.skipped) {
      yield* Console.log(`  • ${s.branch ?? s.worktreePath} — ${s.reason}`);
    }
  }
  if (freedPorts.length > 0) {
    yield* Console.log("\nPorts freed (self-heal once the dead worktree is gone):");
    for (const f of freedPorts) {
      yield* Console.log(
        `  • ${f.branch ?? f.slug ?? "?"} — ${f.ports.map((p) => `${p.key}=${p.value}`).join(" ")}`,
      );
    }
  }
});

// Single-line y/N confirmation before any destructive prune.
const confirmPrune = (): Effect.Effect<boolean> =>
  Effect.promise(
    () =>
      new Promise<boolean>((res) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question("\nProceed with reclaim? [y/N] ", (answer) => {
          rl.close();
          res(/^y(es)?$/i.test(answer.trim()));
        });
      }),
  );

// ---------------------------------------------------------------------------
// Act — gated reclamation. Mirrors teardownWorktree's order (herdr → git → state
// → branch → afterTeardown), reusing teardown/tracking primitives wholesale.
// ---------------------------------------------------------------------------
const reclaimItem = Effect.fn("homestead/gc-reclaim-item")(function* (
  repo: Repo,
  config: HomesteadConfig | undefined,
  item: GcReclaimItem,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const label = item.branch ?? item.slug ?? item.worktreePath ?? "(unknown)";
  yield* Console.log(`\n▸ reclaim ${label} (${item.reason})`);

  if (item.branch !== undefined) yield* removeHerdrWorktree(repo.primaryRoot, item.branch);
  if (item.worktreePath !== undefined) {
    yield* Console.log(`  git worktree remove --force ${item.worktreePath}`);
    yield* runExit("git", ["worktree", "remove", "--force", item.worktreePath], {
      cwd: repo.primaryRoot,
    });
  }
  yield* runExit("git", ["worktree", "prune"], { cwd: repo.primaryRoot });

  // markStopped IS the GitHub-WIP reversal + state-file delete; it's keyed by
  // slug, slugify is idempotent, and a missing state file is a clean no-op.
  const slug = item.slug ?? (item.branch !== undefined ? slugify(item.branch) : undefined);
  if (slug !== undefined) yield* markStopped(repo.repoName, slug, config?.issues);

  // afterTeardown only runs when ctx.env can be honestly reconstructed from a
  // live .env — otherwise the hook can't know which DB/bucket to drop.
  if (config?.afterTeardown !== undefined) {
    if (item.envAvailable && item.worktreeDir !== undefined) {
      const content = yield* fs
        .readFileString(path.join(item.worktreeDir, ".env"))
        .pipe(Effect.orElseSucceed(() => ""));
      const branch = item.branch ?? slug ?? "";
      const ctx = makeContext({
        repoName: repo.repoName,
        slug: slug ?? branch,
        branch,
        worktreeDir: item.worktreeDir,
        ...(item.work !== undefined ? { item: item.work } : {}),
        env: (k) => readEnvVar(content, k),
      });
      yield* runAfterTeardown(config.afterTeardown, ctx, "kill");
    } else {
      yield* Console.log(`  afterTeardown skipped — cannot reconstruct env for ${label}`);
    }
  }
});

const deleteBranchItem = Effect.fn("homestead/gc-delete-branch")(function* (
  repo: Repo,
  b: GcBranchItem,
) {
  yield* Console.log(`\n▸ branch ${b.branch}`);
  yield* deleteLocalBranch(repo.primaryRoot, b.branch);
  if (b.deleteRemote) yield* pushDeleteRemoteBranch(repo.primaryRoot, b.branch);
});

export const runGc = Effect.fn("homestead/run-gc")(function* (
  repo: Repo,
  config: HomesteadConfig | undefined,
  options: GcOptions,
) {
  const plan = yield* scanGc(repo, options);
  const freedPorts = yield* collectFreedPorts(plan.reclaim, config);

  if (options.json) {
    yield* Console.log(
      JSON.stringify({ ...plan, freedPorts }, null, 2),
    );
    return;
  }

  yield* printPlan(plan, freedPorts, config);

  const total = plan.reclaim.length + (options.branches ? plan.branches.length : 0);
  if (!options.prune) {
    yield* Console.log(
      total === 0 ? "\nNothing to reclaim." : "\n(dry run — pass --prune to reclaim; nothing changed)",
    );
    return;
  }
  if (total === 0) {
    yield* Console.log("\nNothing to reclaim.");
    return;
  }

  if (!options.yes) {
    const ok = yield* confirmPrune();
    if (!ok) {
      yield* Console.log("Aborted — no changes.");
      return;
    }
  }

  for (const item of plan.reclaim) yield* reclaimItem(repo, config, item);
  if (options.branches) for (const b of plan.branches) yield* deleteBranchItem(repo, b);

  yield* Console.log(
    `\n✅ gc: reclaimed ${plan.reclaim.length} worktree(s)` +
      (options.branches ? `, ${plan.branches.length} branch(es)` : ""),
  );
});
