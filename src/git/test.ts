import { Context, Effect, Layer, Ref } from "effect";
import { Git } from "./service.ts";
import type { MergeResult, WorktreePorcelainEntry } from "./service.ts";

export interface GitTestApi {
  readonly setCommonDir: (cwd: string, dir: string) => Effect.Effect<void>;
  readonly setSymbolicRef: (cwd: string, name: string, ref: string | undefined) => Effect.Effect<void>;
  readonly setRefExists: (cwd: string, ref: string, exists: boolean) => Effect.Effect<void>;
  readonly setMergeResult: (cwd: string, branch: string, result: MergeResult) => Effect.Effect<void>;
  readonly setAncestor: (cwd: string, ref: string, base: string, value: boolean) => Effect.Effect<void>;
  readonly setCurrentBranch: (cwd: string, branch: string) => Effect.Effect<void>;
  readonly setStatus: (cwd: string, porcelain: string) => Effect.Effect<void>;
  readonly setWorktrees: (cwd: string, entries: ReadonlyArray<WorktreePorcelainEntry>) => Effect.Effect<void>;
  readonly setLocalBranches: (cwd: string, names: ReadonlyArray<string>) => Effect.Effect<void>;
  readonly setStatusV2: (cwd: string, raw: string) => Effect.Effect<void>;
  readonly setShortHead: (cwd: string, sha: string) => Effect.Effect<void>;
  readonly setTopLevel: (cwd: string, path: string) => Effect.Effect<void>;
  readonly journal: () => Effect.Effect<{
    merges: Array<{ cwd: string; branch: string }>;
    aborts: Array<string>;
    commits: Array<string>;
    adds: Array<string>;
    stashPushes: Array<string>;
    stashPops: Array<string>;
    worktreeAdds: Array<{ cwd: string; dir: string; branch: string }>;
    worktreeRemoves: Array<{ cwd: string; path: string }>;
    prunes: Array<string>;
    branchCreates: Array<{ cwd: string; name: string; startPoint: string }>;
    branchDeletes: Array<{ cwd: string; name: string }>;
    remoteDeletes: Array<{ cwd: string; remote: string; name: string }>;
    fetches: Array<{ cwd: string; remote: string; refspec: string }>;
  }>;
}

export class GitTestHandle extends Context.Service<GitTestHandle, GitTestApi>()("GitTestHandle") {}

// Map key: cwd-scoped — `cwd + space + ref/name`.
const key = (cwd: string, x: string) => `${cwd} ${x}`;

