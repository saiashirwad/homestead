import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GitLive } from "../git/service.ts";
import { readEnvVar, slugify } from "../text.ts";
import type { HomesteadConfig } from "../types.ts";
import { provisionTarget, type Repo } from "./index.ts";
import { PortAllocator } from "./ports.ts";

const Layers = Layer.provideMerge(Layer.mergeAll(GitLive, PortAllocator.layer), BunServices.layer);

let home: string;
let repoRoot: string;
let worktreesRoot: string;
let homeSpy: ReturnType<typeof spyOn>;

const git = (cwd: string, args: ReadonlyArray<string>) =>
  execFileSync("git", [...args], { cwd, stdio: "ignore" });

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "homestead-wt-home-"));
  repoRoot = mkdtempSync(path.join(os.tmpdir(), "homestead-wt-repo-"));
  worktreesRoot = mkdtempSync(path.join(os.tmpdir(), "homestead-wt-wts-"));
  git(repoRoot, ["init", "-b", "main"]);
  git(repoRoot, ["config", "user.email", "t@example.com"]);
  git(repoRoot, ["config", "user.name", "Test"]);
  git(repoRoot, ["config", "commit.gpgsign", "false"]);
  writeFileSync(path.join(repoRoot, "README.md"), "hi\n");
  git(repoRoot, ["add", "."]);
  git(repoRoot, ["commit", "-m", "init"]);
  homeSpy = spyOn(os, "homedir").mockReturnValue(home);
});

afterEach(() => {
  homeSpy.mockRestore();
  for (const d of [home, repoRoot, worktreesRoot]) rmSync(d, { recursive: true, force: true });
});

test("concurrent provisionTarget provisions assign distinct ports per branch", async () => {
  const repo: Repo = { startCwd: repoRoot, primaryRoot: repoRoot, repoName: path.basename(repoRoot) };
  const config: HomesteadConfig = {
    worktreeDir: (ctx) => path.join(worktreesRoot, ctx.slug),
    ports: [{ key: "PORT", base: 41000 }],
  };
  const branches = ["alpha", "beta", "gamma", "delta"];

  for (const branch of branches) {
    const targetDir = path.join(worktreesRoot, branch);
    git(repoRoot, ["worktree", "add", "-b", branch, targetDir, "main"]);
  }

  const plans = await Effect.runPromise(
    Effect.forEach(
      branches,
      (branch) => {
        const targetDir = path.join(worktreesRoot, branch);
        const target = { targetDir, branch, slug: slugify(branch) };
        return provisionTarget(config, repo, target, { noSetup: false });
      },
      { concurrency: branches.length },
    ).pipe(Effect.provide(Layers)),
  );

  const ports = plans.map((p) => Number(Object.fromEntries(p.envEdits)["PORT"]));
  expect(new Set(ports).size).toBe(branches.length);
  for (const port of ports) expect(Number.isInteger(port)).toBe(true);

  const onDisk = branches.map((b) => {
    const env = readFileSync(path.join(worktreesRoot, slugify(b), ".env"), "utf8");
    return Number(readEnvVar(env, "PORT"));
  });
  expect(new Set(onDisk).size).toBe(branches.length);

  const registry = path.join(home, ".homestead", "state", slugify(repo.repoName), "reservations.json");
  const remaining = JSON.parse(readFileSync(registry, "utf8")).reservations as ReadonlyArray<unknown>;
  expect(remaining).toEqual([]);
});
