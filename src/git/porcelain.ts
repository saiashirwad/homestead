export interface WorktreePorcelainEntry {
  readonly path: string;
  readonly branch: string | undefined;
}

export const parseWorktreePorcelain = (worktreeList: string): ReadonlyArray<WorktreePorcelainEntry> => {
  const entries: Array<WorktreePorcelainEntry> = [];
  let currentPath: string | undefined;
  let currentBranch: string | undefined;

  for (const line of worktreeList.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (currentPath !== undefined) {
        entries.push({ path: currentPath, branch: currentBranch });
      }
      currentPath = line.slice("worktree ".length).trim();
      currentBranch = undefined;
    } else if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length).trim();
      currentBranch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    }
  }

  if (currentPath !== undefined) {
    entries.push({ path: currentPath, branch: currentBranch });
  }

  return entries;
};

export const worktreePathForBranch = (worktreeList: string, branch: string): string | undefined =>
  parseWorktreePorcelain(worktreeList).find((entry) => entry.branch === branch)?.path;
