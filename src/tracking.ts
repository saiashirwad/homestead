import { Cause, Console, Effect, FileSystem, Option, Path, Schema } from "effect";
import * as os from "node:os";
import { runExit } from "./process.ts";
import { slugify } from "./text.ts";
import type { HomesteadServices, IssuesConfig, TrackingContext, WorkItem } from "./types.ts";

export const TrackingStateSchema = Schema.Struct({
  number: Schema.Number,
  url: Schema.String,
  label: Schema.optional(Schema.String),
  assigned: Schema.optional(Schema.Boolean),
  commented: Schema.optional(Schema.Boolean),
});
type TrackingState = typeof TrackingStateSchema.Type;

const LABEL_COLOR = "1D76DB";

const stateDir = (path: Path.Path, repoName: string) =>
  path.join(os.homedir(), ".homestead", "state", slugify(repoName));
const statePath = (path: Path.Path, repoName: string, branch: string) =>
  path.join(stateDir(path, repoName), `${slugify(branch)}.json`);

const gh = Effect.fn("homestead/gh")(function* (label: string, args: ReadonlyArray<string>) {
  const code = yield* runExit("gh", args).pipe(Effect.orElseSucceed(() => 1));
  if (code !== 0) {
    yield* Console.log(`  ⚠ ${label} failed (exit ${code}, gh ${args.join(" ")}) — continuing`);
  }
});

export const loadTrackingState = Effect.fn("homestead/load-tracking-state")(function* (
  repoName: string,
  branch: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = statePath(path, repoName, branch);

  const exists = yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false));
  if (!exists) return Option.none<TrackingState>();

  const content = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
  if (content === "") return Option.none<TrackingState>();

  const state = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(TrackingStateSchema))(content).pipe(
    Effect.orElseSucceed(() => undefined),
  );
  return state === undefined ? Option.none<TrackingState>() : Option.some(state);
});

export const markStarted = Effect.fn("homestead/mark-started")(function* (
  repoName: string,
  item: WorkItem,
  branch: string,
  worktreeDir: string,
  issues: IssuesConfig | undefined,
) {
  if (issues === undefined) return;

  const label = issues.label?.trim();
  const wantLabel = label !== undefined && label !== "";
  const wantAssign = issues.assign === true;
  const wantComment = issues.comment !== undefined && issues.comment !== false;
  if (!wantLabel && !wantAssign && !wantComment) return;

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const host = os.hostname();
  const ref = String(item.number);

  if (wantLabel) {
    yield* gh("gh label create", ["label", "create", label, "--color", LABEL_COLOR, "--force"]);
    yield* gh("gh issue edit --add-label", ["issue", "edit", ref, "--add-label", label]);
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
        : `homestead: agent started on \`${branch}\` (${host}) — worktree \`${worktreeDir}\``;
    yield* gh("gh issue comment", ["issue", "comment", ref, "--body", body]);
    commented = true;
  }

  const state: TrackingState = {
    number: item.number,
    url: item.url,
    ...(wantLabel ? { label } : {}),
    ...(wantAssign ? { assigned: true } : {}),
    ...(commented ? { commented: true } : {}),
  };
  const encoded = yield* Schema.encodeUnknownEffect(TrackingStateSchema)(state).pipe(Effect.orDie);
  yield* fs
    .makeDirectory(stateDir(path, repoName), { recursive: true })
    .pipe(
      Effect.andThen(fs.writeFileString(statePath(path, repoName, branch), JSON.stringify(encoded))),
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterrupts(cause),
        () =>
          Console.log(`  ⚠ could not record homestead state for '${branch}' (kill won't auto-reverse)`),
      ),
      Effect.asVoid,
    );
});

export const markStopped = Effect.fn("homestead/mark-stopped")(function* (repoName: string, branch: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = statePath(path, repoName, branch);

  const state = yield* loadTrackingState(repoName, branch);
  if (Option.isNone(state)) return;

  const ref = String(state.value.number);
  const host = os.hostname();
  if (state.value.label !== undefined) {
    yield* gh("gh issue edit --remove-label", ["issue", "edit", ref, "--remove-label", state.value.label]);
  }
  if (state.value.assigned === true) {
    yield* gh("gh issue edit --remove-assignee", ["issue", "edit", ref, "--remove-assignee", "@me"]);
  }
  if (state.value.commented === true) {
    yield* gh("gh issue comment", ["issue", "comment", ref, "--body", `homestead: agent stopped on \`${branch}\` (${host})`]);
  }
  yield* fs.remove(file).pipe(Effect.orElseSucceed(() => undefined));
});

export const markFinished = Effect.fn("homestead/mark-finished")(function* (
  repoName: string,
  branch: string,
  reviewLabel: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = statePath(path, repoName, branch);

  const state = yield* loadTrackingState(repoName, branch);
  if (Option.isNone(state)) return;

  const ref = String(state.value.number);
  if (state.value.label !== undefined) {
    yield* gh("gh label create", ["label", "create", reviewLabel, "--color", LABEL_COLOR, "--force"]);
    yield* gh("gh issue edit --add-label", ["issue", "edit", ref, "--add-label", reviewLabel]);
    yield* gh("gh issue edit --remove-label", ["issue", "edit", ref, "--remove-label", state.value.label]);
  }
  yield* fs.remove(file).pipe(Effect.orElseSucceed(() => undefined));
});
