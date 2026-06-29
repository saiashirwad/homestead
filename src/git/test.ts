import { Context, Effect, Layer, Ref } from "effect";
import { Git } from "./service.ts";

export interface GitTestApi {
  readonly setCommonDir: (cwd: string, dir: string) => Effect.Effect<void>;
  readonly setSymbolicRef: (cwd: string, name: string, ref: string | undefined) => Effect.Effect<void>;
  readonly setRefExists: (cwd: string, ref: string, exists: boolean) => Effect.Effect<void>;
}

export class GitTestHandle extends Context.Service<GitTestHandle, GitTestApi>()("GitTestHandle") {}

// Map key: cwd-scoped — `cwd + space + ref/name`.
const key = (cwd: string, x: string) => `${cwd} ${x}`;

const buildGitTest = Effect.gen(function* () {
  const commonDirs = yield* Ref.make(new Map<string, string>());
  const symbolicRefs = yield* Ref.make(new Map<string, string>());
  const refExistsMap = yield* Ref.make(new Map<string, boolean>());

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
  };

  const git: typeof Git.Service = {
    commonDir: (cwd) => Ref.get(commonDirs).pipe(Effect.map((m) => m.get(cwd) ?? `${cwd}/.git`)),
    refExists: (cwd, ref) => Ref.get(refExistsMap).pipe(Effect.map((m) => m.get(key(cwd, ref)) ?? false)),
    symbolicRef: (cwd, name) => Ref.get(symbolicRefs).pipe(Effect.map((m) => m.get(key(cwd, name)))),
  };

  return { git, handle };
});

export const GitTest = Layer.effectContext(
  buildGitTest.pipe(
    Effect.map(({ git, handle }) => Context.make(Git, git).pipe(Context.add(GitTestHandle, handle))),
  ),
);
