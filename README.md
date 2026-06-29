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

Fanning out interdependent work in waves? Stack a later wave on an integration
branch so it sees the earlier wave's code without merging to the default branch
first:

```bash
homestead issue 24 25 --from integration
```

`--from` overrides the default branch per-run; set `issues.base` in the config to
make an integration base the persistent default.

Tear one down when you're done:

```bash
homestead close 21        # keep the branch, move the issue to review
homestead complete 21     # merged — remove the worktree and branch
homestead kill 21         # discard it
```

## Land a finished branch

```bash
homestead land 21              # merge 21 → default branch, regenerate, verify, keep only if green
homestead land 21 --complete  # …and on green, run `homestead complete` for you
```

Integrating a finished branch by hand is the same chore every time: stash your
WIP, merge, regenerate generated files (a text merge of those is wrong — they
must be rebuilt), run checks, and only commit if it's green. `land` owns that:

1. Auto-stashes the primary checkout's dirty WIP, then `git merge --no-ff --no-commit`.
2. Regenerates generated artifacts (default `bun run gen:config-types`). A merge
   conflict confined to your generated files is resolved by regenerating them,
   not by failing.
3. Runs the verify gate (default `bun run check`).
4. **Green** → commits the merge. **Red** → rolls the whole merge back. Either
   way your stashed WIP comes back.

Run it from the primary checkout while it's on the default branch. Configure the
commands under `land` (see below). Pass several branches to land them in order.

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
