# homestead

Two worktrees of the same repo both want port 3000, and they're both reaching for the same database. homestead gives each one its own ports, its own `.env`, its own setup — opened in a [herdr](https://herdr.dev) pane.

```bash
homestead worktree my-feature
```

A branch, provisioned and open, in one command.

## An agent per issue

```bash
homestead issue 21 22 23
```

Three worktrees, three panes, a coding agent booted in each and handed its issue.

Tear one down when you're done:

```bash
homestead close 21        # keep the branch, move the issue to review
homestead complete 21     # merged — remove the worktree and branch
homestead kill 21         # discard it
```

## See everything at once

```bash
homestead ls
```

A read-only dashboard — one row per worktree, joining git, each `.env`, tracking
state, and herdr:

```
SLUG         BRANCH       PORTS              DB              AGENT     PANE   ORIGIN
auth-rework  auth-rework  WEB=3001 API=4001  hs_authrework   running   ws-7   you
issue-142    142          WEB=3002 API=4002  hs_142          done      —      [auto]
```

Every column degrades to `—` on its own if a source is missing — it never
mutates anything. The DB column reads the keys you list in `env.derivedKeys`
straight from each worktree's `.env` (it never re-runs `env.derive`).

## Someone else's PR

Pull a PR into a real worktree instead of reading a web diff:

```bash
homestead review 87       # read-only, Claude reviews it
homestead pr 87           # Claude continues it and pushes (same-repo only)
```

## Setup

```bash
bun add -g homestead
homestead init
```

`init` leaves you a `homestead.config.ts` — ports, env, setup steps. Fully typed, nothing installed:

```ts
import type { HomesteadConfig } from "./generated/homestead.config.types";

export default {
  ports: [{ key: "PORT", base: 3000 }],
  env: {
    source: ".env",
    derive: ({ slug }) => ({ DATABASE_URL: `.../${slug}` }),
  },
  setup: [{ label: "install", run: ["bun", "install"] }],
  agent: { command: ["claude"], surface: "worktree" },
} satisfies HomesteadConfig;
```

### Greet each issue differently

`agent.prompt` runs per issue, so you can change the kickoff by what the issue looks like:

```ts
agent: {
  command: ["claude"],
  surface: "worktree",
  prompt: ({ item }) =>
    item.title.startsWith("bug:")
      ? `Reproduce and fix #${item.number}: ${item.title}`
      : `Implement #${item.number}: ${item.title}`,
},
```

It goes further than this — shared services, lifecycle hooks, more agent options. The [example config](./homestead.config.example.ts) covers the rest.

## Requirements

git, a herdr session, [Bun](https://bun.sh), and an authenticated `gh` for issue and PR flows.
