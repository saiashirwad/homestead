# homestead

[![Built with AI assistance](https://img.shields.io/badge/built%20with-AI%20assistance-555?style=flat-square)]()

Two worktrees of the same repo shouldn't share a database or fight over port 3000.

homestead gives each one its own slice — ports, `.env`, setup — and opens it in [herdr](https://herdr.dev). Point it at GitHub issues and you get a worktree and coding agent per issue, side by side. For each issue, homestead boots the agent, waits for its REPL, and types a kickoff prompt once — then you drive the session from there.

```bash
homestead worktree my-feature     # branch, provision, open
homestead issue 21 22 23          # same, plus an agent in each pane
homestead close 21                # tear down, keep the branch, issue → review
homestead complete 21             # mark issue completed on GitHub, remove branch
homestead kill my-feature         # tear down everything
```

## Install

```bash
bun add -g homestead
```

Requires [Bun](https://bun.sh). One-off: `bunx homestead worktree my-feature`

## First run

From your repo root, inside a herdr session:

```bash
homestead init
```

Edit `homestead.config.ts` — ports, env, setup steps. Then:

```bash
homestead worktree my-feature
# or
homestead issue 42
```

Need a fuller starting point? Copy from [`homestead.config.example.ts`](./homestead.config.example.ts).

## Config sketch

```ts
import { defineConfig } from "homestead";

export default defineConfig({
  ports: [{ key: "PORT", base: 3000 }],
  env: {
    source: ".env",
    derive: ({ slug, env }) => ({
      DATABASE_URL: `.../${slug}`,  // per-worktree db name
    }),
  },
  setup: [{ label: "install", run: ["bun", "install"] }],
  agent: { command: ["claude"], surface: "worktree" },
});
```

Re-running on an existing worktree is safe — it reuses the same ports.

## Agent kickoff prompt

`homestead issue` types one kickoff message into each freshly-booted agent. homestead picks a sensible default from the issue — you don't need to configure it.

To override, add an optional `prompt` callback to `agent`:

```ts
agent: {
  command: ["claude"],
  surface: "worktree",
  prompt: (ctx) =>
    `Work GitHub issue #${ctx.item.number}: "${ctx.item.title}"\n${ctx.item.url}\n\nStart by reading the issue and proposing a plan.`,
},
```

The callback receives `ctx.item` (number, URL, title), `ctx.branch`, `ctx.worktreeDir`, `ctx.repoName`, and `ctx.args`. Other agent options: `readyMarker`, `readyTimeoutMs`, `trustPrompt`. See [`homestead.config.example.ts`](./homestead.config.example.ts).

## Commands

| | |
| --- | --- |
| `worktree <name>` | new worktree — ports, env, setup |
| `issue <n>...` | same, plus an agent in each pane |
| `close <n>` | tear down, keep the branch |
| `kill <name>` | tear down everything |

## Prerequisites

| | `worktree` | `issue` |
| --- | --- | --- |
| git | ✓ | ✓ |
| herdr session | ✓ | ✓ |
| `gh` (authenticated) | | ✓ |
