import { Console, Effect, FileSystem, Path, Schema } from "effect";
import * as os from "node:os";
import { runExit } from "./process.ts";
import { slugify } from "./text.ts";
import type { IssuesConfig, TrackingContext, WorkItem } from "./types.ts";

// Reflect agent activity back onto the GitHub issue. All actions are opt-in (the
// config's `issues` block) and best-effort: a gh failure warns and continues, it
// never fails the run. What gets applied on start is recorded to a state file so
// `kill` can reverse exactly that — no config needed at teardown, no surprises.

// Persisted record of the mutations applied at launch, so kill can undo them.
const TrackingState = Schema.Struct({
  number: Schema.Number,
  url: Schema.String,
  label: Schema.optional(Schema.String),
  assigned: Schema.optional(Schema.Boolean),
  commented: Schema.optional(Schema.Boolean),
});
const decodeState = Schema.decodeUnknownEffect(Schema.fromJsonString(TrackingState));

const LABEL_COLOR = "1D76DB";

const stateDir = (path: Path.Path, repoName: string) =>
  path.join(os.homedir(), ".githog", "state", slugify(repoName));
const statePath = (path: Path.Path, repoName: string, branch: string) =>
  path.join(stateDir(path, repoName), `${slugify(branch)}.json`);

// Run a gh mutation, demoting any failure to a warning (these touch the remote
// tracker — worth a note, never worth aborting the run).
const gh = Effect.fn("githog/gh")(function* (label: string, args: ReadonlyArray<string>) {
  const code = yield* runExit("gh", args).pipe(Effect.catchCause(() => Effect.succeed(1)));
  if (code !== 0) yield* Console.log(`  ⚠ ${label} failed (continuing)`);
});

// --- listen: claim a `ready` issue by swapping it to the `wip` label ---------
// Done up front (before slow setup) so a second poll won't grab the same issue,
// and so a crash mid-setup leaves it visibly `wip` rather than orphaned.
export const claimReady = Effect.fn("githog/claim-ready")(function* (
  readyLabel: string,
  wipLabel: string,
  number: number,
) {
  const ref = String(number);
  yield* gh("gh label create", ["label", "create", wipLabel, "--color", LABEL_COLOR, "--force"]);
  yield* gh("gh issue edit --add-label", ["issue", "edit", ref, "--add-label", wipLabel]);
  yield* gh("gh issue edit --remove-label", ["issue", "edit", ref, "--remove-label", readyLabel]);
});

// --- loop terminal handoffs: swap the wip label to a terminal state ----------
// Both move the issue out of `agent:wip` (freeing a listen slot, which counts only
// wip) and into a terminal label. Best-effort, like every other tracker touch.
const swapLabel = Effect.fn("githog/swap-label")(function* (fromLabel: string, toLabel: string, number: number) {
  const ref = String(number);
  yield* gh("gh label create", ["label", "create", toLabel, "--color", LABEL_COLOR, "--force"]);
  yield* gh("gh issue edit --add-label", ["issue", "edit", ref, "--add-label", toLabel]);
  yield* gh("gh issue edit --remove-label", ["issue", "edit", ref, "--remove-label", fromLabel]);
});

// Loop completed: PR is open, move wip -> review for human review/merge.
export const markReview = Effect.fn("githog/mark-review")(function* (
  wipLabel: string,
  reviewLabel: string,
  number: number,
) {
  yield* swapLabel(wipLabel, reviewLabel, number);
});

// Loop stopped without completing: move wip -> blocked and post the reason / last
// output so a human can find and triage it.
export const markBlocked = Effect.fn("githog/mark-blocked")(function* (
  wipLabel: string,
  blockedLabel: string,
  number: number,
  reason: string,
) {
  yield* swapLabel(wipLabel, blockedLabel, number);
  yield* gh("gh issue comment", ["issue", "comment", String(number), "--body", reason]);
});

// --- start: apply the configured signals, then record what we did -----------

export const markStarted = Effect.fn("githog/mark-started")(function* (
  repoName: string,
  item: WorkItem,
  branch: string,
  worktreeDir: string,
  issues: IssuesConfig,
) {
  const wantLabel = issues.label !== undefined && issues.label.trim() !== "";
  const wantAssign = issues.assign === true;
  const wantComment = issues.comment !== undefined && issues.comment !== false;
  if (!wantLabel && !wantAssign && !wantComment) return;

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const host = os.hostname();
  const ref = String(item.number);

  if (wantLabel && issues.label !== undefined) {
    // Auto-create (idempotent: --force upserts) so --add-label can't miss.
    yield* gh("gh label create", ["label", "create", issues.label, "--color", LABEL_COLOR, "--force"]);
    yield* gh("gh issue edit --add-label", ["issue", "edit", ref, "--add-label", issues.label]);
  }
  if (wantAssign) {
    yield* gh("gh issue edit --add-assignee", ["issue", "edit", ref, "--add-assignee", "@me"]);
  }
  let commented = false;
  if (wantComment) {
    const ctx: TrackingContext = { number: item.number, url: item.url, title: item.title, branch, worktreeDir, host };
    const body =
      typeof issues.comment === "function"
        ? issues.comment(ctx)
        : `🤖 githog: agent started on \`${branch}\` (${host}) — worktree \`${worktreeDir}\``;
    yield* gh("gh issue comment", ["issue", "comment", ref, "--body", body]);
    commented = true;
  }

  // Record what was applied so kill can reverse precisely.
  const state = {
    number: item.number,
    url: item.url,
    ...(wantLabel && issues.label !== undefined ? { label: issues.label } : {}),
    ...(wantAssign ? { assigned: true } : {}),
    ...(commented ? { commented: true } : {}),
  };
  yield* Effect.gen(function* () {
    yield* fs.makeDirectory(stateDir(path, repoName), { recursive: true });
    yield* fs.writeFileString(statePath(path, repoName, branch), JSON.stringify(state));
  }).pipe(
    Effect.catchCause(() =>
      Console.log(`  ⚠ could not record githog state for '${branch}' (kill won't auto-reverse)`),
    ),
  );
});

// --- kill: reverse whatever the state file recorded, then delete it ----------

export const markStopped = Effect.fn("githog/mark-stopped")(function* (repoName: string, branch: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = statePath(path, repoName, branch);

  if (!(yield* fs.exists(file).pipe(Effect.catchCause(() => Effect.succeed(false))))) return;
  const content = yield* fs.readFileString(file).pipe(Effect.catchCause(() => Effect.succeed("")));
  if (content === "") return;
  const state = yield* decodeState(content).pipe(Effect.catchCause(() => Effect.succeed(undefined)));
  if (state === undefined) return;

  const ref = String(state.number);
  const host = os.hostname();
  if (state.label !== undefined) {
    yield* gh("gh issue edit --remove-label", ["issue", "edit", ref, "--remove-label", state.label]);
  }
  if (state.assigned === true) {
    yield* gh("gh issue edit --remove-assignee", ["issue", "edit", ref, "--remove-assignee", "@me"]);
  }
  if (state.commented === true) {
    yield* gh("gh issue comment", ["issue", "comment", ref, "--body", `🛑 githog: agent stopped on \`${branch}\` (${host})`]);
  }
  yield* fs.remove(file).pipe(Effect.catchCause(() => Effect.void));
});
