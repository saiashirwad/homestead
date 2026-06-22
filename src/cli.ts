#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect } from "effect";
import { loadConfig } from "./config.ts";
import { launchAgent } from "./herdr.ts";
import { currentRepoSlug, parseIssueArg, resolveIssue, type IssueRef } from "./issues.ts";
import { listen } from "./listen.ts";
import { killBranch } from "./teardown.ts";
import { markStarted } from "./tracking.ts";
import { resolveRepo, setupWorktree } from "./worktree.ts";
import type { WorktreeOptions } from "./types.ts";

// --- argv helpers (only the entrypoint reads argv; steps take options) ------

const readFlag = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};
const hasFlag = (name: string): boolean => process.argv.includes(`--${name}`);
const flagValue = (name: string): string | undefined => {
  const value = readFlag(name)?.trim();
  return value === undefined || value === "" ? undefined : value;
};
// Work items can be bare numbers or full GitHub issue URLs, in any argv position
// (so `githog 2 3`, `githog implement-issues 2`, and `githog <url>` all parse).
const issueRefs = (): ReadonlyArray<IssueRef> =>
  process.argv
    .slice(2)
    .map(parseIssueArg)
    .filter((ref): ref is IssueRef => ref !== undefined);

// `kill` targets are branch names; a bare number or issue URL maps to its number
// (the default branch scheme). Mirrors how implement-issues names branches.
const killBranches = (): ReadonlyArray<string> =>
  process.argv
    .slice(3)
    .filter((arg) => !arg.startsWith("--"))
    .map((token) => {
      const ref = parseIssueArg(token);
      return ref === undefined ? token : String(ref.number);
    });

const fail = (message: string) => Effect.die(new Error(message));

// --- `githog setup` — provision/isolate one worktree -----------------------

const setupCommand = Effect.fn("githog/cli/setup")(function* () {
  const config = yield* loadConfig(process.cwd());
  const options: WorktreeOptions = {
    create: flagValue("create"),
    from: flagValue("from"),
    dir: flagValue("dir"),
    noSetup: hasFlag("no-setup"),
    dryRun: hasFlag("dry-run"),
  };
  yield* setupWorktree(config, options);
});

// --- `githog implement-issues <n>...` — fan issues out into agents ----------

const implementIssuesCommand = Effect.fn("githog/cli/implement-issues")(
  function* (refs: ReadonlyArray<IssueRef>) {
    if (process.env.HERDR_ENV !== "1") {
      return yield* fail(
        "[githog] not inside a herdr pane (HERDR_ENV != 1) — run this from a herdr terminal.",
      );
    }
    const config = yield* loadConfig(process.cwd());
    if (config.agent === undefined) {
      return yield* fail("[githog] config has no `agent` block — implement-issues needs one to launch claude.");
    }
    const agent = config.agent;
    const issues = config.issues ?? {};
    const branchOf = issues.branch ?? ((item: { number: number }) => String(item.number));
    const repo = yield* resolveRepo();

    // A URL pins owner/repo — it must match the repo you're standing in, since the
    // worktree is branched from the local clone here (no cross-repo resolution).
    const urlRefs = refs.filter((ref) => ref.owner !== undefined);
    if (urlRefs.length > 0) {
      const here = (yield* currentRepoSlug()).toLowerCase();
      for (const ref of urlRefs) {
        const target = `${ref.owner}/${ref.repo}`.toLowerCase();
        if (target !== here) {
          return yield* fail(
            `[githog] issue URL points at ${ref.owner}/${ref.repo}, but you're in ${here}. ` +
              `Run githog from inside ${ref.owner}/${ref.repo}, or pass the bare issue number.`,
          );
        }
      }
    }

    yield* Console.log(`Issues: ${refs.map((r) => `#${r.number}`).join(", ")}`);
    const items = yield* Effect.forEach(refs, resolveIssue);

    // Phase 1 — provision worktrees SEQUENTIALLY. The port scanner reads every
    // sibling's .env; two setups at once both see a stale snapshot and hand out
    // the same port. One at a time, each sees the prior's freshly-written .env.
    const plans = yield* Effect.forEach(items, (item) =>
      setupWorktree(config, { create: branchOf(item) }),
    );

    // Phase 2 — launch each agent, then mark its issue (opt-in via config.issues).
    const pairs = items.map((item, i) => ({ item, plan: plans[i], branch: branchOf(item) }));
    yield* Effect.forEach(
      pairs,
      ({ item, plan, branch }) =>
        plan === undefined
          ? Effect.void
          : Effect.gen(function* () {
              yield* launchAgent(item, plan.targetDir, agent);
              yield* markStarted(repo.repoName, item, branch, plan.targetDir, issues);
            }),
      { discard: true },
    );

    yield* Console.log(
      `\n✅ ${items.length} agent(s) launched. Switch into the issue-* workspaces to watch.`,
    );
  },
);

// --- `githog listen` — poll the repo and auto-implement `agent:ready` issues --

const listenCommand = Effect.fn("githog/cli/listen")(function* () {
  if (process.env.HERDR_ENV !== "1") {
    return yield* fail("[githog] not inside a herdr pane (HERDR_ENV != 1) — run listen from a herdr terminal.");
  }
  const config = yield* loadConfig(process.cwd());
  yield* listen(config);
});

// --- `githog kill <branch>...` — tear a worktree + branch + herdr surface down -

const killCommand = Effect.fn("githog/cli/kill")(function* () {
  const branches = killBranches();
  if (branches.length === 0) {
    return yield* fail("usage: githog kill <branch-or-issue>...");
  }
  const repo = yield* resolveRepo();
  yield* Effect.forEach(branches, (branch) => killBranch(repo.primaryRoot, repo.repoName, branch), {
    discard: true,
  });
  yield* Console.log(`\n✅ killed ${branches.length}: ${branches.join(", ")}`);
});

// --- dispatch ---------------------------------------------------------------

const USAGE = `githog — config-driven worktree + agent provisioning

usage:
  githog setup [--create <branch>] [--from <ref>] [--dir <path>] [--no-setup] [--dry-run]
  githog implement-issues <issue>...     (issue = number or GitHub issue URL)
  githog <issue>...                      (bare form, implies implement-issues)
  githog listen                          (poll for 'agent:ready' issues, auto-implement)
  githog kill <branch-or-issue>...       (remove worktree + branch + herdr surface)
                                         (issue commands run inside a herdr pane)`;

const refs = issueRefs();
const program =
  process.argv[2] === "setup"
    ? setupCommand()
    : process.argv[2] === "listen"
      ? listenCommand()
      : process.argv[2] === "kill"
        ? killCommand()
        : refs.length > 0
          ? implementIssuesCommand(refs)
          : fail(USAGE);

program.pipe(
  Effect.catchTags({
    ConfigNotFound: (error) =>
      fail(`[githog] ${error.detail}\n  Add a githog.config.ts at your repo root: export default defineConfig({ ... })`),
    ConfigInvalid: (error) => fail(`[githog] invalid config at ${error.path}: ${error.reason}`),
    ServiceUnavailable: (error) =>
      fail(`[githog] service '${error.name}' (${error.host}:${error.port}) ${error.detail}`),
  }),
  Effect.provide(BunServices.layer),
  BunRuntime.runMain,
);
