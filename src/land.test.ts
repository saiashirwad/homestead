import { expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { TestConsole } from "effect/testing";
import { HerdrTest } from "./herdr/test.ts";
import { GitLive } from "./git/service.ts";
import { GitTest, GitTestHandle } from "./git/test.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import {
  globToRegExp,
  isGenerated,
  landBranch,
  partitionConflicts,
  resolveLandSettings,
  runLand,
  type LandSettings,
} from "./land.ts";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("globToRegExp: `*` stays within a segment, `**` crosses segments", () => {
  expect(globToRegExp("src/generated/*.d.ts").test("src/generated/types.d.ts")).toBe(true);
  expect(globToRegExp("src/generated/*.d.ts").test("src/generated/a/types.d.ts")).toBe(false);
  expect(globToRegExp("src/generated/**").test("src/generated/a/b.ts")).toBe(true);
  expect(globToRegExp("src/generated/**").test("src/other/x.ts")).toBe(false);
  // dots are literal, not "any char"
  expect(globToRegExp("a.ts").test("axts")).toBe(false);
});

test("isGenerated: exact, directory-prefix, and glob matching", () => {
  const pats = ["src/generated/**", "schema.json"];
  expect(isGenerated("src/generated/x.d.ts", pats)).toBe(true);
  expect(isGenerated("schema.json", pats)).toBe(true);
  expect(isGenerated("src/app.ts", pats)).toBe(false);
  // a non-glob pattern also covers its directory subtree
  expect(isGenerated("src/generated/deep/y.ts", ["src/generated"])).toBe(true);
  expect(isGenerated("src/generatedX.ts", ["src/generated"])).toBe(false);
});

test("partitionConflicts splits generated from real conflicts", () => {
  const { generated, real } = partitionConflicts(
    ["src/generated/types.d.ts", "src/app.ts"],
    ["src/generated/**"],
  );
  expect(generated).toEqual(["src/generated/types.d.ts"]);
  expect(real).toEqual(["src/app.ts"]);
});

test("resolveLandSettings: defaults, opt-out via [], and overrides", () => {
  const d = resolveLandSettings(undefined);
  expect(d.verify).toEqual(["bun", "run", "check"]);
  expect(d.regen).toEqual([["bun", "run", "gen:config-types"]]);
  expect(d.generated).toEqual(["src/generated/**"]);

  // explicit [] opts a section out (vs. undefined which falls back to default)
  const optOut = resolveLandSettings({ regen: [] });
  expect(optOut.regen).toEqual([]);

  const over = resolveLandSettings({ verify: ["make", "ci"], generated: ["gen"] });
  expect(over.verify).toEqual(["make", "ci"]);
  expect(over.generated).toEqual(["gen"]);
});

// ---------------------------------------------------------------------------
// Fake-driven outcome tests (fast, no temp repos)
// ---------------------------------------------------------------------------

// Fast outcome tests: fake git, real process only for verify/regen commands.
const FakeLayer = Layer.provideMerge(
  Layer.mergeAll(GitTest, HerdrTest, TestConsole.layer),
  BunServices.layer,
);
const runFake = <A>(eff: Effect.Effect<A, unknown, any>): Promise<A> =>
  Effect.runPromise(Effect.provide(eff, FakeLayer) as Effect.Effect<A>);

// Use a real directory so `runExit` (verify/regen) can spawn in an existing cwd.
// The fake Git service keys on this string for all in-memory state.
const FAKE_ROOT = process.cwd();

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
      yield* handle.setRefExists(FAKE_ROOT, "refs/heads/feature", false);
      return yield* landBranch(FAKE_ROOT, "feature", fakeSettings());
    }),
  );
  expect(outcome).toEqual({ _tag: "missing" });
});

test("landBranch: already merged → {already}", async () => {
  const outcome = await runFake(
    Effect.gen(function* () {
      const handle = yield* GitTestHandle;
      yield* handle.setRefExists(FAKE_ROOT, "refs/heads/feature", true);
      yield* handle.setAncestor(FAKE_ROOT, "feature", "HEAD", true);
      return yield* landBranch(FAKE_ROOT, "feature", fakeSettings());
    }),
  );
  expect(outcome).toEqual({ _tag: "already" });
});

test("landBranch: real conflict → {conflict} and the merge is aborted", async () => {
  const outcome = await runFake(
    Effect.gen(function* () {
      const handle = yield* GitTestHandle;
      yield* handle.setRefExists(FAKE_ROOT, "refs/heads/feature", true);
      yield* handle.setAncestor(FAKE_ROOT, "feature", "HEAD", false);
      yield* handle.setMergeResult(FAKE_ROOT, "feature", { _tag: "Conflict", files: ["src/app.ts"] });
      const result = yield* landBranch(FAKE_ROOT, "feature", fakeSettings());
      const journal = yield* handle.journal();
      expect(journal.aborts).toEqual([FAKE_ROOT]);
      return result;
    }),
  );
  expect(outcome).toEqual({ _tag: "conflict", files: ["src/app.ts"] });
});

test("landBranch: generated-only conflict is regenerated, not aborted", async () => {
  const outcome = await runFake(
    Effect.gen(function* () {
      const handle = yield* GitTestHandle;
      yield* handle.setRefExists(FAKE_ROOT, "refs/heads/feature", true);
      yield* handle.setAncestor(FAKE_ROOT, "feature", "HEAD", false);
      yield* handle.setMergeResult(FAKE_ROOT, "feature", {
        _tag: "Conflict",
        files: ["src/generated/types.d.ts"],
      });
      return yield* landBranch(FAKE_ROOT, "feature", fakeSettings({ regen: [] }));
    }),
  );
  expect(outcome).toEqual({ _tag: "landed", branch: "feature" });
});

