// Example homestead.config.ts — copy to `homestead.config.ts` at your repo root and adapt.
//
// This is a typical setup for a web app with a server + client and a shared
// Postgres in docker: each worktree gets its own ports, its own logical database,
// and a copied .env, then runs install/migrate/seed. `homestead issue <issue>...`
// opens a herdr surface per issue, boots an interactive agent in it, and types a
// kickoff prompt — you drive each session by hand from there.
//
// Run from the repo root (inside a herdr session):
//   homestead worktree my-feature
//   homestead issue 21 22 23
//   homestead close 21          # finalize: keep the branch, issue → review
//   homestead kill my-feature

// Types come from the generated `homestead.config.types.d.ts` that `homestead
// init` drops next to this file — so a consumer repo needs nothing installed.
import type { HomesteadConfig } from "./generated/homestead.config.types";

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

export default {
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
    {
      name: "postgres",
      host: "localhost",
      port: 5432,
      start: ["docker", "compose", "up", "-d", "db"],
    },
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
  // tracking: homestead adds them at launch and reverses them on `homestead kill`.
  // `close` instead moves `agent:wip` -> reviewLabel (work done, handed off).
  // Omit label/assign/comment to never touch issues.
  issues: {
    branch: (item) => String(item.number),
    label: "agent:wip", // added on launch (auto-created), removed on kill
    assign: true, // assign the gh user (@me) on launch, unassign on kill
    comment: true, // post a 🤖 start comment + 🛑 stop comment (or a function for custom text)
    reviewLabel: "agent:review", // `close` moves agent:wip here (default)
    closeComment: ({ branch, env, host }) => `${branch} was closed`,
  },

  // homestead boots an interactive agent in a herdr pane per issue, waits for its
  // REPL, and types a kickoff prompt once — then steps away. You drive
  // the session by hand. Override `prompt` only if you want a custom kickoff.
  agent: {
    command: ["claude"],
    surface: "worktree", // nest each agent under the repo's workspace in herdr
    // readyMarker: "❯",                    // the REPL-ready glyph to poll for (default)
    // readyTimeoutMs: 30000,               // how long to wait for the REPL
    // trustPrompt: { marker: "trust this folder", confirm: ["Enter"] },  // Claude's default
    // statusFile: true,                    // append "write .homestead/agent-status.json when you
    //                                      // finish" to the kickoff prompt so `homestead agent wait`
    //                                      // can block on the agent (default true; set false to opt out)
    // prompt: (ctx) =>
    //   `Work GitHub issue #${ctx.item.number} (${ctx.item.url}). Read the issue and propose a plan.`,
  },

  // `homestead review <pr>` / `homestead pr <pr>` pull a PR into a worktree and
  // seed Claude with a kickoff prompt (review = summarize + run checks + flag
  // risks; pr = continue the work). All optional — defaults ship.
  pr: {
    checks: "bun run check", // named in the kickoff prompt; omit to let Claude infer
    // reviewPrompt: ({ pr, checks }) => `Review PR #${pr.number} (${pr.url}).`,
    // workPrompt: ({ pr }) => `Continue PR #${pr.number} (${pr.url}).`,
  },
} satisfies HomesteadConfig;
