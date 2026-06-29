# Deep Git Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pull every `git` shell-out (33 call sites across 11 files) behind one deep `Git` module — a `Context.Service` with a small grouped interface and a swappable in-memory fake for tests.

**Architecture:** A `Git` Effect `Context.Service` (mirroring the existing `Herdr` service in `src/herdr/service.ts`) captures `ChildProcessSpawner` at make-time and exposes grouped, domain-named operations that hide argv, per-call `cwd`, and porcelain parsing. A second adapter — `GitTest` (mirroring `src/herdr/test.ts`) — provides an in-memory fake plus a `GitTestHandle` for staging responses, so callers like `land`/`teardown` can be tested without building real repos. `gh` (the GitHub CLI) is **out of scope** and stays where it is. Migration is incremental: prove the seam on two trivial read-only callers, then `land`, then sweep the rest.

**Tech Stack:** Bun (`bun test`, `bun run`), TypeScript, Effect v4 (`effect@4.0.0-beta.85`, `@effect/platform-bun`). Effect ecosystem is consolidated into core `effect` (Schema at `effect/Schema`, process primitives at `effect/unstable/process`).

## Global Constraints

- **Use Bun, never Node tooling:** `bun test`, `bun install`, `bun run`. Bun loads `.env` automatically.
- **Effect v4 only.** Do NOT install `@effect/schema` or `@effect/cli`. Process primitives import from `effect/unstable/process` (`ChildProcess`, `ChildProcessSpawner`).
- **Consult `effect-solutions` before writing Effect code** (`effect-solutions show services-and-layers testing`). The canonical in-repo references for this work are `src/herdr/service.ts` (service shape) and `src/herdr/test.ts` (fake layer + handle) — copy their patterns exactly.
- **Scope is `git` only.** Leave the 5 `gh` call sites (`issues.ts`, `waves-cmd.ts`, `pr/resolve.ts`, `tracking.ts`) untouched.
- **Error model — hybrid:** mutations whose failure is fatal die (`Effect.die`); predicates return `boolean` via exit code; expected outcomes are typed return values (`merge` → `Merged | Conflict`), never thrown; tolerant mutations (worktree remove/prune, remote-branch delete) ignore a non-zero exit.
- **`cwd` is per-call**, never bound into the service — homestead runs git against many worktrees.
- **No generic `git(args)` escape hatch** on the public interface. New needs get a new named method.
- **Verify gate after every task:** `bun run check` (runs `gen:config-types --check`, `tsc --noEmit`, `bun test`). Individual test runs use `bun test <path>`.
- **Commit message convention:** end every commit body with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

## File Structure

**New files:**
- `src/git/service.ts` — the `Git` `Context.Service` and the `GitLive` layer. Grows method-by-method across PRs.
- `src/git/test.ts` — the `GitTest` layer + `GitTestHandle` fake-control service. Grows in lockstep with `service.ts`.
- `src/git/service.test.ts` — real-git tests for the `Git` service itself (anti-drift: build a temp repo, assert behavior).

**Existing files modified:**
- `src/git/porcelain.ts` — unchanged source; becomes an internal implementation detail of `Git` (its pure parsers stay tested via `porcelain.test.ts`).
- `src/runtime.ts` — wire `GitLive` into `AppLayer`.
- `src/worktree/repo.ts` — `resolveRepo` uses `git.commonDir`.
- `src/worktree/base-ref.ts` — `refExists`/`resolveDefaultBaseRef` use `Git`.
- `src/land.ts` — merge/stash/status/branch git calls use `Git`; `merge()` returns `Merged | Conflict`.
- `src/worktree/plan.ts`, `src/teardown.ts`, `src/gc.ts`, `src/pr/branch.ts` — sweep all remaining git calls onto `Git`.
- Test layers gaining `Git`: `src/land.test.ts`, `src/teardown.test.ts`, `src/worktree/index.test.ts`, `src/gc.test.ts` (any test that drives real code through a migrated function).

---

# PR 1 — The seam, proven on two trivial callers

Deliverable: `Git` service + `GitTest` fake + `GitLive` wired into `AppLayer`, with `repo.ts` and `base-ref.ts` migrated and green.

### Task 1: `Git` service skeleton with `commonDir`

**Files:**
- Create: `src/git/service.ts`
- Test: `src/git/service.test.ts`

**Interfaces:**
- Produces: `class Git extends Context.Service<Git>()("Git", …)` whose service shape (`typeof Git.Service`) starts with `commonDir(cwd: string): Effect.Effect<string>`. Exports `GitLive: Layer<Git, never, ChildProcessSpawner>`.

- [ ] **Step 1: Write the failing test**

```ts
// src/git/service.test.ts
import { expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { Git, GitLive } from "./service.ts";

const TestLayer = Layer.provideMerge(GitLive, BunServices.layer);
const run = <A>(eff: Effect.Effect<A, unknown, Git>): Promise<A> =>
  Effect.runPromise(Effect.provide(eff, TestLayer) as Effect.Effect<A>);

const sh = (cwd: string, ...args: ReadonlyArray<string>) =>
  execFileSync("git", args as string[], { cwd, stdio: "pipe" }).toString();

const makeRepo = (): string => {
  const root = mkdtempSync(nodePath.join(os.tmpdir(), "homestead-git-"));
  sh(root, "init", "-b", "main");
  sh(root, "config", "user.email", "t@example.com");
  sh(root, "config", "user.name", "Test");
  sh(root, "config", "commit.gpgsign", "false");
  return root;
};

test("commonDir returns the repo's git dir", async () => {
  const root = makeRepo();
  try {
    const dir = await run(Effect.flatMap(Git, (git) => git.commonDir(root)));
    // git may print an absolute path or ".git"; both end in the git dir name.
    expect(dir.endsWith(".git") || dir === ".git").toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/git/service.test.ts`
Expected: FAIL — `Cannot find module './service.ts'` (or `Git` undefined).

- [ ] **Step 3: Write minimal implementation**

```ts
// src/git/service.ts
import { Console, Context, Effect, Layer } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

export class Git extends Context.Service<Git>()("Git", {
  make: Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    // Capture trimmed stdout. Spawn/IO failure is a defect (dev tooling).
    const capture = (cwd: string, args: ReadonlyArray<string>) =>
      spawner
        .string(ChildProcess.make("git", args, { cwd }))
        .pipe(Effect.map((s) => s.trim()), Effect.orDie);

    // Run, inherit stdio so git's own output shows, return the exit code.
    // Mirrors process.ts runExit (logs the command, demotes spawn errors to defects).
    const exit = (cwd: string, args: ReadonlyArray<string>) =>
      Console.log(`  $ git ${args.join(" ")}`).pipe(
        Effect.andThen(
          spawner.exitCode(
            ChildProcess.make("git", args, {
              cwd,
              stdin: "inherit",
              stdout: "inherit",
              stderr: "inherit",
            }),
          ),
        ),
        Effect.map(Number),
        Effect.orDie,
      );

    return {
      commonDir: (cwd: string) => capture(cwd, ["rev-parse", "--git-common-dir"]),
    };
  }),
}) {}

export const GitLive = Layer.effect(Git, Git.make);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/git/service.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/git/service.ts src/git/service.test.ts
git commit -m "feat(git): Git service skeleton with commonDir"
```

---

### Task 2: Add `refExists` and `symbolicRef` to the service

**Files:**
- Modify: `src/git/service.ts`
- Test: `src/git/service.test.ts`

