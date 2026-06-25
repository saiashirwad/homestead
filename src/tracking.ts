import { Cause, Console, Effect, FileSystem, Option, Path, Schema } from "effect";
import * as os from "node:os";
import { runExit } from "./process.ts";
import { slugify } from "./text.ts";
import { makeContext, type HomesteadContext } from "./context.ts";
import type { HomesteadServices, IssuesConfig, TrackingContext, WorkItem } from "./types.ts";

export const TrackingStateSchema = Schema.Struct({
  number: Schema.Number,
  url: Schema.String,
  title: Schema.optional(Schema.String),
  worktreeDir: Schema.optional(Schema.String),
  label: Schema.optional(Schema.String),
  assignees: Schema.optional(Schema.Array(Schema.String)),
  assigned: Schema.optional(Schema.Boolean),
  commented: Schema.optional(Schema.Boolean),
});
export type TrackingState = typeof TrackingStateSchema.Type;

export const resolveCloseReason = (
  cfg: "completed" | "not planned" | ((ctx: HomesteadContext) => "completed" | "not planned") | undefined,
  ctx: HomesteadContext,
): "completed" | "not planned" => (typeof cfg === "function" ? cfg(ctx) : (cfg ?? "completed"));

export const resolveLabelColor = (
  cfg: string | ((ctx: { label: string; kind: "wip" | "review" }) => string) | undefined,
  ctx: { label: string; kind: "wip" | "review" },
): string => (typeof cfg === "function" ? cfg(ctx) : (cfg ?? "1D76DB"));

export const resolveLabel = (
  cfg: string | ((item: WorkItem) => string) | undefined,
  item: WorkItem,
): string | undefined => {
  const v = typeof cfg === "function" ? cfg(item) : cfg;
  const t = v?.trim();
  return t === undefined || t === "" ? undefined : t;
};

export const resolveReviewLabel = (
  fallback: string,
  issues: IssuesConfig | undefined,
  state: Option.Option<TrackingState>,
): string => {
  if (Option.isNone(state)) return fallback;
  const item = itemFromState(state.value);
  return resolveLabel(issues?.reviewLabel, item) ?? fallback;
};

export const resolveAssignees = (
  cfg: boolean | string | ((item: WorkItem) => string | ReadonlyArray<string>) | undefined,
  item: WorkItem,
): ReadonlyArray<string> => {
  if (cfg === undefined || cfg === false) return [];
  if (cfg === true) return ["@me"];
  const v = typeof cfg === "function" ? cfg(item) : cfg;
  return typeof v === "string" ? [v] : [...v];
};

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

export const itemFromState = (state: TrackingState): WorkItem => ({
  number: state.number,
  url: state.url,
  title: state.title ?? "",
});

export const stopCtxFromState = (
  repoName: string,
  branch: string,
  state: Option.Option<TrackingState>,
  host = os.hostname(),
): TrackingContext => ({
  ...makeContext({
    repoName,
    slug: branch,
    branch,
    worktreeDir: Option.isSome(state) ? (state.value.worktreeDir ?? "") : "",
    ...(Option.isSome(state) && state.value.title !== undefined
      ? { item: itemFromState(state.value) }
      : {}),
  }),
  host,
});

type CommentMode =
  | { readonly whenUnset: "default"; readonly defaultBody: string }
  | { readonly whenUnset: "off"; readonly whenTrue: string };

export const resolveOptionalComment = (
  cfg: boolean | ((ctx: TrackingContext) => string) | undefined,
  ctx: TrackingContext,
  mode: CommentMode,
): string | undefined => {
  if (cfg === false) return undefined;
  if (typeof cfg === "function") return cfg(ctx);
  if (cfg === true) return mode.whenUnset === "off" ? mode.whenTrue : mode.defaultBody;
  return mode.whenUnset === "off" ? undefined : mode.defaultBody;
};

export const resolveStopComment = (
  cfg: boolean | ((ctx: TrackingContext) => string) | undefined,
  ctx: TrackingContext,
): string | undefined =>
  resolveOptionalComment(cfg, ctx, {
    whenUnset: "default",
    defaultBody: `homestead: agent stopped on \`${ctx.branch}\` (${ctx.host})`,
  });

export const resolveReviewComment = (
  cfg: boolean | ((ctx: TrackingContext) => string) | undefined,
  ctx: TrackingContext,
): string | undefined =>
  resolveOptionalComment(cfg, ctx, {
    whenUnset: "off",
    whenTrue: `homestead: \`${ctx.branch}\` moved to review (${ctx.host})`,
  });

