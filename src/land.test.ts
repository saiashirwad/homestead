import { expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { TestConsole } from "effect/testing";
import { HerdrTest } from "./herdr/test.ts";
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

// Real git + filesystem (BunServices), a stub Herdr (only reached via --complete,
// which these tests don't exercise), and a captured Console to keep output quiet.
const TestLayer = Layer.mergeAll(BunServices.layer, HerdrTest, TestConsole.layer);
const run = <A>(eff: Effect.Effect<A, unknown, any>): Promise<A> =>
  Effect.runPromise(Effect.provide(eff, TestLayer) as Effect.Effect<A>);

const commitCount = (root: string) => Number(git(root, "rev-list", "--count", "HEAD").trim());

const isMerge = (root: string): boolean => {
  try {
    git(root, "rev-parse", "--verify", "HEAD^2");
    return true;
  } catch {
    return false;
  }
};

const mergeInProgress = (root: string): boolean => {
  try {
    git(root, "rev-parse", "--verify", "MERGE_HEAD");
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

test("land rolls back the merge when verify is red", async () => {
  const root = makeRepo();
  try {
    const before = git(root, "rev-parse", "HEAD").trim();
    git(root, "checkout", "-b", "feat");
    write(root, "src/app.ts", "feat change\n");
    git(root, "add", "-A");
    git(root, "commit", "-m", "feat");
    git(root, "checkout", "main");

    const outcome = await run(landBranch(root, "feat", settings({ verify: ["false"] })));

    expect(outcome._tag).toBe("red");
    expect(git(root, "rev-parse", "HEAD").trim()).toBe(before);
    expect(read(root, "src/app.ts")).toBe("base\n");
    expect(mergeInProgress(root)).toBe(false);
    expect(git(root, "status", "--porcelain").trim()).toBe("");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("land resolves a generated-file conflict by regenerating, not failing", async () => {
  const root = makeRepo();
  try {
    git(root, "checkout", "-b", "feat");
    write(root, "src/generated/types.d.ts", "GEN-feat\n");
    write(root, "src/app.ts", "feat app\n");
    git(root, "add", "-A");
    git(root, "commit", "-m", "feat");
    git(root, "checkout", "main");
    // diverge the generated file on main too -> textual conflict on merge
    write(root, "src/generated/types.d.ts", "GEN-main\n");
    git(root, "add", "-A");
    git(root, "commit", "-m", "main gen");

    const outcome = await run(
      landBranch(
        root,
        "feat",
        settings({
          regen: [["sh", "-c", "printf 'GEN-final\\n' > src/generated/types.d.ts"]],
        }),
      ),
    );

    expect(outcome._tag).toBe("landed");
    expect(isMerge(root)).toBe(true);
    expect(read(root, "src/generated/types.d.ts")).toBe("GEN-final\n");
    expect(read(root, "src/app.ts")).toBe("feat app\n");
    expect(git(root, "status", "--porcelain").trim()).toBe("");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("land aborts on a real (non-generated) conflict", async () => {
  const root = makeRepo();
  try {
    git(root, "checkout", "-b", "feat");
    write(root, "src/app.ts", "feat side\n");
    git(root, "add", "-A");
    git(root, "commit", "-m", "feat");
    git(root, "checkout", "main");
    write(root, "src/app.ts", "main side\n");
    git(root, "add", "-A");
    git(root, "commit", "-m", "main");
    const before = git(root, "rev-parse", "HEAD").trim();

    const outcome = await run(landBranch(root, "feat", settings()));

    expect(outcome._tag).toBe("conflict");
    if (outcome._tag === "conflict") expect(outcome.files).toContain("src/app.ts");
    expect(git(root, "rev-parse", "HEAD").trim()).toBe(before);
    expect(mergeInProgress(root)).toBe(false);
    expect(read(root, "src/app.ts")).toBe("main side\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("land reports already-merged when the branch is an ancestor", async () => {
  const root = makeRepo();
  try {
    git(root, "branch", "feat"); // feat == main, no new commits
    const outcome = await run(landBranch(root, "feat", settings()));
    expect(outcome._tag).toBe("already");
    expect(commitCount(root)).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("land reports missing for an unknown branch", async () => {
  const root = makeRepo();
  try {
    const outcome = await run(landBranch(root, "nope", settings()));
    expect(outcome._tag).toBe("missing");
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