**Interfaces:**
- Produces: `git.refExists(cwd: string, ref: string): Effect.Effect<boolean>` and `git.symbolicRef(cwd: string, name: string): Effect.Effect<string | undefined>` (undefined when the symbolic ref does not resolve / exit ≠ 0).

- [ ] **Step 1: Write the failing test** (append to `src/git/service.test.ts`)

```ts
test("refExists is true for an existing branch ref, false otherwise", async () => {
  const root = makeRepo();
  try {
    sh(root, "commit", "--allow-empty", "-m", "init");
    const has = await run(Effect.flatMap(Git, (git) => git.refExists(root, "refs/heads/main")));
    const missing = await run(Effect.flatMap(Git, (git) => git.refExists(root, "refs/heads/nope")));
    expect(has).toBe(true);
    expect(missing).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("symbolicRef returns undefined when the ref is absent", async () => {
  const root = makeRepo();
  try {
    sh(root, "commit", "--allow-empty", "-m", "init");
    const origin = await run(
      Effect.flatMap(Git, (git) => git.symbolicRef(root, "refs/remotes/origin/HEAD")),
    );
    expect(origin).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/git/service.test.ts`
Expected: FAIL — `git.refExists is not a function`.

- [ ] **Step 3: Write minimal implementation** — extend the returned object in `src/git/service.ts`:

```ts
    return {
      commonDir: (cwd: string) => capture(cwd, ["rev-parse", "--git-common-dir"]),

      refExists: (cwd: string, ref: string) =>
        exit(cwd, ["show-ref", "--verify", "--quiet", ref]).pipe(Effect.map((code) => code === 0)),

      symbolicRef: (cwd: string, name: string) =>
        exit(cwd, ["symbolic-ref", "--short", name]).pipe(
          Effect.flatMap((code) =>
            code === 0 ? capture(cwd, ["symbolic-ref", "--short", name]) : Effect.succeed(undefined),
          ),
        ),
    };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/git/service.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/git/service.ts src/git/service.test.ts
git commit -m "feat(git): add refExists + symbolicRef predicates"
```

---

### Task 3: `GitTest` fake layer + `GitTestHandle`

**Files:**
- Create: `src/git/test.ts`
- Test: `src/git/test.ts` is exercised by `base-ref.test.ts` in Task 5; add a focused self-test here.
- Test: `src/git/test.test.ts`

**Interfaces:**
- Produces: `GitTest: Layer<Git | GitTestHandle>` and `class GitTestHandle extends Context.Service<GitTestHandle, GitTestApi>()("GitTestHandle")` where `GitTestApi` = `{ setCommonDir(cwd, dir): Effect<void>; setSymbolicRef(cwd, name, ref: string | undefined): Effect<void>; setRefExists(cwd, ref, exists: boolean): Effect<void> }`. The fake's `git` object satisfies `typeof Git.Service`.

- [ ] **Step 1: Write the failing test**

```ts
// src/git/test.test.ts
import { expect, test } from "bun:test";
import { Effect } from "effect";
import { Git } from "./service.ts";
import { GitTest, GitTestHandle } from "./test.ts";

test("GitTest stages refExists and symbolicRef responses", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const handle = yield* GitTestHandle;
      const git = yield* Git;
      yield* handle.setRefExists("/repo", "refs/heads/main", true);
      yield* handle.setSymbolicRef("/repo", "refs/remotes/origin/HEAD", "origin/main");

      expect(yield* git.refExists("/repo", "refs/heads/main")).toBe(true);
      expect(yield* git.refExists("/repo", "refs/heads/other")).toBe(false);
      expect(yield* git.symbolicRef("/repo", "refs/remotes/origin/HEAD")).toBe("origin/main");
      expect(yield* git.symbolicRef("/repo", "refs/remotes/origin/HEAD2")).toBeUndefined();
    }).pipe(Effect.provide(GitTest)),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/git/test.test.ts`
Expected: FAIL — `Cannot find module './test.ts'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/git/test.ts
import { Context, Effect, Layer, Ref } from "effect";
import { Git } from "./service.ts";

export interface GitTestApi {
  readonly setCommonDir: (cwd: string, dir: string) => Effect.Effect<void>;
  readonly setSymbolicRef: (cwd: string, name: string, ref: string | undefined) => Effect.Effect<void>;
  readonly setRefExists: (cwd: string, ref: string, exists: boolean) => Effect.Effect<void>;
}

export class GitTestHandle extends Context.Service<GitTestHandle, GitTestApi>()("GitTestHandle") {}

// Map key: cwd + a NUL separator + the ref/name (cwd-scoped lookups).
const key = (cwd: string, x: string) => `${cwd} ${x}`;

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/git/test.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/git/test.ts src/git/test.test.ts
git commit -m "feat(git): GitTest fake layer + GitTestHandle"
```

---

### Task 4: Wire `GitLive` into `AppLayer`

**Files:**
- Modify: `src/runtime.ts:13-16`

**Interfaces:**
- Consumes: `GitLive` from Task 1.
- Produces: `AppLayer` now provides `Git` (so `cli.ts` and `mcp.ts` resolve it).

- [ ] **Step 1: Edit `src/runtime.ts`** — add the `Git` import and include `GitLive` in the merge:

```ts
import { BunServices } from "@effect/platform-bun";
import { Layer } from "effect";
import { GitLive } from "./git/service.ts";
import { Herdr } from "./herdr/service.ts";
import { PortAllocator } from "./worktree/ports.ts";

export const AppLayer = Layer.provideMerge(
  Layer.mergeAll(Layer.effect(Herdr, Herdr.make), GitLive, PortAllocator.layer),
  BunServices.layer,
);

export type AppServices = Layer.Success<typeof AppLayer>;
```

- [ ] **Step 2: Verify typecheck still passes** (no runtime change yet — nothing consumes `Git` from `AppLayer` until Task 5)

Run: `bun run typecheck`
Expected: PASS, no errors.

- [ ] **Step 3: Commit**

```bash
git add src/runtime.ts
git commit -m "feat(git): provide Git in AppLayer"
```

---

### Task 5: Migrate `repo.ts` and `base-ref.ts` onto `Git`

**Files:**
- Modify: `src/worktree/repo.ts:1-21`
- Modify: `src/worktree/base-ref.ts:1-34`
- Test: `src/worktree/base-ref.test.ts` (add fake-based tests)
- Modify (test layers): `src/land.test.ts:106`, `src/teardown.test.ts`, `src/worktree/index.test.ts`

**Interfaces:**
- Consumes: `Git` service (`commonDir`, `refExists`, `symbolicRef`), `GitTest` + `GitTestHandle`.
- Produces: `resolveRepo`, `refExists`, `resolveDefaultBaseRef` keep their existing signatures; their R channel now includes `Git`.

- [ ] **Step 1: Write the failing test** (append to `src/worktree/base-ref.test.ts`)

