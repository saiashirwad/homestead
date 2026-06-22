import { Duration, Effect, Ref, Schedule, Schema } from "effect";
import { launchAgent } from "./herdr.ts";
import { capture, runExit } from "./process.ts";
import { claimReady, markStarted } from "./tracking.ts";
import { resolveRepo, setupWorktree } from "./worktree.ts";
import type { Reporter } from "./dashboard/reporter.ts";
import type { GithogConfig, WorkItem } from "./types.ts";

const DEFAULT_READY_LABEL = "agent:ready";
const DEFAULT_WIP_LABEL = "agent:wip";
const DEFAULT_INTERVAL_SECONDS = 10;
const DEFAULT_MAX_CONCURRENT = 3;

// gh issue list rows are decoded, never asserted.
const IssueRows = Schema.Array(Schema.Struct({ number: Schema.Number, url: Schema.String, title: Schema.String }));
const decodeIssueRows = Schema.decodeUnknownEffect(Schema.fromJsonString(IssueRows));

// Open issues carrying `label`, or `undefined` when the gh query failed (so the
// caller can skip the tick rather than mistake a failure for "nothing ready").
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
  if (json === "") return undefined;
  return yield* decodeIssueRows(json).pipe(Effect.catchCause(() => Effect.succeed(undefined)));
});

const branchExists = Effect.fn("githog/listen/branch-exists")(function* (primaryRoot: string, branch: string) {
  return (
    (yield* runExit("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
      cwd: primaryRoot,
    })) === 0
  );
});

// Poll for `ready` issues forever, claiming up to the concurrency cap each tick
// and running the same provision→launch→mark flow as implement-issues. Per-issue
// and per-tick failures are caught so the daemon never dies. `reporter` decides
// presentation (plain log vs the TUI dashboard).
export const listen = Effect.fn("githog/listen")(function* (config: GithogConfig, reporter: Reporter) {
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
  const prevQueued = yield* Ref.make<ReadonlySet<number>>(new Set());
  const prevWip = yield* Ref.make<ReadonlySet<number>>(new Set());

  yield* reporter.header({ repoName: repo.repoName, readyLabel, intervalSeconds, maxConcurrent });

  const handle = Effect.fn("githog/listen/handle")(function* (item: WorkItem) {
    const branch = branchOf(item);
    if (yield* branchExists(repo.primaryRoot, branch)) {
      yield* reporter.status({ number: item.number, title: item.title, status: "failed", step: "branch exists" });
      return;
    }
    yield* reporter.focus(item.number);
    yield* reporter.status({ number: item.number, title: item.title, status: "claiming" });
    yield* claimReady(readyLabel, wipLabel, item.number); // ready -> wip, up front
    yield* reporter.status({ number: item.number, title: item.title, status: "provisioning", step: "worktree" });
    const plan = yield* setupWorktree(config, { create: branch });
    yield* launchAgent(item, plan.targetDir, agent);
    yield* markStarted(repo.repoName, item, branch, plan.targetDir, issuesEff);
    yield* reporter.status({ number: item.number, title: item.title, status: "implementing" });
    yield* reporter.focus(undefined);
  });

  const tick = Effect.gen(function* () {
    const ready = yield* listByLabel(readyLabel);
    const wip = yield* listByLabel(wipLabel);
    if (ready === undefined || wip === undefined) return; // a query failed — skip this tick

    const wipNums = new Set(wip.map((row) => row.number));
    const prevQ = yield* Ref.get(prevQueued);
    const prevW = yield* Ref.get(prevWip);
    const newNumbers = ready.filter((row) => !prevQ.has(row.number)).map((row) => row.number);
    const finishedNumbers = [...prevW].filter((n) => !wipNums.has(n));
    yield* reporter.poll({ queued: ready, active: wip.length, newNumbers, finishedNumbers });
    yield* Ref.set(prevQueued, new Set(ready.map((row) => row.number)));
    yield* Ref.set(prevWip, wipNums);

    let slots = Math.max(0, maxConcurrent - wip.length);
    if (slots === 0) return;
    const alreadySeen = yield* Ref.get(seen);
    for (const item of ready) {
      if (slots <= 0) break;
      if (alreadySeen.has(item.number)) continue;
      yield* Ref.update(seen, (set) => new Set(set).add(item.number));
      yield* handle(item).pipe(
        Effect.catchCause(() =>
          reporter.status({ number: item.number, title: item.title, status: "failed", step: "setup error" }),
        ),
      );
      slots -= 1;
    }
  }).pipe(Effect.catchCause(() => Effect.void)); // never let one bad poll kill the loop

  yield* tick.pipe(Effect.repeat(Schedule.spaced(Duration.seconds(intervalSeconds))));
});
