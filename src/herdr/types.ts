import { Schema } from "effect";

export interface HerdrRuntimeEnv {
  readonly workspaceId: string | undefined;
  readonly cwd: string;
}

export type SurfaceKind = "worktree" | "tab" | "workspace";

export type ReadSource = "visible" | "recent" | "recent-unwrapped";

export interface PollOptions {
  readonly timeoutMs?: number;
  readonly pollMs?: number;
  readonly regex?: boolean;
  readonly source?: ReadSource;
}

const WorktreeEntrySchema = Schema.Struct({
  branch: Schema.optional(Schema.NullOr(Schema.String)),
  open_workspace_id: Schema.optional(Schema.NullOr(Schema.String)),
});

export const WorktreeListSchema = Schema.Struct({
  result: Schema.Struct({
    worktrees: Schema.Array(WorktreeEntrySchema),
  }),
});

export type WorktreeEntry = Schema.Schema.Type<typeof WorktreeEntrySchema>;

export const openWorkspaceIdForBranch = (
  worktrees: ReadonlyArray<WorktreeEntry>,
  branch: string,
): string | undefined =>
  worktrees.find((wt) => wt.branch === branch)?.open_workspace_id ?? undefined;

const WorkspaceEntrySchema = Schema.Struct({
  workspace_id: Schema.String,
  label: Schema.optional(Schema.NullOr(Schema.String)),
});

// `herdr workspace list` emits JSON on plain invocation (it rejects `--json`).
export const WorkspaceListSchema = Schema.Struct({
  result: Schema.Struct({
    workspaces: Schema.Array(WorkspaceEntrySchema),
  }),
});

export type WorkspaceEntry = Schema.Schema.Type<typeof WorkspaceEntrySchema>;

// `herdr workspace create --label <l> --no-focus` (no `--json` flag) returns the
// created workspace under `result.workspace`.
export const WorkspaceCreatedSchema = Schema.Struct({
  result: Schema.Struct({
    workspace: Schema.Struct({ workspace_id: Schema.String }),
  }),
});

export const workspaceIdForLabel = (
  workspaces: ReadonlyArray<WorkspaceEntry>,
  label: string,
): string | undefined =>
  workspaces.find((ws) => ws.label === label)?.workspace_id ?? undefined;

export const matcher = (marker: string, regex: boolean | undefined) => {
  if (regex) {
    const re = new RegExp(marker);
    return (text: string) => re.test(text);
  }
  return (text: string) => text.includes(marker);
};

export const SurfaceCreatedSchema = Schema.Struct({
  result: Schema.Struct({ root_pane: Schema.Struct({ pane_id: Schema.String }) }),
});

// `herdr pane get <id>` reports the pane's agent_status — herdr's own reliable
// working/idle/blocked/done detection. Far better than grepping pane text for a
// prompt marker, which Claude Code's TUI renders even while working.
export const PaneGetSchema = Schema.Struct({
  result: Schema.Struct({
    pane: Schema.Struct({
      agent_status: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  }),
});