```ts
import { Effect } from "effect";
import { GitTest, GitTestHandle } from "../git/test.ts";
import { refExists, resolveDefaultBaseRef } from "./base-ref.ts";

test("resolveDefaultBaseRef: uses origin/HEAD when present", async () => {
  const branch = await Effect.runPromise(
    Effect.gen(function* () {
      const handle = yield* GitTestHandle;
      yield* handle.setSymbolicRef("/repo", "refs/remotes/origin/HEAD", "origin/trunk");
      return yield* resolveDefaultBaseRef("/repo");
    }).pipe(Effect.provide(GitTest)),
  );
  expect(branch).toBe("trunk");
});

test("resolveDefaultBaseRef: falls back to main when origin/HEAD absent", async () => {
  const branch = await Effect.runPromise(
    Effect.gen(function* () {
      const handle = yield* GitTestHandle;
      yield* handle.setRefExists("/repo", "refs/heads/main", true);
      return yield* resolveDefaultBaseRef("/repo");
    }).pipe(Effect.provide(GitTest)),
  );
  expect(branch).toBe("main");
});

test("refExists delegates to the Git service", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const handle = yield* GitTestHandle;
      yield* handle.setRefExists("/repo", "refs/heads/feature", true);
      return yield* refExists("/repo", "refs/heads/feature");
    }).pipe(Effect.provide(GitTest)),
  );
  expect(result).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/worktree/base-ref.test.ts`
Expected: FAIL — `Service not found: Git` (base-ref still calls `process.ts`, not `Git`).

- [ ] **Step 3: Migrate `src/worktree/repo.ts`** (full file):

```ts
import { Effect, Path } from "effect";
import { Git } from "../git/service.ts";

export interface Repo {
  readonly startCwd: string;
  readonly primaryRoot: string;
  readonly repoName: string;
}

// Locate the primary checkout (where the shared services + canonical .env + the
// homestead config live). git-common-dir is "<primary>/.git" for every worktree.
export const resolveRepo = Effect.fn("homestead/resolve-repo")(function* () {
  const path = yield* Path.Path;
  const git = yield* Git;
  const startCwd = process.cwd();
  const gitCommonDirRaw = yield* git.commonDir(startCwd);
  const gitCommonDir = path.isAbsolute(gitCommonDirRaw)
    ? gitCommonDirRaw
    : path.resolve(startCwd, gitCommonDirRaw);
  const primaryRoot = path.dirname(gitCommonDir);
  return { startCwd, primaryRoot, repoName: path.basename(primaryRoot) } satisfies Repo;
});
```

- [ ] **Step 4: Migrate `src/worktree/base-ref.ts`** (full file):

```ts
import { Effect } from "effect";
import { UsageError } from "../errors.ts";
import { Git } from "../git/service.ts";

export const branchFromOriginHead = (symbolicRef: string): string =>
  symbolicRef.startsWith("origin/") ? symbolicRef.slice("origin/".length) : symbolicRef;

// Thin delegator kept so existing callers (land, teardown, plan, pr/branch) stay
// put this PR; later PRs switch them to git.refExists directly and this is removed.
export const refExists = (primaryRoot: string, ref: string) =>
  Git.pipe(Effect.flatMap((git) => git.refExists(primaryRoot, ref)));

export const resolveDefaultBaseRef = Effect.fn("homestead/resolve-default-base-ref")(function* (
  primaryRoot: string,
) {
  const git = yield* Git;
  const origin = yield* git.symbolicRef(primaryRoot, "refs/remotes/origin/HEAD");
  if (origin !== undefined) return branchFromOriginHead(origin);

  for (const branch of ["main", "master"] as const) {
    if (yield* git.refExists(primaryRoot, `refs/heads/${branch}`)) return branch;
  }

  return yield* new UsageError({
    message:
      "[homestead] could not determine default branch (no origin/HEAD, main, or master) — pass --from explicitly",
  });
});
```

- [ ] **Step 5: Run the new base-ref tests to verify they pass**

Run: `bun test src/worktree/base-ref.test.ts`
Expected: PASS (pure tests + 3 new fake-based tests).

- [ ] **Step 6: Update transitive real-git test layers.** These tests run real code through `base-ref`/`repo` and must now provide a real `Git`. In `src/land.test.ts`, replace the `TestLayer` definition (line ~106):

```ts
import { GitLive } from "./git/service.ts";
// ...
// Real git + filesystem (BunServices) with a real Git service over them, a stub
// Herdr (only reached via --complete), and a captured Console.
const TestLayer = Layer.provideMerge(
  Layer.mergeAll(GitLive, HerdrTest, TestConsole.layer),
  BunServices.layer,
);
```

Apply the identical change to `src/teardown.test.ts` and `src/worktree/index.test.ts`: import `GitLive` and wrap their existing `Layer.mergeAll(BunServices.layer, …)` as `Layer.provideMerge(Layer.mergeAll(GitLive, …non-BunServices layers…), BunServices.layer)`.

- [ ] **Step 7: Run the full suite to catch any other transitive consumer**

Run: `bun run check`
Expected: PASS. If a test fails with `Service not found: Git`, apply the same `provideMerge(GitLive, …)` layer change to that file and re-run.

- [ ] **Step 8: Commit**

```bash
git add src/worktree/repo.ts src/worktree/base-ref.ts src/worktree/base-ref.test.ts \
        src/land.test.ts src/teardown.test.ts src/worktree/index.test.ts
git commit -m "feat(git): route repo + base-ref through the Git seam"
```

---

# PR 2 — `land.ts`, the high-value proof

Deliverable: `land` runs every git operation through `Git`; `git.merge` returns `Merged | Conflict`; `land.test`'s outcome tests run against the fake (no temp repos) with one real-git smoke test kept.

### Task 6: Add the land/merge method family to `Git` + fake

**Files:**
- Modify: `src/git/service.ts`, `src/git/test.ts`
- Test: `src/git/service.test.ts` (real git), `src/git/test.test.ts` (fake)

**Interfaces:**
- Produces on `Git`:
  - `merge(cwd, branch): Effect<MergeResult>` where `type MergeResult = { _tag: "Merged" } | { _tag: "Conflict"; files: ReadonlyArray<string> }` — runs `merge --no-ff --no-commit`; exit 0 → `Merged`; non-zero → capture `diff --name-only --diff-filter=U` → `Conflict`.
  - `abortMerge(cwd): Effect<void>` (tolerant).
  - `mergeBaseIsAncestor(cwd, ref, base): Effect<boolean>`.
  - `addAll(cwd): Effect<void>` (`add -A`, dies on failure).
  - `commitNoEdit(cwd): Effect<void>` (`commit --no-edit`, dies).
  - `currentBranch(cwd): Effect<string>` (`rev-parse --abbrev-ref HEAD`).
  - `status(cwd): Effect<string>` (`status --porcelain`).
  - `stash.push(cwd, message): Effect<boolean>` (`stash push -u -m <message>`; true if exit 0).
  - `stash.pop(cwd): Effect<boolean>` (`stash pop`; true if exit 0).
- Produces on `GitTestApi`: `setMergeResult(cwd, branch, result)`, `setAncestor(cwd, ref, base, value)`, `setCurrentBranch(cwd, branch)`, `setStatus(cwd, porcelain)`, plus a journal of mutations (`{ merges: {cwd,branch}[]; aborts: cwd[]; commits: cwd[]; adds: cwd[]; stashPushes: cwd[]; stashPops: cwd[] }`) read via `handle.journal()`.

- [ ] **Step 1: Write the failing test** (append to `src/git/test.test.ts`)

```ts
test("GitTest stages a merge conflict and journals the abort", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const handle = yield* GitTestHandle;
      const git = yield* Git;
      yield* handle.setMergeResult("/repo", "feature", { _tag: "Conflict", files: ["src/a.ts"] });

      const result = yield* git.merge("/repo", "feature");
      yield* git.abortMerge("/repo");

      expect(result).toEqual({ _tag: "Conflict", files: ["src/a.ts"] });
      const journal = yield* handle.journal();
      expect(journal.merges).toEqual([{ cwd: "/repo", branch: "feature" }]);
      expect(journal.aborts).toEqual(["/repo"]);
    }).pipe(Effect.provide(GitTest)),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/git/test.test.ts`
