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