export const resolveCloseComment = (
  cfg: boolean | ((ctx: TrackingContext) => string) | undefined,
  ctx: TrackingContext,
): string | undefined =>
  resolveOptionalComment(cfg, ctx, {
    whenUnset: "off",
    whenTrue: `homestead: \`${ctx.branch}\` completed (${ctx.host})`,
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

  const label = resolveLabel(issues.label, item);
  const assignees = resolveAssignees(issues.assign, item);
  const wantLabel = label !== undefined;
  const wantAssign = assignees.length > 0;
  const wantComment = issues.comment !== undefined && issues.comment !== false;
  if (!wantLabel && !wantAssign && !wantComment) return;

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const host = os.hostname();
  const ref = String(item.number);

  if (wantLabel) {
    yield* gh("gh label create", [
      "label",
      "create",
      label,
      "--color",
      resolveLabelColor(issues.labelColor, { label, kind: "wip" }),
      "--force",
    ]);
    yield* gh("gh issue edit --add-label", ["issue", "edit", ref, "--add-label", label]);
  }
  if (wantAssign) {
    for (const login of assignees) {
      yield* gh("gh issue edit --add-assignee", ["issue", "edit", ref, "--add-assignee", login]);
    }
  }
  let commented = false;
  if (wantComment) {
    const ctx: TrackingContext = {
      ...makeContext({ repoName, slug: branch, branch, worktreeDir, item }),
      host,
    };
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
    title: item.title,
    worktreeDir,
    ...(wantLabel ? { label } : {}),
    ...(wantAssign ? { assignees: [...assignees] } : {}),
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

export const markStopped = Effect.fn("homestead/mark-stopped")(function* (
  repoName: string,
  branch: string,
  issues?: IssuesConfig,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = statePath(path, repoName, branch);

  const state = yield* loadTrackingState(repoName, branch);
  if (Option.isNone(state)) return;

  const ref = String(state.value.number);
  if (state.value.label !== undefined) {
    yield* gh("gh issue edit --remove-label", ["issue", "edit", ref, "--remove-label", state.value.label]);
  }
  if (state.value.assignees !== undefined) {
    for (const login of state.value.assignees) {
      yield* gh("gh issue edit --remove-assignee", ["issue", "edit", ref, "--remove-assignee", login]);
    }
  } else if (state.value.assigned === true) {
    yield* gh("gh issue edit --remove-assignee", ["issue", "edit", ref, "--remove-assignee", "@me"]);
  }
  if (state.value.commented === true) {
    const body = resolveStopComment(issues?.stopComment, stopCtxFromState(repoName, branch, state));
    if (body !== undefined) {
      yield* gh("gh issue comment", ["issue", "comment", ref, "--body", body]);
    }
  }
  yield* fs.remove(file).pipe(Effect.orElseSucceed(() => undefined));
});

export const markFinished = Effect.fn("homestead/mark-finished")(function* (
  repoName: string,
  branch: string,
  reviewLabel: string,
  issues?: IssuesConfig,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = statePath(path, repoName, branch);

  const state = yield* loadTrackingState(repoName, branch);
  if (Option.isNone(state)) return;

  const ref = String(state.value.number);
  if (state.value.label !== undefined) {
    yield* gh("gh label create", [
      "label",
      "create",
      reviewLabel,
      "--color",
      resolveLabelColor(issues?.labelColor, { label: reviewLabel, kind: "review" }),
      "--force",
    ]);
    yield* gh("gh issue edit --add-label", ["issue", "edit", ref, "--add-label", reviewLabel]);
    yield* gh("gh issue edit --remove-label", ["issue", "edit", ref, "--remove-label", state.value.label]);
  }
  const reviewBody = resolveReviewComment(
    issues?.reviewComment,
    stopCtxFromState(repoName, branch, state),
  );
  if (reviewBody !== undefined) {
    yield* gh("gh issue comment", ["issue", "comment", ref, "--body", reviewBody]);
  }
  yield* fs.remove(file).pipe(Effect.orElseSucceed(() => undefined));
});

// `homestead complete` — the work is done: close the GitHub issue as completed.
// The issue number comes from recorded tracking state, or from the branch itself
// when it's a bare issue number (the default branch for the `issue` flow).
export const markCompleted = Effect.fn("homestead/mark-completed")(function* (
  repoName: string,
  branch: string,
  issues?: IssuesConfig,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = statePath(path, repoName, branch);

  const state = yield* loadTrackingState(repoName, branch);
  const ref = Option.isSome(state)
    ? String(state.value.number)
    : /^\d+$/.test(branch)
      ? branch
      : undefined;

  if (ref === undefined) {
    yield* Console.log(`  (no issue associated with '${branch}' — skipping issue close)`);
    return;
  }

  const ctx = stopCtxFromState(repoName, branch, state);
  const closeBody = resolveCloseComment(issues?.closeComment, ctx);
  if (closeBody !== undefined) {
    yield* gh("gh issue comment", ["issue", "comment", ref, "--body", closeBody]);
  }

  yield* gh("gh issue close", ["issue", "close", ref, "--reason", resolveCloseReason(issues?.closeReason, ctx)]);

  if (Option.isSome(state)) {
    yield* fs.remove(file).pipe(Effect.orElseSucceed(() => undefined));
  }
});