Expected: FAIL — `handle.setMergeResult is not a function`.

- [ ] **Step 3: Extend `src/git/service.ts`.** Add the `MergeResult` type at top and these helpers + methods. First add a `mutate` helper (dies on non-zero) next to `capture`/`exit`:

```ts
export type MergeResult =
  | { readonly _tag: "Merged" }
  | { readonly _tag: "Conflict"; readonly files: ReadonlyArray<string> };
```

```ts
    // Run; die if non-zero. For mutations whose failure is fatal.
    const mutate = (cwd: string, args: ReadonlyArray<string>) =>
      exit(cwd, args).pipe(
        Effect.flatMap((code) =>
          code === 0
            ? Effect.void
            : Effect.die(new Error(`[homestead] git ${args.join(" ")} failed (exit ${code}) in ${cwd}`)),
        ),
      );

    // Run; ignore the exit code. For tolerant mutations (target may already be gone).
    const attempt = (cwd: string, args: ReadonlyArray<string>) =>
      exit(cwd, args).pipe(Effect.asVoid);

    const splitLines = (s: string) => s.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
```

Then add to the returned object:

```ts
      merge: (cwd: string, branch: string) =>
        exit(cwd, ["merge", "--no-ff", "--no-commit", branch]).pipe(
          Effect.flatMap((code) =>
            code === 0
              ? Effect.succeed({ _tag: "Merged" } as const)
              : capture(cwd, ["diff", "--name-only", "--diff-filter=U"]).pipe(
                  Effect.map((out) => ({ _tag: "Conflict", files: splitLines(out) }) as const),
                ),
          ),
        ),

      abortMerge: (cwd: string) => attempt(cwd, ["merge", "--abort"]),

      mergeBaseIsAncestor: (cwd: string, ref: string, base: string) =>
        exit(cwd, ["merge-base", "--is-ancestor", ref, base]).pipe(Effect.map((code) => code === 0)),

      addAll: (cwd: string) => mutate(cwd, ["add", "-A"]),

      commitNoEdit: (cwd: string) => mutate(cwd, ["commit", "--no-edit"]),

      currentBranch: (cwd: string) => capture(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),

      status: (cwd: string) => capture(cwd, ["status", "--porcelain"]),

      stash: {
        push: (cwd: string, message: string) =>
          exit(cwd, ["stash", "push", "-u", "-m", message]).pipe(Effect.map((code) => code === 0)),
        pop: (cwd: string) => exit(cwd, ["stash", "pop"]).pipe(Effect.map((code) => code === 0)),
      },
```

- [ ] **Step 4: Extend `src/git/test.ts`** — add the journal Ref, the new staging maps, the handle setters, the `journal()` reader, and the matching fake methods.

```ts
// add near the other Refs in buildGitTest:
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
```

```ts
// add to the handle object (and to the GitTestApi interface):
setMergeResult: (cwd: string, branch: string, result: MergeResult) =>
  Ref.update(mergeResults, (m) => new Map(m).set(key(cwd, branch), result)),
setAncestor: (cwd: string, ref: string, base: string, value: boolean) =>
  Ref.update(ancestors, (m) => new Map(m).set(`${cwd} ${ref} ${base}`, value)),
setCurrentBranch: (cwd: string, branch: string) =>
  Ref.update(currentBranches, (m) => new Map(m).set(cwd, branch)),
setStatus: (cwd: string, porcelain: string) =>
  Ref.update(statuses, (m) => new Map(m).set(cwd, porcelain)),
journal: () => Ref.get(journal),
```

```ts
// add to the fake git object:
merge: (cwd: string, branch: string) =>
  Effect.gen(function* () {
    yield* Ref.update(journal, (j) => ({ ...j, merges: [...j.merges, { cwd, branch }] }));
    const staged = (yield* Ref.get(mergeResults)).get(key(cwd, branch));
    return staged ?? ({ _tag: "Merged" } as const);
  }),
abortMerge: (cwd: string) => Ref.update(journal, (j) => ({ ...j, aborts: [...j.aborts, cwd] })),
mergeBaseIsAncestor: (cwd: string, ref: string, base: string) =>
  Ref.get(ancestors).pipe(Effect.map((m) => m.get(`${cwd} ${ref} ${base}`) ?? false)),
addAll: (cwd: string) => Ref.update(journal, (j) => ({ ...j, adds: [...j.adds, cwd] })),
commitNoEdit: (cwd: string) => Ref.update(journal, (j) => ({ ...j, commits: [...j.commits, cwd] })),
currentBranch: (cwd: string) => Ref.get(currentBranches).pipe(Effect.map((m) => m.get(cwd) ?? "main")),
status: (cwd: string) => Ref.get(statuses).pipe(Effect.map((m) => m.get(cwd) ?? "")),
stash: {
  push: (cwd: string, _message: string) =>
    Ref.update(journal, (j) => ({ ...j, stashPushes: [...j.stashPushes, cwd] })).pipe(Effect.as(true)),
  pop: (cwd: string) =>
    Ref.update(journal, (j) => ({ ...j, stashPops: [...j.stashPops, cwd] })).pipe(Effect.as(true)),
},
```

Add `import type { MergeResult } from "./service.ts";` at the top of `test.ts`, and add the four new setters + `journal` to the `GitTestApi` interface (`setMergeResult`, `setAncestor`, `setCurrentBranch`, `setStatus`, `journal`).

- [ ] **Step 5: Add a real-git merge test** (append to `src/git/service.test.ts`)

```ts
test("merge returns Merged on a clean fast-forwardable branch", async () => {
  const root = makeRepo();
  try {
    sh(root, "commit", "--allow-empty", "-m", "base");
    sh(root, "checkout", "-b", "feature");
    sh(root, "commit", "--allow-empty", "-m", "work");
    sh(root, "checkout", "main");
    const result = await run(Effect.flatMap(Git, (git) => git.merge(root, "feature")));
    expect(result._tag).toBe("Merged");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test src/git/`
Expected: PASS (service + fake tests).

- [ ] **Step 7: Commit**

```bash
git add src/git/service.ts src/git/test.ts src/git/service.test.ts src/git/test.test.ts
git commit -m "feat(git): merge/stash/status family + fake journal"
```

---

### Task 7: Migrate `land.ts` onto `Git`

**Files:**
- Modify: `src/land.ts` (call sites at lines 80-86, 96, 102, 110-114, 119, 146, 157, 166, 169-173, 179, 206)

**Interfaces:**
- Consumes: `Git` (`merge`, `abortMerge`, `mergeBaseIsAncestor`, `refExists`, `addAll`, `commitNoEdit`, `status`, `currentBranch`, `stash.push`, `stash.pop`), `resolveDefaultBaseRef`.
- Produces: `landBranch`, `runLand`, and the pure helpers (`globToRegExp`, `isGenerated`, `partitionConflicts`, `resolveLandSettings`) keep their signatures. `verify`/`regen` commands still run through `process.ts` `runExit` (they are arbitrary, non-git commands).

- [ ] **Step 1: Edit `src/land.ts` imports**

