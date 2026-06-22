import { Duration, Effect, Ref, Schedule, Schema } from "effect";
import { launchAgent } from "./herdr.ts";
import { capture, runExit } from "./process.ts";
import { claimReady, markBlocked, markStarted } from "./tracking.ts";
import { resolveRepo, setupWorktree } from "./worktree.ts";
import type { Reporter } from "./dashboard/reporter.ts";
import type { GithogConfig, WorkItem } from "./types.ts";

// The single source of truth for the trigger ("ready") label — the queue githog
// drains. Both the `listen` daemon and the seeded `githog-new-issue` skill name it,
// so it lives here and is resolved through `resolveReadyLabel` to stay in lockstep.
export const DEFAULT_READY_LABEL = "agent:ready";
const DEFAULT_WIP_LABEL = "agent:wip";
const DEFAULT_BLOCKED_LABEL = "agent:blocked";
const DEFAULT_INTERVAL_SECONDS = 30;
const DEFAULT_MAX_CONCURRENT = 3;

// The effective trigger label for a loaded config: the `listen.label` override when
// set to a non-empty string, else the default. Trimmed so a blank override can't
// silently produce an empty (un-listenable) label.
export const resolveReadyLabel = (config: GithogConfig): string => {
  const override = config.listen?.label;
  return override !== undefined && override.trim() !== "" ? override : DEFAULT_READY_LABEL;
};
// How long an issue may sit in `wip` with no live loop process before the daemon
// reclaims its slot. Comfortably longer than worktree setup (install + vendoring),
// so an issue still provisioning — wip-but-no-loop-yet — is never reclaimed.
const ORPHAN_GRACE_MS = 5 * 60 * 1000;

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

// Is a `githog loop` still running for this issue? The loop is one long-lived
// `bun … loop <issue-url>` process that outlives each `claude -p` iteration, so its
// presence means alive, its absence means the loop died. We match `/issues/<n>` in
// the process list (the `(?!\d)` keeps #3 from matching #30). Single-box assumption,
// which is what `listen` is for. On any uncertainty (ps unavailable) we assume ALIVE
// so a flaky check can never reclaim a healthy loop.
const loopAlive = Effect.fn("githog/listen/loop-alive")(function* (number: number) {
  const out = yield* capture("ps", ["-A", "-ww", "-o", "command="]).pipe(
    Effect.catchCause(() => Effect.succeed("")),
  );
  if (out === "") return true;
  return new RegExp(`/issues/${number}(?!\\d)`).test(out);
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
  const readyLabel = resolveReadyLabel(config);
  const wipLabel = config.issues?.label ?? DEFAULT_WIP_LABEL;
  const blockedLabel = config.issues?.blockedLabel ?? DEFAULT_BLOCKED_LABEL;
  const intervalSeconds = config.listen?.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS;
  const maxConcurrent = config.listen?.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  const branchOf = config.issues?.branch ?? ((item: WorkItem) => String(item.number));
  // The claim swaps ready->wip; record state under the wip label so `kill` reverses it.
  const issuesEff = { ...config.issues, label: wipLabel };

  const seen = yield* Ref.make<ReadonlySet<number>>(new Set());
  const prevQueued = yield* Ref.make<ReadonlySet<number>>(new Set());
  const prevWip = yield* Ref.make<ReadonlySet<number>>(new Set());
  // issue number -> first tick (ms) we saw it `wip` with no live loop process.
  const firstDead = yield* Ref.make<ReadonlyMap<number, number>>(new Map());

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

    // Reclaim orphaned slots: an issue stuck in `wip` whose loop process has been
    // gone past the grace window (crashed, machine slept, pane killed) would hold a
    // slot forever, since the gauge counts `wip`. Move it to `blocked` so the slot
    // frees and a human can see it. Grace > setup time, so we never reclaim an issue
    // that's merely still provisioning (wip but no loop yet).
    const now = Date.now();
    const dead = new Map(yield* Ref.get(firstDead));
    let reclaimed = 0;
    for (const w of wip) {
      if (yield* loopAlive(w.number)) {
        dead.delete(w.number);
        continue;
      }
      const since = dead.get(w.number);
      if (since === undefined) {
        dead.set(w.number, now);
      } else if (now - since >= ORPHAN_GRACE_MS) {
        yield* markBlocked(
          wipLabel,
          blockedLabel,
          w.number,
          `🛑 githog: the loop for #${w.number} is no longer running (crashed or interrupted) and it sat in \`${wipLabel}\` past ${Math.round(ORPHAN_GRACE_MS / 60000)}m — reclaimed by the daemon to free a slot. Re-label \`${readyLabel}\` to retry it.`,
        );
        dead.delete(w.number);
        reclaimed += 1;
      }
    }
    for (const n of [...dead.keys()]) if (!wipNums.has(n)) dead.delete(n);
    yield* Ref.set(firstDead, dead);

    let slots = Math.max(0, maxConcurrent - (wip.length - reclaimed));
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
