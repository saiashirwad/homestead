// Example githog.config.ts — copy to `githog.config.ts` at your repo root and adapt.
//
// This is a typical setup for a web app with a server + client and a shared
// Postgres in docker: each worktree gets its own ports, its own logical database,
// and a copied .env, then runs install/migrate/seed. `implement-issues` opens a
// herdr surface per issue and tells the agent to `/implement` it.
//
// Run from the repo root (inside a herdr session for implement-issues):
//   githog setup --create my-feature
//   githog implement-issues 21 22 23
//   githog kill my-feature

import { defineConfig } from "githog";

// Swap the db-name segment of a Postgres DSN, preserving creds/host/?query —
// e.g. ".../myapp" + "myapp_my_feature" -> ".../myapp_my_feature".
const withDbName = (raw: string, dbName: string): string => {
  const queryIndex = raw.indexOf("?");
  const base = queryIndex === -1 ? raw : raw.slice(0, queryIndex);
  const query = queryIndex === -1 ? "" : raw.slice(queryIndex);
  const slash = base.lastIndexOf("/");
  return `${base.slice(0, slash + 1)}${dbName}${query}`;
};

const DEFAULT_DB_URL = "postgres://postgres:postgres@localhost:5432/myapp";

export default defineConfig({
  // Where new worktrees land (default: ~/worktrees/<repo>/<slug>).
  worktreeDir: ({ repoName, slug }) => `${process.env.HOME}/worktrees/${repoName}/${slug}`,

  // Per-worktree ports, allocated by scanning sibling worktrees' .env files.
  ports: [
    { key: "PORT", base: 3000 },
    { key: "CLIENT_PORT", base: 5173 },
  ],

  env: {
    source: ".env", // copied from the primary checkout (the real dev values)
    fallback: ".env.example",
    // Give each worktree its own logical database on the shared Postgres.
    derive: ({ slug, env }) => ({
      DATABASE_URL: withDbName(env("DATABASE_URL") ?? DEFAULT_DB_URL, `myapp_${slug}`),
    }),
  },

  // Ensure the shared docker Postgres is up before provisioning.
  services: [
    { name: "postgres", host: "localhost", port: 5432, start: ["docker", "compose", "up", "-d", "db"] },
  ],

  // Ordered setup commands. DATABASE_URL is injected so it wins over any value a
  // script would otherwise load from a checked-in --env-file. `seed` is non-fatal:
  // a blank .env makes it fail, but the schema is ready regardless.
  setup: [
    { label: "install", run: ["bun", "install"] },
    { label: "db:migrate", run: ["bun", "run", "db:migrate"], injectEnv: ["DATABASE_URL"] },
    { label: "db:seed", run: ["bun", "run", "db:seed"], injectEnv: ["DATABASE_URL"], fatal: false },
  ],

  // branch == issue number. The label/assign/comment fields are opt-in issue
  // tracking: githog adds them when a loop starts and removes them on `githog
  // kill`. `agent:wip` is also the listen concurrency gauge; the agent loop swaps
  // it to reviewLabel (completed, PR open) or blockedLabel (stuck) when it ends —
  // both free a listen slot. Omit label/assign/comment to never touch issues.
  issues: {
    branch: (item) => String(item.number),
    label: "agent:wip", // added on start (auto-created), removed on kill
    assign: true, // assign the gh user (@me) on start, unassign on kill
    comment: true, // post a 🤖 start comment + 🛑 stop comment (or a function for custom text)
    reviewLabel: "agent:review", // loop completed: PR opened, awaiting human (default)
    blockedLabel: "agent:blocked", // loop stuck/blocked: needs a human (default)
  },

  // The agent runs as a agent loop (ADR-0001): githog runs a one-shot plan pass
  // that decomposes the issue into TASKS.md, then re-invokes the agent headlessly
  // (`claude -p`) with a clean context each iteration until it emits the
  // completion sentinel (→ PR + agent:review) or hits the cap / emits `<blocked>`
  // (→ agent:blocked). The loop runs inside the herdr pane so you can watch it.
  agent: {
    // Add permission flags here for unattended runs, e.g.
    // ["claude", "--dangerously-skip-permissions"].
    command: ["claude"],
    surface: "worktree", // nest each agent under the repo's workspace in herdr
    loop: {
      maxIterations: 25, // backstop cap before the loop gives up -> agent:blocked
      // completionSentinel / blockedTag / planSkill / implementSkill / taskFile
      // all have sensible defaults; override only if you need to. The
      // githog-plan / githog-implement skills are seeded into each worktree.
    },
  },

  // `githog listen` — poll the repo and auto-implement any open issue labelled
  // with `label`. githog claims it (swaps the label to issues.label, "agent:wip")
  // and runs the same flow as implement-issues, up to maxConcurrent at a time.
  listen: {
    label: "agent:ready",
    intervalSeconds: 30,
    maxConcurrent: 3,
  },
});
