import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { slugify } from "../text.ts";
import { AGENT_MARKER_FILE } from "../tracking.ts";
import type { HomesteadConfig } from "../types.ts";
import { resultForSlug } from "./result.ts";
import { AGENT_STATUS_RELPATH } from "./status.ts";

const REPO = "myrepo";
const SLUG = "refactor-auth";

let home: string;
let worktreesRoot: string;
let homeSpy: ReturnType<typeof spyOn>;

const config = (): HomesteadConfig => ({ worktreeDir: (ctx) => path.join(worktreesRoot, ctx.slug) });
const targetDir = () => path.join(worktreesRoot, slugify(SLUG));

const writeMarker = () => {
  const dir = targetDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, AGENT_MARKER_FILE),
    JSON.stringify({ kind: "spawn", spawnedBy: "agent spawn", createdAt: "2026-06-29T00:00:00.000Z" }),
  );
};

const writeStatus = (body: string) => {
  const dir = path.join(targetDir(), ".homestead");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(targetDir(), AGENT_STATUS_RELPATH), body);
};

const run = (slug: string) =>
  Effect.runPromise(resultForSlug(REPO, slug, config()).pipe(Effect.provide(BunServices.layer)));

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "homestead-result-home-"));
  worktreesRoot = mkdtempSync(path.join(os.tmpdir(), "homestead-result-wt-"));
  homeSpy = spyOn(os, "homedir").mockReturnValue(home);
});

afterEach(() => {
  homeSpy.mockRestore();
  for (const d of [home, worktreesRoot]) rmSync(d, { recursive: true, force: true });
});

test("passes the sentinel through verbatim when present", async () => {
  writeMarker();
  const body = `{"status":"done","summary":"Extracted refresh into token/refresh.ts."}`;
  writeStatus(body + "\n");
  const result = await run(SLUG);
  expect(result._tag).toBe("status");
  if (result._tag === "status") expect(result.body).toBe(body);
});

test("reports pending when the worktree exists but the sentinel is absent", async () => {
  writeMarker();
  const result = await run(SLUG);
  expect(result._tag).toBe("pending");
});

test("reports unknown when there is no spawned worktree (no marker)", async () => {
  const result = await run(SLUG);
  expect(result._tag).toBe("unknown");
});
