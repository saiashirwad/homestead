import { Context, Effect, Layer, Ref } from "effect";
import { Git } from "./service.ts";
import type { MergeResult } from "./service.ts";

export interface GitTestApi {
  readonly setCommonDir: (cwd: string, dir: string) => Effect.Effect<void>;
  readonly setSymbolicRef: (cwd: string, name: string, ref: string | undefined) => Effect.Effect<void>;
  readonly setRefExists: (cwd: string, ref: string, exists: boolean) => Effect.Effect<void>;
  readonly setMergeResult: (cwd: string, branch: string, result: MergeResult) => Effect.Effect<void>;
  readonly setAncestor: (cwd: string, ref: string, base: string, value: boolean) => Effect.Effect<void>;
  readonly setCurrentBranch: (cwd: string, branch: string) => Effect.Effect<void>;
  readonly setStatus: (cwd: string, porcelain: string) => Effect.Effect<void>;
  readonly journal: () => Effect.Effect<{
    merges: Array<{ cwd: string; branch: string }>;
    aborts: Array<string>;
    commits: Array<string>;
    adds: Array<string>;
    stashPushes: Array<string>;
    stashPops: Array<string>;
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
  const journal = yield* Ref.make({
    merges: [] as Array<{ cwd: string; branch: string }>,
    aborts: [] as Array<string>,
    commits: [] as Array<string>,
    adds: [] as Array<string>,
    stashPushes: [] as Array<string>,
    stashPops: [] as Array<string>,
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
  };

  return { git, handle };
});

export const GitTest = Layer.effectContext(
  buildGitTest.pipe(
    Effect.map(({ git, handle }) => Context.make(Git, git).pipe(Context.add(GitTestHandle, handle))),
  ),
);