test("landBranch: red verify → {red} and the merge is rolled back", async () => {
  const outcome = await runFake(
    Effect.gen(function* () {
      const handle = yield* GitTestHandle;
      yield* handle.setRefExists(FAKE_ROOT, "refs/heads/feature", true);
      yield* handle.setAncestor(FAKE_ROOT, "feature", "HEAD", false);
      // merge clean (default Merged), then verify `false` exits non-zero.
      const result = yield* landBranch(FAKE_ROOT, "feature", fakeSettings({ verify: ["false"] }));
      const journal = yield* handle.journal();
      expect(journal.aborts).toEqual([FAKE_ROOT]);
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
      yield* handle.setRefExists(FAKE_ROOT, "refs/heads/feature", true);
      yield* handle.setAncestor(FAKE_ROOT, "feature", "HEAD", false);
      const result = yield* landBranch(FAKE_ROOT, "feature", fakeSettings());
      const journal = yield* handle.journal();
      expect(journal.adds).toEqual([FAKE_ROOT]);
      expect(journal.commits).toEqual([FAKE_ROOT]);
      return result;
    }),
  );
  expect(outcome).toEqual({ _tag: "landed", branch: "feature" });
});

// ---------------------------------------------------------------------------
// Real-git integration
// ---------------------------------------------------------------------------

const git = (cwd: string, ...args: ReadonlyArray<string>): string =>
  execFileSync("git", args as string[], { cwd, stdio: "pipe" }).toString();

const write = (root: string, rel: string, content: string) => {
  const full = nodePath.join(root, rel);
  mkdirSync(nodePath.dirname(full), { recursive: true });
  writeFileSync(full, content);
};

const read = (root: string, rel: string) => readFileSync(nodePath.join(root, rel), "utf8");

// Build a temp repo on `main` with app.ts, notes.txt, and a generated file.
const makeRepo = (): string => {
  const root = mkdtempSync(nodePath.join(os.tmpdir(), "homestead-land-"));
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "Test");
  git(root, "config", "commit.gpgsign", "false");
  write(root, "src/app.ts", "base\n");
  write(root, "notes.txt", "base notes\n");
  write(root, "src/generated/types.d.ts", "GEN-base\n");
  git(root, "add", "-A");
  git(root, "commit", "-m", "init");
  return root;
};

const settings = (over: Partial<LandSettings> = {}): LandSettings => ({
  verify: ["true"],
  regen: [],
  generated: ["src/generated/**"],
  ...over,
});

// Real git + filesystem (BunServices) with a real Git service over them, a stub
// Herdr (only reached via --complete), and a captured Console to keep output quiet.
const TestLayer = Layer.provideMerge(
  Layer.mergeAll(GitLive, HerdrTest, TestConsole.layer),
  BunServices.layer,
);
const run = <A>(eff: Effect.Effect<A, unknown, any>): Promise<A> =>
  Effect.runPromise(Effect.provide(eff, TestLayer) as Effect.Effect<A>);

const isMerge = (root: string): boolean => {
  try {
    git(root, "rev-parse", "--verify", "HEAD^2");
    return true;
  } catch {
    return false;
  }
};

test("land keeps the merge when verify is green", async () => {
  const root = makeRepo();
  try {
    git(root, "checkout", "-b", "feat");
    write(root, "src/app.ts", "feat change\n");
    git(root, "add", "-A");
    git(root, "commit", "-m", "feat");
    git(root, "checkout", "main");

    const outcome = await run(landBranch(root, "feat", settings()));

    expect(outcome._tag).toBe("landed");
    expect(isMerge(root)).toBe(true);
    expect(read(root, "src/app.ts")).toBe("feat change\n");
    expect(git(root, "status", "--porcelain").trim()).toBe("");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runLand refuses when the primary checkout is off the default branch", async () => {
  const root = makeRepo();
  try {
    git(root, "checkout", "-b", "feat");
    const before = git(root, "rev-parse", "HEAD").trim();

    const ok = await run(
      runLand(root, "repo", ["feat"], undefined, {
        complete: false,
        keepRemote: false,
        allowSpawned: false,
      }),
    );

    expect(ok).toBe(false);
    expect(git(root, "rev-parse", "HEAD").trim()).toBe(before); // nothing merged
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runLand auto-stashes the primary checkout WIP and restores it around the merge", async () => {
  const root = makeRepo();
  try {
    git(root, "checkout", "-b", "feat");
    write(root, "src/app.ts", "feat change\n");
    git(root, "add", "-A");
    git(root, "commit", "-m", "feat");
    git(root, "checkout", "main");

    // dirty WIP in the primary checkout: a modified tracked file + an untracked one
    write(root, "notes.txt", "dirty wip\n");
    write(root, "scratch.txt", "scratch\n");

    await run(
      runLand(root, "repo", ["feat"], { land: { verify: ["true"], regen: [] } }, {
        complete: false,
        keepRemote: false,
        allowSpawned: false,
      }),
    );

    // merge landed
    expect(isMerge(root)).toBe(true);
    expect(read(root, "src/app.ts")).toBe("feat change\n");
    // WIP restored
    expect(read(root, "notes.txt")).toBe("dirty wip\n");
    expect(existsSync(nodePath.join(root, "scratch.txt"))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
