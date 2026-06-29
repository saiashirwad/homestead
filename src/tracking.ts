import { Cause, Console, Effect, FileSystem, Option, Path, Schema } from "effect";
import * as os from "node:os";
import { runExit } from "./process.ts";
import { slugify } from "./text.ts";
import { resolveCallable } from "./callable.ts";
import { makeContext, type HomesteadContext } from "./context.ts";
import type { HomesteadServices, IssuesConfig, TrackingContext, WorkItem } from "./types.ts";

// Who/what spawned a worktree. Present only on `kind: "spawn"` state — the
// machine-spawned, issue-free flow (e.g. `agent spawn`). `spawnedBy` is free
// text: "agent spawn", a parent paneId, a username.
export const SpawnProvenanceSchema = Schema.Struct({
  spawnedBy: Schema.String,
  paneId: Schema.optional(Schema.String),
  promptSlug: Schema.optional(Schema.String),
  spawnedAt: Schema.String,
});
export type SpawnProvenance = typeof SpawnProvenanceSchema.Type;

// `kind` defaults to "issue" so OLD state files (which carry no `kind`) keep
// decoding as issue-work — a zero-touch migration. `number`/`url` are optional
// because spawn-work has no GitHub issue; they are always present for issue-work.
export const TrackingStateSchema = Schema.Struct({
  kind: Schema.Literals(["issue", "spawn"]).pipe(Schema.withDecodingDefaultKey(Effect.succeed("issue" as const))),
  number: Schema.optional(Schema.Number),
  url: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  worktreeDir: Schema.optional(Schema.String),
  label: Schema.optional(Schema.String),
  assignees: Schema.optional(Schema.Array(Schema.String)),
  assigned: Schema.optional(Schema.Boolean),
  commented: Schema.optional(Schema.Boolean),
  spawn: Schema.optional(SpawnProvenanceSchema),
});
export type TrackingState = typeof TrackingStateSchema.Type;

// The worktree-local `.homestead-agent.json` marker — a self-describing "this
// worktree is auto-work" flag written inside the worktree dir alongside `.env`.
// A landing tool with `cwd` inside the worktree can read it directly without
// resolving repo-slug + branch-slug back to ~/.homestead/state/…
export const AgentMarkerSchema = Schema.Struct({
  kind: Schema.Literal("spawn"),
  spawnedBy: Schema.String,
  paneId: Schema.optional(Schema.String),
  promptSlug: Schema.optional(Schema.String),
  statusFile: Schema.optional(Schema.String),
  createdAt: Schema.String,
});
export type AgentMarker = typeof AgentMarkerSchema.Type;

export const AGENT_MARKER_FILE = ".homestead-agent.json";

export const resolveCloseReason = (
  cfg: "completed" | "not planned" | ((ctx: HomesteadContext) => "completed" | "not planned") | undefined,
  ctx: HomesteadContext,
): "completed" | "not planned" => resolveCallable(cfg, ctx, "completed");

export const resolveLabelColor = (
  cfg: string | ((ctx: { label: string; kind: "wip" | "review" }) => string) | undefined,
  ctx: { label: string; kind: "wip" | "review" },
): string => resolveCallable(cfg, ctx, "1D76DB");

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

// Only meaningful for `kind: "issue"`, where `number`/`url` are always present.
// The `?? 0` / `?? ""` defaults guard the optional types for the (never-hit)
// spawn case rather than asserting non-null.
export const itemFromState = (state: TrackingState): WorkItem => ({
  number: state.number ?? 0,
  url: state.url ?? "",
  title: state.title ?? "",
});

const agentMarkerPath = (path: Path.Path, worktreeDir: string) =>
  path.join(worktreeDir, AGENT_MARKER_FILE);

// Write the worktree-local spawn marker. Called by the spawn flow at provision
// time alongside writing the global spawn tracking state.
export const writeAgentMarker = Effect.fn("homestead/write-agent-marker")(function* (
  worktreeDir: string,
  marker: AgentMarker,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const encoded = yield* Schema.encodeUnknownEffect(AgentMarkerSchema)(marker).pipe(Effect.orDie);
  yield* fs.writeFileString(agentMarkerPath(path, worktreeDir), `${JSON.stringify(encoded, null, 2)}\n`);
});

// Read the worktree-local spawn marker; `Option.none` when absent or unreadable.
export const readAgentMarker = Effect.fn("homestead/read-agent-marker")(function* (worktreeDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = agentMarkerPath(path, worktreeDir);

  const exists = yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false));
  if (!exists) return Option.none<AgentMarker>();

  const content = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
  if (content === "") return Option.none<AgentMarker>();

  const marker = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(AgentMarkerSchema))(content).pipe(
    Effect.orElseSucceed(() => undefined),
  );
  return marker === undefined ? Option.none<AgentMarker>() : Option.some(marker);
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

// A homestead-managed branch on disk: the branch-slug recovered from the state
// file name plus its decoded tracking state. `branch` is the slug (state files
// are named `${slugify(branch)}.json`), which is exactly what `ls` joins on.
export interface TrackedBranch {
  readonly branch: string;
  readonly state: TrackingState;
}

// Enumerate every tracking-state file for a repo. Read-only: lists the state
// dir, decodes each `<slug>.json`, and skips anything missing/unparseable. A
// missing state dir (no homestead worktrees yet) yields `[]`, never an error.
export const listTrackedBranches = Effect.fn("homestead/list-tracked-branches")(function* (
  repoName: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = stateDir(path, repoName);

  const exists = yield* fs.exists(dir).pipe(Effect.orElseSucceed(() => false));
  if (!exists) return [] as ReadonlyArray<TrackedBranch>;

  const entries = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
  const tracked: Array<TrackedBranch> = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const branch = entry.slice(0, -".json".length);
    const state = yield* loadTrackingState(repoName, branch);
    if (Option.isSome(state)) tracked.push({ branch, state: state.value });
  }
  return tracked as ReadonlyArray<TrackedBranch>;
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
    kind: "issue",
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

  // Spawn-work has no GitHub issue: skip every `gh issue …` call but still
  // remove the state file so the worktree stops being tracked.
  if (state.value.kind === "spawn") {
    yield* fs.remove(file).pipe(Effect.orElseSucceed(() => undefined));
    return;
  }

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

  // Spawn-work has no GitHub issue: skip every `gh issue …` call but still
  // remove the state file (review handoff is meaningless for auto-work).
  if (state.value.kind === "spawn") {
    yield* fs.remove(file).pipe(Effect.orElseSucceed(() => undefined));
    return;
  }

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

  // Spawn-work has no GitHub issue to close: remove the state file and stop.
  if (Option.isSome(state) && state.value.kind === "spawn") {
    yield* fs.remove(file).pipe(Effect.orElseSucceed(() => undefined));
    return;
  }

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
