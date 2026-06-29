import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer, Option } from "effect";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HerdrTest, HerdrTestHandle } from "../herdr/test.ts";
import { slugify } from "../text.ts";
import { AGENT_MARKER_FILE } from "../tracking.ts";
import type { HomesteadConfig } from "../types.ts";
import type { Repo } from "../worktree/index.ts";
import { PortAllocator } from "../worktree/ports.ts";
import { STATUS_FILE_INSTRUCTION } from "./defaults.ts";
import { AGENT_STATUS_RELPATH } from "./status.ts";
import { buildSpawnMarker, resolveSpawnPrompt, seedSpawnPrompt, spawnAgent } from "./spawn.ts";

const TestLayer = Layer.provideMerge(Layer.mergeAll(HerdrTest, PortAllocator.layer), BunServices.layer);
const noStdin = Effect.succeed("");

// --- prompt resolution -------------------------------------------------------

test("resolveSpawnPrompt joins positional words", async () => {
  const r = await Effect.runPromise(resolveSpawnPrompt(["fix", "the", "bug"], Option.none(), noStdin));
  expect(r).toBe("fix the bug");
});

test("resolveSpawnPrompt uses --prompt text (over positional)", async () => {
  const r = await Effect.runPromise(resolveSpawnPrompt(["ignored"], Option.some("flagged brief"), noStdin));
  expect(r).toBe("flagged brief");
});

test("resolveSpawnPrompt --prompt - reads (and trims) stdin", async () => {
  const r = await Effect.runPromise(
    resolveSpawnPrompt([], Option.some("-"), Effect.succeed("piped brief\n")),
  );
  expect(r).toBe("piped brief");
});

test("resolveSpawnPrompt fails with UsageError when no prompt source", async () => {
  const err = await Effect.runPromise(resolveSpawnPrompt([], Option.none(), noStdin).pipe(Effect.flip));
  expect(err._tag).toBe("UsageError");
});

test("resolveSpawnPrompt fails with UsageError on empty stdin", async () => {
  const err = await Effect.runPromise(
    resolveSpawnPrompt([], Option.some("-"), Effect.succeed("   \n")).pipe(Effect.flip),
  );
  expect(err._tag).toBe("UsageError");
});

// --- seeding + marker shape --------------------------------------------------

test("seedSpawnPrompt appends the status instruction by default", () => {
  expect(seedSpawnPrompt("brief", {})).toBe("brief" + STATUS_FILE_INSTRUCTION);
});

test("seedSpawnPrompt respects statusFile:false (no sentinel contract)", () => {
  expect(seedSpawnPrompt("brief", { statusFile: false })).toBe("brief");
});

test("buildSpawnMarker records spawn provenance", () => {
  const m = buildSpawnMarker({
    spawnedBy: "agent spawn",
    paneId: "pane-1",
    createdAt: "2026-06-29T00:00:00.000Z",
  });
  expect(m.kind).toBe("spawn");
  expect(m.spawnedBy).toBe("agent spawn");
  expect(m.paneId).toBe("pane-1");
  expect(m.statusFile).toBe(AGENT_STATUS_RELPATH);
  expect(m.createdAt).toBe("2026-06-29T00:00:00.000Z");
});

// --- spawnAgent (git-backed) -------------------------------------------------

let home: string;
let repoRoot: string;
let worktreesRoot: string;
let homeSpy: ReturnType<typeof spyOn>;

const git = (cwd: string, args: ReadonlyArray<string>) =>
  execFileSync("git", [...args], { cwd, stdio: "ignore" });

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "homestead-spawn-home-"));
  repoRoot = mkdtempSync(path.join(os.tmpdir(), "homestead-spawn-repo-"));
  worktreesRoot = mkdtempSync(path.join(os.tmpdir(), "homestead-spawn-wt-"));
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

test("spawnAgent writes the marker, seeds the literal prompt, and writes NO tracking state", async () => {
  const repo: Repo = { startCwd: repoRoot, primaryRoot: repoRoot, repoName: path.basename(repoRoot) };
  const config: HomesteadConfig = { worktreeDir: (ctx) => path.join(worktreesRoot, ctx.slug) };
  const slug = "refactor-auth";
  const prompt = "Extract the token refresh logic into its own module.";

  const sendText = await Effect.runPromise(
    Effect.gen(function* () {
      const handle = yield* HerdrTestHandle;
      yield* handle.script("pane-1", ["❯ "]);
      yield* spawnAgent({
        config,
        repo,
        slug,
        prompt,
        agent: { trustPrompt: false },
        createdAt: "2026-06-29T00:00:00.000Z",
      });
      const journal = yield* handle.journal();
      return journal.sendText;
    }).pipe(Effect.provide(TestLayer)),
  );

  // Seeded prompt is the literal brief + the status instruction — NOT the
  // issue-templated defaultAgentPrompt.
  expect(sendText.length).toBe(1);
  expect(sendText[0]!.text).toBe(prompt + STATUS_FILE_INSTRUCTION);
  expect(sendText[0]!.text).not.toContain("This is the issue you need to implement");

  // The marker sits at the slug's worktree path (the only slug → worktree index).
  const targetDir = path.join(worktreesRoot, slugify(slug));
  const marker = JSON.parse(readFileSync(path.join(targetDir, AGENT_MARKER_FILE), "utf8"));
  expect(marker.kind).toBe("spawn");
  expect(marker.spawnedBy).toBe("agent spawn");
  expect(marker.paneId).toBe("pane-1");

  // No homestead tracking state (no markStarted, no gh round-trips).
  expect(existsSync(path.join(home, ".homestead", "state"))).toBe(false);
}, 20000);
