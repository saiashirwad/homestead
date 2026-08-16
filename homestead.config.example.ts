import type { HomesteadConfig } from "homestead";

const withDbName = (raw: string, dbName: string): string => {
  const queryIndex = raw.indexOf("?");
  const base = queryIndex === -1 ? raw : raw.slice(0, queryIndex);
  const query = queryIndex === -1 ? "" : raw.slice(queryIndex);
  const slash = base.lastIndexOf("/");
  return `${base.slice(0, slash + 1)}${dbName}${query}`;
};

const DEFAULT_DB_URL = "postgres://postgres:postgres@localhost:5432/myapp";

export default {
  // Where new worktrees land (default: ~/worktrees/<repo>/<slug>).
  worktreeDir: ({ repoName, slug }) => `${process.env.HOME}/worktrees/${repoName}/${slug}`,

  // Per-worktree ports, allocated by scanning sibling worktrees' .env files.
  ports: [
    { key: "PORT", base: 3000 },
    { key: "CLIENT_PORT", base: 5173 },
  ],

  env: {
    source: ".env",
    fallback: ".env.example",
    derive: ({ slug, env }) => ({
      DATABASE_URL: withDbName(env("DATABASE_URL") ?? DEFAULT_DB_URL, `myapp_${slug}`),
    }),
  },

  // Ensure dependencies like Postgres are up before provisioning.
  services: [
    {
      name: "postgres",
      host: "localhost",
      port: 5432,
      start: ["docker", "compose", "up", "-d", "db"],
    },
  ],

  // Setup commands executed in the worktree root
  setup: [
    { label: "install", run: ["bun", "install"] },
    { label: "db:migrate", run: ["bun", "run", "db:migrate"], injectEnv: ["DATABASE_URL"] },
  ],

  // Teardown commands executed before removing the worktree
  teardown: [
    { label: "db:drop", run: ["bun", "run", "db:drop"] },
  ],
} satisfies HomesteadConfig;
