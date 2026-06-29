import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer, Option } from "effect";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HerdrError } from "../herdr/errors.ts";
import { HerdrTest, HerdrTestHandle } from "../herdr/test.ts";
import { slugify } from "../text.ts";
import { AGENT_MARKER_FILE } from "../tracking.ts";
import type { HomesteadConfig } from "../types.ts";
import { resolveSpawnPrompt } from "./spawn.ts";
import { promptAgent } from "./prompt.ts";
import { AGENT_STATUS_RELPATH } from "./status.ts";

const TestLayer = Layer.provideMerge(HerdrTest, BunServices.layer);
const noStdin = Effect.succeed("");

// --- prompt resolution (reuses agent spawn's resolver via the command label) --

test("resolveSpawnPrompt('agent prompt') joins positional words", async () => {
  const r = await Effect.runPromise(
    resolveSpawnPrompt(["fix", "the", "test"], Option.none(), noStdin, "agent prompt"),
  );
  expect(r).toBe("fix the test");
});

test("resolveSpawnPrompt('agent prompt') prefers --prompt over positional", async () => {
  const r = await Effect.runPromise(
    resolveSpawnPrompt(["ignored"], Option.some("now open the PR"), noStdin, "agent prompt"),
  );
  expect(r).toBe("now open the PR");
});

test("resolveSpawnPrompt('agent prompt') --prompt - reads + trims stdin", async () => {
  const r = await Effect.runPromise(
    resolveSpawnPrompt([], Option.some("-"), Effect.succeed("piped follow-up\n"), "agent prompt"),
  );
  expect(r).toBe("piped follow-up");
});

test("resolveSpawnPrompt('agent prompt') names the command in its error", async () => {
  const err = await Effect.runPromise(
    resolveSpawnPrompt([], Option.none(), noStdin, "agent prompt").pipe(Effect.flip),
  );
  expect(err._tag).toBe("UsageError");
  expect(err.message).toContain("agent prompt");
});

// --- promptAgent -------------------------------------------------------------

const REPO = "myrepo";
const SLUG = "refactor-auth";
const PANE = "pane-1";

let home: string;
let worktreesRoot: string;
let homeSpy: ReturnType<typeof spyOn>;

const config = (): HomesteadConfig => ({ worktreeDir: (ctx) => path.join(worktreesRoot, ctx.slug) });
const targetDir = () => path.join(worktreesRoot, slugify(SLUG));

const writeMarker = (paneId: string | undefined) => {
  const dir = targetDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, AGENT_MARKER_FILE),
    JSON.stringify({
      kind: "spawn",
      spawnedBy: "agent spawn",
      ...(paneId !== undefined ? { paneId } : {}),
      statusFile: AGENT_STATUS_RELPATH,
      createdAt: "2026-06-29T00:00:00.000Z",
    }),
  );
};

const statusPath = () => path.join(targetDir(), AGENT_STATUS_RELPATH);

const writeStatus = (body: string) => {
  mkdirSync(path.join(targetDir(), ".homestead"), { recursive: true });
  writeFileSync(statusPath(), body);
};

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "homestead-prompt-home-"));
  worktreesRoot = mkdtempSync(path.join(os.tmpdir(), "homestead-prompt-wt-"));
  homeSpy = spyOn(os, "homedir").mockReturnValue(home);
});

afterEach(() => {
  homeSpy.mockRestore();
  for (const d of [home, worktreesRoot]) rmSync(d, { recursive: true, force: true });
});

test("resolves slug → recorded paneId and sends text + Enter", async () => {
  writeMarker(PANE);
  const journal = await Effect.runPromise(
    Effect.gen(function* () {
      const handle = yield* HerdrTestHandle;
      yield* promptAgent({ repoName: REPO, slug: SLUG, text: "you missed a test", config: config() });
      return yield* handle.journal();
    }).pipe(Effect.provide(TestLayer)),
  );
  expect(journal.sendText).toEqual([{ paneId: PANE, text: "you missed a test" }]);
  expect(journal.sendKeys).toEqual([{ paneId: PANE, keys: ["Enter"] }]);
});

test("unknown slug fails with a UsageError naming the slug (not a herdr error)", async () => {
  // No marker written.
  const err = await Effect.runPromise(
    promptAgent({ repoName: REPO, slug: SLUG, text: "hi", config: config() })
      .pipe(Effect.flip, Effect.provide(TestLayer)),
  );
  expect(err._tag).toBe("UsageError");
  expect((err as { message: string }).message).toContain(SLUG);
});

test("marker without a paneId fails with a UsageError", async () => {
  writeMarker(undefined);
  const err = await Effect.runPromise(
    promptAgent({ repoName: REPO, slug: SLUG, text: "hi", config: config() })
      .pipe(Effect.flip, Effect.provide(TestLayer)),
  );
  expect(err._tag).toBe("UsageError");
  expect((err as { message: string }).message).toContain("paneId");
});

test("a dead pane fails 'no longer running' AND leaves the prior status intact (probe before clear)", async () => {
  writeMarker(PANE);
  writeStatus(`{"status":"done","summary":"turn 1"}`);
  const err = await Effect.runPromise(
    Effect.gen(function* () {
      const handle = yield* HerdrTestHandle;
      yield* handle.failRead(PANE, new HerdrError({ op: "pane.read", cause: "gone" }));
      const e = yield* promptAgent({ repoName: REPO, slug: SLUG, text: "hi", config: config() }).pipe(
        Effect.flip,
      );
      const journal = yield* handle.journal();
      return { e, journal };
    }).pipe(Effect.provide(TestLayer)),
  );
  expect(err.e._tag).toBe("UsageError");
  expect((err.e as { message: string }).message).toContain("no longer running");
  // Probe ran before clear: status untouched, nothing sent.
  expect(existsSync(statusPath())).toBe(true);
  expect(err.journal.sendText).toEqual([]);
});

test("success path clears the prior status before sending", async () => {
  writeMarker(PANE);
  writeStatus(`{"status":"done","summary":"turn 1"}`);
  const journal = await Effect.runPromise(
    Effect.gen(function* () {
      const handle = yield* HerdrTestHandle;
      yield* promptAgent({ repoName: REPO, slug: SLUG, text: "next turn", config: config() });
      return yield* handle.journal();
    }).pipe(Effect.provide(TestLayer)),
  );
  expect(existsSync(statusPath())).toBe(false);
  expect(journal.sendText).toEqual([{ paneId: PANE, text: "next turn" }]);
});

test("status is cleared before the first sendText (ordering): send fails yet status is already gone", async () => {
  writeMarker(PANE);
  writeStatus(`{"status":"done","summary":"turn 1"}`);
  const err = await Effect.runPromise(
    Effect.gen(function* () {
      const handle = yield* HerdrTestHandle;
      yield* handle.failSendText(PANE, new HerdrError({ op: "pane.send-text", cause: "boom" }));
      return yield* promptAgent({ repoName: REPO, slug: SLUG, text: "next turn", config: config() }).pipe(
        Effect.flip,
      );
    }).pipe(Effect.provide(TestLayer)),
  );
  expect(err._tag).toBe("HerdrError");
  // The send blew up, but clear had already run — proving clear precedes send.
  expect(existsSync(statusPath())).toBe(false);
});
