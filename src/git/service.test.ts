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
