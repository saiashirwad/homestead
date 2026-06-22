import { Console, Duration, Effect, Ref, Schedule, Schema } from "effect";
import { launchAgent } from "./herdr.ts";
import { capture, runExit } from "./process.ts";
import { claimReady, markStarted } from "./tracking.ts";
import { resolveRepo, setupWorktree } from "./worktree.ts";
import type { GithogConfig, WorkItem } from "./types.ts";

const DEFAULT_READY_LABEL = "agent:ready";
const DEFAULT_WIP_LABEL = "agent:wip";
const DEFAULT_INTERVAL_SECONDS = 30;
const DEFAULT_MAX_CONCURRENT = 3;

// gh issue list rows are decoded, never asserted.
const IssueRows = Schema.Array(Schema.Struct({ number: Schema.Number, url: Schema.String, title: Schema.String }));
const decodeIssueRows = Schema.decodeUnknownEffect(Schema.fromJsonString(IssueRows));
const NumberRows = Schema.Array(Schema.Struct({ number: Schema.Number }));
const decodeNumberRows = Schema.decodeUnknownEffect(Schema.fromJsonString(NumberRows));

// Open issues carrying `label`. Best-effort: a transient gh failure yields [] so
// the poll loop survives to the next tick.
const listByLabel = Effect.fn("githog/listen/list")(function* (label: string) {
  const json = yield* capture("gh", [
    "issue",
    "list",
    "--label",
    label,
    "--state",
    "open",
    "--json",
    "number,url,title",
    "--limit",
    "100",
  ]).pipe(Effect.catchCause(() => Effect.succeed("")));
  if (json === "") return [];
  return yield* decodeIssueRows(json).pipe(Effect.catchCause(() => Effect.succeed([])));
});

// Count open issues with `label` (the active-agent gauge). On failure we report
// the cap so we conservatively DON'T spawn rather than risk a runaway.
const countByLabel = Effect.fn("githog/listen/count")(function* (label: string, capWhenUnknown: number) {
  const json = yield* capture("gh", [
    "issue",
    "list",
    "--label",
    label,
    "--state",
    "open",
    "--json",
    "number",
    "--limit",
    "200",
  ]).pipe(Effect.catchCause(() => Effect.succeed("")));
  if (json === "") return capWhenUnknown;
  const rows = yield* decodeNumberRows(json).pipe(Effect.catchCause(() => Effect.succeed(undefined)));
  return rows === undefined ? capWhenUnknown : rows.length;
});

const branchExists = Effect.fn("githog/listen/branch-exists")(function* (primaryRoot: string, branch: string) {
  return (
    (yield* runExit("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
      cwd: primaryRoot,
    })) === 0
  );
});

// Poll for `ready` issues forever, claiming up to the concurrency cap each tick
// and running the same provision→launch→mark flow as implement-issues. A failure
// on one issue (or one whole tick) logs and continues — the daemon never dies.
export const listen = Effect.fn("githog/listen")(function* (config: GithogConfig) {
  const agent = config.agent;
  if (agent === undefined) {
    return yield* Effect.die(new Error("[githog] config has no `agent` block — listen needs one to launch claude."));
  }
  const repo = yield* resolveRepo();
  const readyLabel = config.listen?.label ?? DEFAULT_READY_LABEL;
  const wipLabel = config.issues?.label ?? DEFAULT_WIP_LABEL;
  const intervalSeconds = config.listen?.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS;
  const maxConcurrent = config.listen?.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  const branchOf = config.issues?.branch ?? ((item: WorkItem) => String(item.number));
  // The claim swaps ready->wip; record state under the wip label so `kill` reverses it.
  const issuesEff = { ...config.issues, label: wipLabel };

  const seen = yield* Ref.make<ReadonlySet<number>>(new Set());

  yield* Console.log(
    `\n▸ githog listen — repo ${repo.repoName}, trigger '${readyLabel}', every ${intervalSeconds}s, max ${maxConcurrent} concurrent agents`,
  );

  const handle = Effect.fn("githog/listen/handle")(function* (item: WorkItem) {
    const branch = branchOf(item);
    if (yield* branchExists(repo.primaryRoot, branch)) {
      yield* Console.log(`  #${item.number}: branch '${branch}' already exists — skipping`);
      return;
    }
    yield* Console.log(`\n▸ #${item.number} claimed (${item.title})`);
    yield* claimReady(readyLabel, wipLabel, item.number); // ready -> wip, up front
    const plan = yield* setupWorktree(config, { create: branch });
    yield* launchAgent(item, plan.targetDir, agent);
    yield* markStarted(repo.repoName, item, branch, plan.targetDir, issuesEff);
  });

  const tick = Effect.gen(function* () {
    const ready = yield* listByLabel(readyLabel);
    if (ready.length === 0) return;
    const active = yield* countByLabel(wipLabel, maxConcurrent);
    let slots = Math.max(0, maxConcurrent - active);
    if (slots === 0) {
      yield* Console.log(`  ${ready.length} ready, but ${active}/${maxConcurrent} agents active — waiting`);
      return;
    }
    const alreadySeen = yield* Ref.get(seen);
    for (const item of ready) {
      if (slots <= 0) break;
      if (alreadySeen.has(item.number)) continue;
      yield* Ref.update(seen, (set) => new Set(set).add(item.number));
      // One bad issue must not abort the tick or the daemon.
      yield* handle(item).pipe(
        Effect.catchCause(() => Console.log(`  ⚠ #${item.number} failed to start (left as '${wipLabel}'; kill to reset)`)),
      );
      slots -= 1;
    }
  }).pipe(Effect.catchCause(() => Console.log(`  ⚠ poll failed (retrying next tick)`)));

  yield* tick.pipe(Effect.repeat(Schedule.spaced(Duration.seconds(intervalSeconds))));
});