```ts
import { Console, Effect } from "effect";
import { DEFAULT_LAND_GENERATED, DEFAULT_LAND_REGEN, DEFAULT_LAND_VERIFY } from "./defaults.ts";
import { Git } from "./git/service.ts";
import { runExit } from "./process.ts"; // kept ONLY for verify/regen (non-git) commands
import { completeBranch } from "./teardown.ts";
import type { HomesteadConfig, LandConfig } from "./types.ts";
import { resolveDefaultBaseRef } from "./worktree/base-ref.ts";
```

(`refExists` is no longer imported from base-ref — use `git.refExists`. Delete the local `conflictedFiles` and `abortMerge` helpers at lines 80-86; `git.merge`/`git.abortMerge` replace them.)

- [ ] **Step 2: Rewrite `landBranch`** (replaces lines 80-160). Note `partitionConflicts` still runs on the conflict files the merge returns:

```ts
export const landBranch = Effect.fn("homestead/land-branch")(function* (
  primaryRoot: string,
  branch: string,
  settings: LandSettings,
): Effect.Effect<LandOutcome, never, Git> {
  const git = yield* Git;

  if (!(yield* git.refExists(primaryRoot, `refs/heads/${branch}`))) {
    yield* Console.log(`  ⚠ no local branch '${branch}'`);
    return { _tag: "missing" };
  }

  if (yield* git.mergeBaseIsAncestor(primaryRoot, branch, "HEAD")) {
    yield* Console.log(`  (already merged '${branch}')`);
    return { _tag: "already" };
  }

  const merge = yield* git.merge(primaryRoot, branch);
  if (merge._tag === "Conflict") {
    const { real } = partitionConflicts(merge.files, settings.generated);
    if (real.length > 0) {
      yield* Console.log(`  ⚠ merge conflicts in: ${real.join(", ")} — aborting`);
      yield* git.abortMerge(primaryRoot);
      return { _tag: "conflict", files: real };
    }
    yield* Console.log(`  (regenerating generated files that conflicted: ${merge.files.join(", ")})`);
  }

  // Regenerate generated artifacts (overwrites any conflicted/merged versions).
  for (const cmd of settings.regen) {
    const [command, ...args] = cmd;
    const code = yield* runExit(command!, args, { cwd: primaryRoot });
    if (code !== 0) {
      yield* Console.log(`  ⚠ regen '${cmd.join(" ")}' failed (exit ${code}) — aborting`);
      yield* git.abortMerge(primaryRoot);
      return { _tag: "regen-failed", command: cmd };
    }
  }

  yield* git.addAll(primaryRoot);

  const [vCmd, ...vArgs] = settings.verify;
  const verifyCode = vCmd === undefined ? 0 : yield* runExit(vCmd, vArgs, { cwd: primaryRoot });
  if (verifyCode !== 0) {
    yield* Console.log(`  ⚠ verify failed (exit ${verifyCode}) — rolling back merge of '${branch}'`);
    yield* git.abortMerge(primaryRoot);
    return { _tag: "red" };
  }

  yield* git.commitNoEdit(primaryRoot);
  yield* Console.log(`  ✓ landed '${branch}'`);
  return { _tag: "landed", branch };
});
```

- [ ] **Step 3: Rewrite `stashIfDirty`/`popStash`** (replaces lines 165-185):

```ts
const stashIfDirty = Effect.fn("homestead/land-stash")(function* (primaryRoot: string) {
  const git = yield* Git;
  const status = yield* git.status(primaryRoot);
  if (status.trim().length === 0) return false;
  yield* Console.log(`  (stashing primary-checkout WIP)`);
  return yield* git.stash.push(primaryRoot, "homestead land autostash");
});

const popStash = Effect.fn("homestead/land-unstash")(function* (primaryRoot: string) {
  const git = yield* Git;
  yield* Console.log(`  (restoring primary-checkout WIP)`);
  const ok = yield* git.stash.pop(primaryRoot);
  if (!ok) {
    yield* Console.log(
      `  ⚠ couldn't restore stashed WIP automatically — run 'git stash pop' in ${primaryRoot}`,
    );
  }
});
```

- [ ] **Step 4: Update `runLand`'s current-branch read** (line 206):

```ts
  const defaultBranch = yield* resolveDefaultBaseRef(primaryRoot);
  const git = yield* Git;
  const current = yield* git.currentBranch(primaryRoot);
```

- [ ] **Step 5: Run typecheck**

Run: `bun run typecheck`
Expected: PASS. (`land.test.ts` already provides `GitLive` from PR1 Task 5, so the real-git tests keep working.)

- [ ] **Step 6: Run the existing land tests against the real-git layer**

Run: `bun test src/land.test.ts`
Expected: PASS — behavior is unchanged; only the seam moved.

- [ ] **Step 7: Commit**

```bash
git add src/land.ts
git commit -m "feat(git): land runs through the Git seam; merge returns Merged|Conflict"
```

---

### Task 8: Rewrite `land.test.ts` outcome tests onto the fake

**Files:**
- Modify: `src/land.test.ts` (the "Real-git integration" section, lines ~67-304)

**Interfaces:**
- Consumes: `GitTest` + `GitTestHandle`, `landBranch`, `runLand`.
- Produces: fast outcome tests for `landed | already | missing | conflict | regen-failed | red`, plus one retained real-git smoke test.

- [ ] **Step 1: Add a fake-driven test layer and outcome tests.** Keep the pure-helper tests (lines 24-65) and `makeRepo`/`sh` helpers (for the smoke test). Add:

```ts
import { GitTest, GitTestHandle } from "./git/test.ts";

// Fast outcome tests: fake git, real process only for verify/regen commands.
const FakeLayer = Layer.provideMerge(
  Layer.mergeAll(GitTest, HerdrTest, TestConsole.layer),
  BunServices.layer,
);
const runFake = <A>(eff: Effect.Effect<A, unknown, any>): Promise<A> =>
  Effect.runPromise(Effect.provide(eff, FakeLayer) as Effect.Effect<A>);

const fakeSettings = (over: Partial<LandSettings> = {}): LandSettings => ({
  verify: ["true"], // a real /usr/bin/true — exits 0
  regen: [],
  generated: ["src/generated/**"],
  ...over,
});

test("landBranch: missing branch → {missing}", async () => {
  const outcome = await runFake(
    Effect.gen(function* () {
      const handle = yield* GitTestHandle;
      yield* handle.setRefExists("/repo", "refs/heads/feature", false);
      return yield* landBranch("/repo", "feature", fakeSettings());
    }),
  );
  expect(outcome).toEqual({ _tag: "missing" });
});

test("landBranch: already merged → {already}", async () => {
  const outcome = await runFake(
    Effect.gen(function* () {
      const handle = yield* GitTestHandle;
      yield* handle.setRefExists("/repo", "refs/heads/feature", true);
      yield* handle.setAncestor("/repo", "feature", "HEAD", true);
      return yield* landBranch("/repo", "feature", fakeSettings());
    }),
  );
  expect(outcome).toEqual({ _tag: "already" });
});

test("landBranch: real conflict → {conflict} and the merge is aborted", async () => {
  const outcome = await runFake(
    Effect.gen(function* () {
      const handle = yield* GitTestHandle;
      yield* handle.setRefExists("/repo", "refs/heads/feature", true);
      yield* handle.setAncestor("/repo", "feature", "HEAD", false);
      yield* handle.setMergeResult("/repo", "feature", { _tag: "Conflict", files: ["src/app.ts"] });
      const result = yield* landBranch("/repo", "feature", fakeSettings());
      const journal = yield* handle.journal();
      expect(journal.aborts).toEqual(["/repo"]);
      return result;
    }),
  );
  expect(outcome).toEqual({ _tag: "conflict", files: ["src/app.ts"] });
});

