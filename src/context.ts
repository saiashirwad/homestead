import type { PrView } from "./pr/resolve.ts";
import type { WorkItem } from "./work-item.ts";

export interface HomesteadContext {
  readonly repoName: string;
  readonly slug: string;
  readonly branch: string;
  readonly worktreeDir: string;
  readonly item?: WorkItem;
  readonly pr?: PrView;
  readonly env: (key: string) => string | undefined;
}

export interface MakeContextInput {
  readonly repoName: string;
  readonly slug: string;
  readonly branch: string;
  readonly worktreeDir: string;
  readonly item?: WorkItem;
  readonly pr?: PrView;
  readonly env?: (key: string) => string | undefined;
}

export const makeContext = (input: MakeContextInput): HomesteadContext => ({
  repoName: input.repoName,
  slug: input.slug,
  branch: input.branch,
  worktreeDir: input.worktreeDir,
  ...(input.item !== undefined ? { item: input.item } : {}),
  ...(input.pr !== undefined ? { pr: input.pr } : {}),
  env: input.env ?? (() => undefined),
});
