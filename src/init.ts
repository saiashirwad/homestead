import { Console, Effect, FileSystem, Path } from "effect";

const STARTER_CONFIG = `import { defineConfig } from "homestead";

export default defineConfig({
  // Per-worktree ports (omit if this repo isn't a server):
  // ports: [{ key: "PORT", base: 3000 }],

  setup: [{ label: "install", run: ["bun", "install"] }],

  issues: { label: "agent:wip", assign: true, comment: true },

  agent: {
    command: ["claude"],
    surface: "worktree",
  },
});
`;

export const initRepo = Effect.fn("homestead/init")(function* (primaryRoot: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  yield* Console.log(`\n▸ homestead init in ${primaryRoot}`);

  const configPath = path.join(primaryRoot, "homestead.config.ts");
  const hasConfig = yield* fs.exists(configPath).pipe(Effect.orDie);
  if (hasConfig) {
    yield* Console.log(`  • homestead.config.ts already exists — leaving it`);
  } else {
    yield* fs.writeFileString(configPath, STARTER_CONFIG).pipe(Effect.orDie);
    yield* Console.log(`  ✓ wrote starter homestead.config.ts`);
  }

  yield* Console.log(`\n✅ homestead init done — edit homestead.config.ts, then: homestead issue <issue>`);
});