test("landBranch: generated-only conflict is regenerated, not aborted", async () => {
  const outcome = await runFake(
    Effect.gen(function* () {
      const handle = yield* GitTestHandle;
      yield* handle.setRefExists("/repo", "refs/heads/feature", true);
      yield* handle.setAncestor("/repo", "feature", "HEAD", false);
      yield* handle.setMergeResult("/repo", "feature", {
        _tag: "Conflict",
        files: ["src/generated/types.d.ts"],
      });
      return yield* landBranch("/repo", "feature", fakeSettings({ regen: [] }));
    }),
  );
  expect(outcome).toEqual({ _tag: "landed", branch: "feature" });
});

test("landBranch: red verify → {red} and the merge is rolled back", async () => {
  const outcome = await runFake(
    Effect.gen(function* () {
      const handle = yield* GitTestHandle;
      yield* handle.setRefExists("/repo", "refs/heads/feature", true);
      yield* handle.setAncestor("/repo", "feature", "HEAD", false);
      // merge clean (default Merged), then verify `false` exits non-zero.
      const result = yield* landBranch("/repo", "feature", fakeSettings({ verify: ["false"] }));
      const journal = yield* handle.journal();
      expect(journal.aborts).toEqual(["/repo"]);
      expect(journal.commits).toEqual([]);
      return result;
    }),
  );
  expect(outcome).toEqual({ _tag: "red" });
});

