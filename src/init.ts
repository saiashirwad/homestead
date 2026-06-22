import { Console, Effect, FileSystem, Path } from "effect";
import { loadConfig } from "./config.ts";
import { resolveLoopSettings } from "./loop.ts";
import { writeSkills } from "./skills.ts";

// `githog init` — one-time local setup for a repo (CONTEXT.md → "Skills"). Writes
// the agent-loop skills into .claude/skills, git-ignores the per-issue task file,
// and scaffolds a starter githog.config.ts if none exists. Run once and COMMIT the
// result: because the skills live on the default branch, every issue worktree
// branches from them already present — so they never appear in an issue branch's
// diff (the old per-worktree seeding committed them into every PR). The task file
// is ignored, so it never lands in a commit either. Idempotent: existing files are
// left untouched.

const STARTER_CONFIG = `import { defineConfig } from "githog";

export default defineConfig({
  // Per-worktree ports (omit if this repo isn't a server):
  // ports: [{ key: "PORT", base: 3000 }],

  // Ordered provisioning commands run in each new worktree:
  setup: [{ label: "install", run: ["bun", "install"] }],

  // Opt-in GitHub issue tracking, reversed on \`githog kill\`:
  issues: { label: "agent:wip", assign: true, comment: true },

  // The agent loop spawns headless \`claude -p\` per iteration;
  // --dangerously-skip-permissions lets it run gh/git + edit files unattended.
  agent: { command: ["claude", "--dangerously-skip-permissions"], surface: "worktree" },

  // \`githog listen\` drains issues labelled with this trigger:
  listen: { label: "agent:ready", intervalSeconds: 10, maxConcurrent: 3 },
});
`;

// Append a line to .gitignore if that exact pattern isn't already present (creating
// the file if absent). Returns whether it wrote anything.
const ensureGitignore = Effect.fn("githog/init/gitignore")(function* (root: string, pattern: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(root, ".gitignore");
  const existing = yield* fs.readFileString(file).pipe(Effect.catchCause(() => Effect.succeed("")));
  const lines = existing.split("\n").map((l) => l.trim());
  if (lines.includes(pattern)) return false;
  const prefix = existing === "" ? "" : existing.endsWith("\n") ? "" : "\n";
  yield* fs.writeFileString(file, `${existing}${prefix}${pattern}\n`);
  return true;
});

export const initRepo = Effect.fn("githog/init")(function* (primaryRoot: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  yield* Console.log(`\n▸ githog init in ${primaryRoot}`);

  // 1. config — scaffold a starter only if the repo has none.
  const config = yield* loadConfig(primaryRoot).pipe(Effect.catchCause(() => Effect.succeed(undefined)));
  const configPath = path.join(primaryRoot, "githog.config.ts");
  const hasConfig = yield* fs.exists(configPath).pipe(Effect.catchCause(() => Effect.succeed(false)));
  if (hasConfig) {
    yield* Console.log(`  • githog.config.ts already exists — leaving it`);
  } else {
    yield* fs.writeFileString(configPath, STARTER_CONFIG);
    yield* Console.log(`  ✓ wrote starter githog.config.ts`);
  }

  // 2. skills — write the bundled loop skills (using the repo's loop settings if it
  //    has a config, else defaults), skipping any the repo already customised.
  const loop = resolveLoopSettings(config?.agent?.loop);
  yield* writeSkills(primaryRoot, loop);

  // 3. ignore the per-issue task file so it never lands in an issue branch's commits.
  const taskPattern = `/${loop.taskFile}`;
  const wrote = yield* ensureGitignore(primaryRoot, taskPattern);
  yield* Console.log(wrote ? `  ✓ added ${taskPattern} to .gitignore` : `  • ${taskPattern} already in .gitignore`);

  yield* Console.log(
    `\n✅ githog init done. Next:\n` +
      `   git add -A && git commit -m "githog: init"   # track the skills + .gitignore on your default branch\n` +
      `   githog listen                                 # (in a herdr pane) drain agent:ready issues`,
  );
});