const buildGitTest = Effect.gen(function* () {
  const commonDirs = yield* Ref.make(new Map<string, string>());
  const symbolicRefs = yield* Ref.make(new Map<string, string>());
  const refExistsMap = yield* Ref.make(new Map<string, boolean>());
  const mergeResults = yield* Ref.make(new Map<string, MergeResult>());
  const ancestors = yield* Ref.make(new Map<string, boolean>());
  const currentBranches = yield* Ref.make(new Map<string, string>());
  const statuses = yield* Ref.make(new Map<string, string>());
  const worktreesByCwd = yield* Ref.make(new Map<string, ReadonlyArray<WorktreePorcelainEntry>>());
  const localBranches = yield* Ref.make(new Map<string, string[]>());
  const statusV2Map = yield* Ref.make(new Map<string, string>());
  const shortHeads = yield* Ref.make(new Map<string, string>());
  const topLevels = yield* Ref.make(new Map<string, string>());
  const journal = yield* Ref.make({
    merges: [] as Array<{ cwd: string; branch: string }>,
    aborts: [] as Array<string>,
    commits: [] as Array<string>,
    adds: [] as Array<string>,
    stashPushes: [] as Array<string>,
    stashPops: [] as Array<string>,
    worktreeAdds: [] as Array<{ cwd: string; dir: string; branch: string }>,
    worktreeRemoves: [] as Array<{ cwd: string; path: string }>,
    prunes: [] as Array<string>,
    branchCreates: [] as Array<{ cwd: string; name: string; startPoint: string }>,
    branchDeletes: [] as Array<{ cwd: string; name: string }>,
    remoteDeletes: [] as Array<{ cwd: string; remote: string; name: string }>,
    fetches: [] as Array<{ cwd: string; remote: string; refspec: string }>,
  });

  const handle: GitTestApi = {
    setCommonDir: (cwd, dir) => Ref.update(commonDirs, (m) => new Map(m).set(cwd, dir)),
    setSymbolicRef: (cwd, name, ref) =>
      Ref.update(symbolicRefs, (m) => {
        const next = new Map(m);
        if (ref === undefined) next.delete(key(cwd, name));
        else next.set(key(cwd, name), ref);
        return next;
      }),
    setRefExists: (cwd, ref, exists) =>
      Ref.update(refExistsMap, (m) => new Map(m).set(key(cwd, ref), exists)),
    setMergeResult: (cwd, branch, result) =>
      Ref.update(mergeResults, (m) => new Map(m).set(key(cwd, branch), result)),
    setAncestor: (cwd, ref, base, value) =>
      Ref.update(ancestors, (m) => new Map(m).set(`${cwd} ${ref} ${base}`, value)),
    setCurrentBranch: (cwd, branch) =>
      Ref.update(currentBranches, (m) => new Map(m).set(cwd, branch)),
    setStatus: (cwd, porcelain) =>
      Ref.update(statuses, (m) => new Map(m).set(cwd, porcelain)),
    setWorktrees: (cwd, entries) =>
      Ref.update(worktreesByCwd, (m) => new Map(m).set(cwd, entries)),
    setLocalBranches: (cwd, names) =>
      Ref.update(localBranches, (m) => new Map(m).set(cwd, [...names])),
    setStatusV2: (cwd, raw) =>
      Ref.update(statusV2Map, (m) => new Map(m).set(cwd, raw)),
    setShortHead: (cwd, sha) =>
      Ref.update(shortHeads, (m) => new Map(m).set(cwd, sha)),
    setTopLevel: (cwd, path) =>
      Ref.update(topLevels, (m) => new Map(m).set(cwd, path)),
    journal: () => Ref.get(journal),
  };

  const git: typeof Git.Service = {
    commonDir: (cwd) => Ref.get(commonDirs).pipe(Effect.map((m) => m.get(cwd) ?? `${cwd}/.git`)),
    refExists: (cwd, ref) => Ref.get(refExistsMap).pipe(Effect.map((m) => m.get(key(cwd, ref)) ?? false)),
    symbolicRef: (cwd, name) => Ref.get(symbolicRefs).pipe(Effect.map((m) => m.get(key(cwd, name)))),
    merge: (cwd, branch) =>
      Effect.gen(function* () {
        yield* Ref.update(journal, (j) => ({ ...j, merges: [...j.merges, { cwd, branch }] }));
        const staged = (yield* Ref.get(mergeResults)).get(key(cwd, branch));
        return staged ?? ({ _tag: "Merged" } as const);
      }),
    abortMerge: (cwd) => Ref.update(journal, (j) => ({ ...j, aborts: [...j.aborts, cwd] })),
    mergeBaseIsAncestor: (cwd, ref, base) =>
      Ref.get(ancestors).pipe(Effect.map((m) => m.get(`${cwd} ${ref} ${base}`) ?? false)),
    addAll: (cwd) => Ref.update(journal, (j) => ({ ...j, adds: [...j.adds, cwd] })),
    commitNoEdit: (cwd) => Ref.update(journal, (j) => ({ ...j, commits: [...j.commits, cwd] })),
    currentBranch: (cwd) => Ref.get(currentBranches).pipe(Effect.map((m) => m.get(cwd) ?? "main")),
    status: (cwd) => Ref.get(statuses).pipe(Effect.map((m) => m.get(cwd) ?? "")),
    stash: {
      push: (cwd, _message) =>
        Ref.update(journal, (j) => ({ ...j, stashPushes: [...j.stashPushes, cwd] })).pipe(Effect.as(true)),
      pop: (cwd) =>
        Ref.update(journal, (j) => ({ ...j, stashPops: [...j.stashPops, cwd] })).pipe(Effect.as(true)),
    },
    worktree: {
      list: (cwd) =>
        Ref.get(worktreesByCwd).pipe(Effect.map((m) => m.get(cwd) ?? [])),
      pathForBranch: (cwd, branch) =>
        Ref.get(worktreesByCwd).pipe(
          Effect.map((m) => (m.get(cwd) ?? []).find((e) => e.branch === branch)?.path),
        ),
      add: (cwd, opts) =>
        Ref.update(journal, (j) => ({
          ...j,
          worktreeAdds: [...j.worktreeAdds, { cwd, dir: opts.dir, branch: opts.branch }],
        })),
      addNew: (cwd, opts) =>
        Ref.update(journal, (j) => ({
          ...j,
          worktreeAdds: [...j.worktreeAdds, { cwd, dir: opts.dir, branch: opts.branch }],
        })),
      remove: (cwd, path) =>
        Ref.update(journal, (j) => ({
          ...j,
          worktreeRemoves: [...j.worktreeRemoves, { cwd, path }],
        })),
      prune: (cwd) =>
        Ref.update(journal, (j) => ({ ...j, prunes: [...j.prunes, cwd] })),
    },
    branch: {
      create: (cwd, name, startPoint) =>
        Ref.update(journal, (j) => ({
          ...j,
          branchCreates: [...j.branchCreates, { cwd, name, startPoint }],
        })),
      delete: (cwd, name) =>
        Ref.update(journal, (j) => ({
          ...j,
          branchDeletes: [...j.branchDeletes, { cwd, name }],
        })),
      deleteRemote: (cwd, remote, name) =>
        Ref.update(journal, (j) => ({
          ...j,
          remoteDeletes: [...j.remoteDeletes, { cwd, remote, name }],
        })),
      listLocal: (cwd) =>
        Ref.get(localBranches).pipe(Effect.map((m) => m.get(cwd) ?? [])),
    },
    fetch: (cwd, remote, refspec) =>
      Ref.update(journal, (j) => ({
        ...j,
        fetches: [...j.fetches, { cwd, remote, refspec }],
      })),
    statusV2: (cwd) =>
      Ref.get(statusV2Map).pipe(Effect.map((m) => m.get(cwd) ?? "")),
    shortHead: (cwd) =>
      Ref.get(shortHeads).pipe(Effect.map((m) => m.get(cwd) ?? "")),
    topLevel: (cwd) =>
      Ref.get(topLevels).pipe(Effect.map((m) => m.get(cwd) ?? "")),
  };

  return { git, handle };
});

export const GitTest = Layer.effectContext(
  buildGitTest.pipe(
    Effect.map(({ git, handle }) => Context.make(Git, git).pipe(Context.add(GitTestHandle, handle))),
  ),
);