test("landBranch: clean merge + green verify → {landed} and commits", async () => {
  const outcome = await runFake(
    Effect.gen(function* () {
      const handle = yield* GitTestHandle;
      yield* handle.setRefExists("/repo", "refs/heads/feature", true);
      yield* handle.setAncestor("/repo", "feature", "HEAD", false);
      const result = yield* landBranch("/repo", "feature", fakeSettings());
      const journal = yield* handle.journal();
      expect(journal.adds).toEqual(["/repo"]);
      expect(journal.commits).toEqual(["/repo"]);
      return result;
    }),
  );
  expect(outcome).toEqual({ _tag: "landed", branch: "feature" });
});
```

- [ ] **Step 2: Reduce the real-git integration tests to a single end-to-end smoke test.** Delete the now-redundant real-repo outcome tests (the ones the fake tests above now cover) but KEEP one happy-path test that drives `landBranch` through `GitLive` against a real repo, to guard against fake drift. Keep `makeRepo`, `sh`, `write`, `read`, `commitCount`, `isMerge` helpers it needs, and keep the `TestLayer` (real `GitLive`) from PR1. Example retained test:

```ts
test("[real git] land keeps the merge when verify is green", async () => {
  const root = makeRepo();
  try {
    sh(root, "checkout", "-b", "feature");
    write(root, "src/feature.ts", "feature\n");
    sh(root, "add", "-A");
    sh(root, "commit", "-m", "feature");
    sh(root, "checkout", "main");
    const outcome = await run(landBranch(root, "feature", settings()));
    expect(outcome._tag).toBe("landed");
    expect(isMerge(root)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Run the land suite**

Run: `bun test src/land.test.ts`
Expected: PASS — pure helpers, 6 fake outcome tests, 1 real-git smoke test.

- [ ] **Step 4: Commit**

```bash
git add src/land.test.ts
git commit -m "test(land): outcome tests on the Git fake; keep one real-git smoke"
```

---

# PR 3 — Sweep the remaining callers

Deliverable: every remaining git shell-out (`worktree/plan.ts`, `teardown.ts`, `gc.ts`, `pr/branch.ts`) runs through `Git`; no raw `git` invocation remains outside `src/git/`.

### Task 9: Add worktree/branch/fetch/rev methods to `Git` + fake

**Files:**
- Modify: `src/git/service.ts`, `src/git/test.ts`
- Test: `src/git/service.test.ts`, `src/git/test.test.ts`

**Interfaces:**
- Produces on `Git`:
  - `worktree.list(cwd): Effect<ReadonlyArray<WorktreePorcelainEntry>>` — capture `worktree list --porcelain` → `parseWorktreePorcelain`.
  - `worktree.pathForBranch(cwd, branch): Effect<string | undefined>` — `worktree.list` then find by branch.
  - `worktree.add(cwd, { dir, branch }): Effect<void>` — `worktree add <dir> <branch>` (existing branch; dies on failure).
  - `worktree.addNew(cwd, { dir, branch, baseRef }): Effect<void>` — `worktree add -b <branch> <dir> <baseRef>` (dies).
  - `worktree.remove(cwd, path): Effect<void>` — `worktree remove --force <path>` (tolerant).
  - `worktree.prune(cwd): Effect<void>` — `worktree prune` (tolerant).
  - `branch.create(cwd, name, startPoint): Effect<void>` — `branch <name> <startPoint>` (dies).
  - `branch.delete(cwd, name): Effect<void>` — `branch -D <name>` (dies).
  - `branch.deleteRemote(cwd, remote, name): Effect<void>` — `push <remote> --delete <name>` (tolerant).
  - `branch.listLocal(cwd): Effect<ReadonlyArray<string>>` — `for-each-ref --format=%(refname:short) refs/heads` → lines.
  - `fetch(cwd, remote, refspec): Effect<void>` — `fetch <remote> <refspec>` (dies).
  - `statusV2(cwd): Effect<string>` — `status --porcelain=v2 --branch` (raw string; gc parses it).
  - `shortHead(cwd): Effect<string>` — `rev-parse --short HEAD`.
  - `topLevel(cwd): Effect<string>` — `rev-parse --show-toplevel`.
- Produces on `GitTestApi`: `setWorktrees(cwd, entries)`, `setLocalBranches(cwd, names)`, `setStatusV2(cwd, raw)`, `setShortHead(cwd, sha)`, `setTopLevel(cwd, path)`; journal gains `worktreeAdds`, `worktreeRemoves`, `prunes`, `branchCreates`, `branchDeletes`, `remoteDeletes`, `fetches`.

- [ ] **Step 1: Write the failing test** (append to `src/git/test.test.ts`)

```ts
import type { WorktreePorcelainEntry } from "./porcelain.ts";

test("GitTest worktree.list/pathForBranch + remove journal", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const handle = yield* GitTestHandle;
      const git = yield* Git;
      const entries: ReadonlyArray<WorktreePorcelainEntry> = [
        { path: "/wt/main", branch: "main" },
        { path: "/wt/feat", branch: "feature" },
      ];
      yield* handle.setWorktrees("/repo", entries);

      expect(yield* git.worktree.pathForBranch("/repo", "feature")).toBe("/wt/feat");
      yield* git.worktree.remove("/repo", "/wt/feat");

      const journal = yield* handle.journal();
      expect(journal.worktreeRemoves).toEqual([{ cwd: "/repo", path: "/wt/feat" }]);
    }).pipe(Effect.provide(GitTest)),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/git/test.test.ts`
Expected: FAIL — `git.worktree is undefined`.

- [ ] **Step 3: Extend `src/git/service.ts`.** Add `import { parseWorktreePorcelain, worktreePathForBranch, type WorktreePorcelainEntry } from "./porcelain.ts";` and `export type { WorktreePorcelainEntry };`. Add to the returned object:

```ts
      worktree: {
        list: (cwd: string) =>
          capture(cwd, ["worktree", "list", "--porcelain"]).pipe(Effect.map(parseWorktreePorcelain)),
        pathForBranch: (cwd: string, branch: string) =>
          capture(cwd, ["worktree", "list", "--porcelain"]).pipe(
            Effect.map((list) => worktreePathForBranch(list, branch)),
          ),
        add: (cwd: string, opts: { readonly dir: string; readonly branch: string }) =>
          mutate(cwd, ["worktree", "add", opts.dir, opts.branch]),
        addNew: (cwd: string, opts: { readonly dir: string; readonly branch: string; readonly baseRef: string }) =>
          mutate(cwd, ["worktree", "add", "-b", opts.branch, opts.dir, opts.baseRef]),
        remove: (cwd: string, path: string) => attempt(cwd, ["worktree", "remove", "--force", path]),
        prune: (cwd: string) => attempt(cwd, ["worktree", "prune"]),
      },

      branch: {
        create: (cwd: string, name: string, startPoint: string) =>
          mutate(cwd, ["branch", name, startPoint]),
        delete: (cwd: string, name: string) => mutate(cwd, ["branch", "-D", name]),
        deleteRemote: (cwd: string, remote: string, name: string) =>
          attempt(cwd, ["push", remote, "--delete", name]),
        listLocal: (cwd: string) =>
          capture(cwd, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]).pipe(
            Effect.map(splitLines),
          ),
      },

      fetch: (cwd: string, remote: string, refspec: string) =>
        mutate(cwd, ["fetch", remote, refspec]),

      statusV2: (cwd: string) => capture(cwd, ["status", "--porcelain=v2", "--branch"]),
      shortHead: (cwd: string) => capture(cwd, ["rev-parse", "--short", "HEAD"]),
      topLevel: (cwd: string) => capture(cwd, ["rev-parse", "--show-toplevel"]),
```

- [ ] **Step 4: Extend `src/git/test.ts`** with the matching Refs (`worktreesByCwd`, `localBranches`, `statusV2Map`, `shortHeads`, `topLevels`), journal fields (`worktreeAdds`, `worktreeRemoves`, `prunes`, `branchCreates`, `branchDeletes`, `remoteDeletes`, `fetches`), handle setters (`setWorktrees`, `setLocalBranches`, `setStatusV2`, `setShortHead`, `setTopLevel`), and the fake `worktree`/`branch`/`fetch`/`statusV2`/`shortHead`/`topLevel` methods. Each mutation appends to its journal array; each query reads its Ref with a sensible default (`[]`, `""`). Mirror the exact shape used in Task 6. Add the new setters and `WorktreePorcelainEntry` import to `GitTestApi`.

- [ ] **Step 5: Add a real-git worktree test** (append to `src/git/service.test.ts`)

```ts
test("worktree.list reports the primary checkout", async () => {
  const root = makeRepo();
  try {
    sh(root, "commit", "--allow-empty", "-m", "init");
    const entries = await run(Effect.flatMap(Git, (git) => git.worktree.list(root)));
    expect(entries.some((e) => e.branch === "main")).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 6: Run the git suite**

Run: `bun test src/git/`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/git/service.ts src/git/test.ts src/git/service.test.ts src/git/test.test.ts
git commit -m "feat(git): worktree/branch/fetch/rev methods + fake"
```

---

### Task 10: Migrate `worktree/plan.ts`

**Files:**
- Modify: `src/worktree/plan.ts` (call sites at lines 203, 218, 222-223, 230-232, 268; imports at line 20)

**Interfaces:**
- Consumes: `Git` (`refExists`, `worktree.add`, `worktree.addNew`, `worktree.list`, `topLevel`, `currentBranch`, `shortHead`), `resolveDefaultBaseRef`.

- [ ] **Step 1: Update imports** — drop `capture`/`run` for git from `process.ts` (keep any non-git process usage), drop `refExists` from `base-ref`, add `import { Git } from "../git/service.ts";` and obtain `const git = yield* Git;` inside `resolvePlan`.

- [ ] **Step 2: Replace each git call** (before → after):
  - L203 `yield* refExists(repo.primaryRoot, \`refs/heads/${branch}\`)` → `yield* git.refExists(repo.primaryRoot, \`refs/heads/${branch}\`)`
  - L218 `run("git worktree add", "git", ["worktree","add",targetDir,branch], {cwd})` → `git.worktree.add(repo.startCwd, { dir: targetDir, branch })`
  - L222-223 `run("git worktree add", "git", ["worktree","add","-b",branch,targetDir,baseRef], {cwd})` → `git.worktree.addNew(repo.startCwd, { dir: targetDir, branch, baseRef })`
  - L230 `capture("git", ["rev-parse","--show-toplevel"], repo.startCwd)` → `git.topLevel(repo.startCwd)`
  - L231 `capture("git", ["rev-parse","--abbrev-ref","HEAD"], targetDir)` → `git.currentBranch(targetDir)`
  - L232 `capture("git", ["rev-parse","--short","HEAD"], targetDir)` → `git.shortHead(targetDir)`
  - L268 `capture("git", ["worktree","list","--porcelain"], repo.startCwd)` → `git.worktree.list(repo.startCwd)` (returns parsed entries — drop the now-unneeded `parseWorktreePorcelain` import/usage here and consume entries directly)

- [ ] **Step 3: Update the plan test layer.** In `src/worktree/index.test.ts` (already given `GitLive` in PR1) confirm coverage; if `plan` has its own test that drove real git, add `GitLive` via the `provideMerge` form.

- [ ] **Step 4: Run**

Run: `bun run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/worktree/plan.ts src/worktree/index.test.ts
git commit -m "feat(git): sweep worktree/plan onto the Git seam"
```

---

### Task 11: Migrate `teardown.ts`

**Files:**
- Modify: `src/teardown.ts` (call sites at lines 68, 72, 77, 92, 112-113; imports at line 8)

**Interfaces:**
- Consumes: `Git` (`worktree.pathForBranch`, `worktree.remove`, `worktree.prune`, `branch.deleteRemote`, `branch.delete`, `refExists`).

- [ ] **Step 1: Update imports** — drop `refExists` from `base-ref` and the git `capture`/`runExit` usage; add `import { Git } from "./git/service.ts";`, obtain `const git = yield* Git;` in `teardownWorktree`/`killBranch`.

- [ ] **Step 2: Replace each git call** (before → after):
  - L68 `capture("git", ["worktree","list","--porcelain"], primaryRoot)` then `worktreePathForBranch(list, branch)` → `git.worktree.pathForBranch(primaryRoot, branch)` (drops the porcelain import in this file)
  - L72 `runExit("git", ["worktree","remove","--force",path], {cwd:primaryRoot})` → `git.worktree.remove(primaryRoot, path)`
  - L77 `runExit("git", ["worktree","prune"], {cwd:primaryRoot})` → `git.worktree.prune(primaryRoot)`
  - L92 `runExit("git", ["push","origin","--delete",branch], {cwd:primaryRoot}).pipe(...)` → `git.branch.deleteRemote(primaryRoot, "origin", branch)` (the tolerant `.pipe(...)` is now inside the method)
  - L112 `yield* refExists(primaryRoot, \`refs/heads/${branch}\`)` → `yield* git.refExists(primaryRoot, \`refs/heads/${branch}\`)`
  - L113 `runExit("git", ["branch","-D",branch], {cwd:primaryRoot})` → `git.branch.delete(primaryRoot, branch)`

- [ ] **Step 3: Run**

Run: `bun test src/teardown.test.ts` then `bun run check`
Expected: PASS. (`teardown.test.ts` already has `GitLive` from PR1.)

- [ ] **Step 4: Commit**

```bash
git add src/teardown.ts
git commit -m "feat(git): sweep teardown onto the Git seam"
```

---

### Task 12: Migrate `gc.ts`

**Files:**
- Modify: `src/gc.ts` (call sites at lines 302, 378, 505, 509)

**Interfaces:**
- Consumes: `Git` (`statusV2`, `branch.listLocal`, `worktree.remove`, `worktree.prune`).

- [ ] **Step 1: Update imports/usage** — add `import { Git } from "./git/service.ts";`, obtain `const git = yield* Git;` in `scanGc`/`reclaimItem`; drop the git `capture`/`runExit` calls.

- [ ] **Step 2: Replace each git call** (before → after):
  - L302 `capture("git", ["status","--porcelain=v2","--branch"], dir)` → `git.statusV2(dir)` (the existing `parseGitStatus` continues to consume the raw string)
  - L378 `capture("git", ["for-each-ref","--format=%(refname:short)","refs/heads"], repo.startCwd)` → `git.branch.listLocal(repo.startCwd)` (returns `string[]` — drop the local line-splitting)
  - L505 `runExit("git", ["worktree","remove","--force", item.worktreePath], {cwd: repo.primaryRoot})` → `git.worktree.remove(repo.primaryRoot, item.worktreePath)`
  - L509 `runExit("git", ["worktree","prune"], {cwd: repo.primaryRoot})` → `git.worktree.prune(repo.primaryRoot)`

- [ ] **Step 3: Update `gc.test.ts` layer** — add `GitLive` via the `provideMerge` form if `scanGc`/`reclaimItem` are driven through real git there.

- [ ] **Step 4: Run**

Run: `bun test src/gc.test.ts` then `bun run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gc.ts src/gc.test.ts
git commit -m "feat(git): sweep gc onto the Git seam"
```

---

### Task 13: Migrate `pr/branch.ts` + retire the `base-ref` `refExists` wrapper

**Files:**
- Modify: `src/pr/branch.ts` (call sites at lines 29, 38, 39, 41; imports at line 3)
- Modify: `src/worktree/base-ref.ts` (remove the now-unused `refExists` delegator)

**Interfaces:**
- Consumes: `Git` (`fetch`, `refExists`, `branch.create`).

- [ ] **Step 1: Migrate `src/pr/branch.ts`** — add `import { Git } from "../git/service.ts";`, obtain `const git = yield* Git;` in `ensureLocalBranch`; drop `refExists` from `base-ref`:
  - L29 (fork) `run("git fetch (pr head)", "git", ["fetch","origin", \`+pull/${pr.number}/head:${checkout.branch}\`], …)` → `git.fetch(primaryRoot, "origin", \`+pull/${pr.number}/head:${checkout.branch}\`)`
  - L38 `run("git fetch", "git", ["fetch","origin", pr.headRefName], {cwd: primaryRoot})` → `git.fetch(primaryRoot, "origin", pr.headRefName)`
  - L39 `yield* refExists(primaryRoot, \`refs/heads/${checkout.branch}\`)` → `yield* git.refExists(primaryRoot, \`refs/heads/${checkout.branch}\`)`
  - L41 `run("git branch", "git", ["branch", checkout.branch, \`origin/${pr.headRefName}\`], {cwd})` → `git.branch.create(primaryRoot, checkout.branch, \`origin/${pr.headRefName}\`)`

- [ ] **Step 2: Confirm `refExists` from `base-ref` is now unused**

Run: `grep -rn "refExists" src --include='*.ts' | grep "base-ref"`
Expected: only the export line in `base-ref.ts` itself (no importers). If any importer remains, migrate it to `git.refExists` first.

- [ ] **Step 3: Remove the `refExists` delegator** from `src/worktree/base-ref.ts` (keep `branchFromOriginHead` and `resolveDefaultBaseRef`). Update `base-ref.test.ts` to drop the `refExists`-delegation test.

- [ ] **Step 4: Run**

Run: `bun run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pr/branch.ts src/worktree/base-ref.ts src/worktree/base-ref.test.ts
git commit -m "feat(git): sweep pr/branch; retire base-ref refExists wrapper"
```

---

### Task 14: Final sweep verification — no raw git outside `src/git/`

**Files:**
- Read-only verification across `src/`.

- [ ] **Step 1: Confirm no `git` shell-outs remain outside the module**

Run:
```bash
grep -rnE '(capture|run|runExit|safeCapture)\(' src --include='*.ts' | grep -vE '\.test\.ts' | grep -E '"git'
```
Expected: NO matches in any file other than `src/git/`. (`gh` matches are expected and out of scope.)

- [ ] **Step 2: Confirm the full gate is green**

Run: `bun run check`
Expected: PASS (gen-check, typecheck, all tests).

- [ ] **Step 3: Commit any final test-layer cleanups**

```bash
git add -A
git commit -m "chore(git): finish the sweep — git access lives in one module"
```

---

## Self-Review

**1. Spec coverage (against the grilled design):**
- git only, `gh` untouched → Tasks scope to `"git"` calls; Task 14 grep confirms `gh` left alone. ✓
- `Context.Service` + fake adapter (real seam) → Tasks 1-3 build `Git` + `GitTest` mirroring `Herdr`. ✓
- grouped domain ops, per-call `cwd`, porcelain folded in, no escape hatch → service methods are grouped (`worktree.*`, `branch.*`, `stash.*`), every method takes `cwd`, `worktree.list` returns parsed entries, and no `git(args)` method exists. ✓
- hybrid error model (die / boolean / typed return) → `mutate` dies, `attempt` tolerates, predicates return `boolean`, `merge` returns `Merged | Conflict`. ✓
- migration: plumbing-first (PR1: repo + base-ref) → value-first (PR2: land) → sweep (PR3) → matches the three-PR structure. ✓
- Git's own tests use real git; caller tests use the fake (replace, don't layer) → Tasks 1/2/6/9 add real-git service tests; Task 8 replaces land's real-repo outcome tests with fake tests + one smoke; Tasks 11-12 reuse the real-git layer where fidelity matters. ✓
- No `CONTEXT.md` change (Git is infrastructure, not domain language) → no such task. ✓

**2. Placeholder scan:** Every code step shows complete code. Tasks 9-13 reference methods by exact name and give before→after for each call site. Task 4 names the exact merge edit. No "TBD"/"similar to"/"add error handling" left. ✓

**3. Type consistency:** Method names are stable across tasks — `commonDir`, `refExists`, `symbolicRef`, `merge`/`abortMerge`/`mergeBaseIsAncestor`, `addAll`/`commitNoEdit`, `currentBranch`, `status`/`statusV2`, `stash.push`/`stash.pop`, `worktree.{list,pathForBranch,add,addNew,remove,prune}`, `branch.{create,delete,deleteRemote,listLocal}`, `fetch`, `shortHead`, `topLevel`. `MergeResult` is defined once (Task 6) and reused (Tasks 7, 8). Fake setters (`setRefExists`, `setSymbolicRef`, `setMergeResult`, `setAncestor`, `setWorktrees`, …) match the methods they stage. `GitLive`/`GitTest`/`GitTestHandle` names are consistent throughout. ✓
