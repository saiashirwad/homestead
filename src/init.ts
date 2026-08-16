import { Console, Effect, FileSystem, Path } from "effect";

const STARTER_CONFIG = `import type { HomesteadConfig } from "homestead";

export default {
  // Ports to dynamically allocate starting from a base
  ports: [
    { key: "PORT", base: 3000 },
  ],

  // Environment file derivation
  env: {
    source: ".env.example",
    derive: ({ slug }) => ({
      DATABASE_URL: \`postgres://localhost:5432/app_\${slug}\`,
    }),
  },

  // Setup commands run after creating the worktree
  setup: [
    { label: "install", run: ["bun", "install"] },
  ],

  // Teardown commands run before removing the worktree
  teardown: [],
} satisfies HomesteadConfig;
`;

const ensureHomesteadGitignored = Effect.fnUntraced(function* (primaryRoot: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const ENTRY = ".homestead/";
  const gitignorePath = path.join(primaryRoot, ".gitignore");

  const exists = yield* fs.exists(gitignorePath).pipe(Effect.orDie);
  const current = exists ? yield* fs.readFileString(gitignorePath).pipe(Effect.orDie) : "";

  const alreadyIgnored = current
    .split("\n")
    .map((line) => line.trim())
    .some((line) => line === ENTRY || line === ".homestead");
  if (alreadyIgnored) {
    yield* Console.log(`  • ${ENTRY} already gitignored — leaving it`);
    return;
  }

  const trailingNewline = current.length === 0 || current.endsWith("\n");
  const addition = (trailingNewline ? "" : "\n") + `# homestead runtime state\n${ENTRY}\n`;
  yield* fs.writeFileString(gitignorePath, current + addition).pipe(Effect.orDie);
  yield* Console.log(`  ✓ added ${ENTRY} to .gitignore`);
});

export const initRepo = Effect.fnUntraced(function* (primaryRoot: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  yield* Console.log(`\n▸ Initializing homestead in ${primaryRoot}`);

  const targetConfig = path.join(primaryRoot, "homestead.config.ts");
  const exists = yield* fs.exists(targetConfig).pipe(Effect.orDie);
  if (exists) {
    yield* Console.log(`  • homestead.config.ts already exists — leaving it`);
  } else {
    yield* fs.writeFileString(targetConfig, STARTER_CONFIG).pipe(Effect.orDie);
    yield* Console.log(`  ✓ wrote homestead.config.ts`);
  }

  yield* ensureHomesteadGitignored(primaryRoot);

  yield* Console.log(`\n✅ Ready. Start daemon with \`homestead server\` or create worktrees with \`homestead create <name>\`\n`);
});
