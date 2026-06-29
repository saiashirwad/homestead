import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HerdrTest } from "../herdr/test.ts";
import { readEnvVar, slugify } from "../text.ts";
import type { HomesteadConfig } from "../types.ts";
import { setupWorktree, type Repo } from "./index.ts";
import { PortAllocator } from "./ports.ts";

// End-to-end regression for the parallel-safe provisioning the issue turns on:
// provisioning several worktrees CONCURRENTLY must still hand each a distinct
// port. This exercises the whole stack — the in-process Semaphore (Layer 1) +
// the reservations registry/lockfile (Layer 2) + writeEnv — against a real git
// repo, which is exactly the race `launchIssues({ concurrency })` would hit.

const Layers = Layer.provideMerge(Layer.mergeAll(HerdrTest, PortAllocator.layer), BunServices.layer);

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

test("concurrent setupWorktree provisions assign distinct ports per branch", async () => {
  const repo: Repo = { startCwd: repoRoot, primaryRoot: repoRoot, repoName: path.basename(repoRoot) };
  // High base unlikely to have a live listener; probing picks the next free one.
  const config: HomesteadConfig = {
    worktreeDir: (ctx) => path.join(worktreesRoot, ctx.slug),
    ports: [{ key: "PORT", base: 41000 }],
  };
  const branches = ["alpha", "beta", "gamma", "delta"];

  const plans = await Effect.runPromise(
    Effect.forEach(branches, (branch) => setupWorktree(config, { create: branch }, repo), {
      concurrency: branches.length,
    }).pipe(Effect.provide(Layers)),
  );

  // Each plan's PORT is unique.
  const ports = plans.map((p) => Number(Object.fromEntries(p.envEdits)["PORT"]));
  expect(new Set(ports).size).toBe(branches.length);
  for (const port of ports) expect(Number.isInteger(port)).toBe(true);

  // And what landed on disk in each worktree's .env matches — and is unique.
  const onDisk = branches.map((b) => {
    const env = readFileSync(path.join(worktreesRoot, slugify(b), ".env"), "utf8");
    return Number(readEnvVar(env, "PORT"));
  });
  expect(new Set(onDisk).size).toBe(branches.length);

  // Reservations were finalized once each .env was written: nothing left behind.
  const registry = path.join(home, ".homestead", "state", slugify(repo.repoName), "reservations.json");
  const remaining = JSON.parse(readFileSync(registry, "utf8")).reservations as ReadonlyArray<unknown>;
  expect(remaining).toEqual([]);
});
