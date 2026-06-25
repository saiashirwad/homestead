# homestead

[![Built with AI assistance](https://img.shields.io/badge/built%20with-AI%20assistance-555?style=flat-square)]()

Two worktrees of the same repo shouldn't share a database or fight over port 3000.

homestead gives each one its own slice — ports, `.env`, setup — and opens it in [herdr](https://herdr.dev). Point it at GitHub issues and you get a worktree and coding agent per issue, side by side. For each issue, homestead boots the agent, waits for its REPL, and types a kickoff prompt once — then you drive the session from there.

```bash
homestead worktree my-feature     # branch, provision, open
homestead issue 21 22 23          # same, plus an agent in each pane
homestead review 87               # open PR #87 in a worktree; Claude reviews it
homestead pr 87                   # open PR #87 in a worktree; Claude continues it
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

`homestead init` writes `generated/homestead.config.types.d.ts` into your repo, so the
config is fully typed with **nothing installed** — no `homestead` dependency, no
`effect`, no bloat. Just a typed default export:

```ts
import type { HomesteadConfig } from "./generated/homestead.config.types";

export default {
  ports: [{ key: "PORT", base: 3000 }],
  env: {
    source: ".env",
    derive: ({ slug, env }) => ({
      DATABASE_URL: `.../${slug}`,  // per-worktree db name
    }),
  },
  setup: [{ label: "install", run: ["bun", "install"] }],
  agent: { command: ["claude"], surface: "worktree" },
} satisfies HomesteadConfig;
```

The generated types track the homestead version you ran `init` with — re-run
`homestead init` after upgrading to refresh them.

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

## Agent boot markers

Before homestead types the kickoff prompt, it boots the agent in a herdr pane and **waits for `readyMarker`** — a substring it expects to see once the REPL is ready. If the marker is wrong, the agent boots fine but **silently never receives its prompt** (it just sits at an idle REPL). When that happens the wait eventually hits `readyTimeoutMs` and homestead prints the marker it was waiting for plus the agent's last output, so you can spot the mismatch.

Known-good starting points:

| `command` | `readyMarker` | `trustPrompt` |
| --- | --- | --- |
| `["claude"]` | `❯` (default) | `{ marker: "trust this folder", confirm: ["Enter"] }` (applied automatically for `claude`) |
| `["codex"]` | confirm against your version — see below | none by default |
| `["aider"]` | confirm against your version — see below | none by default |

Only `claude` ships with defaults. For any other agent, **find your marker** by booting it once in a herdr pane and looking at the glyph/text its prompt settles on (e.g. the input-prompt character), then set `readyMarker` to a stable, unique substring of that line.

Notes:

- **`readyRegex: true`** — escape hatch. Treat `readyMarker` as a JS regex instead of a literal substring. Use it when the prompt line varies (e.g. `readyMarker: "❯|›", readyRegex: true`) or carries changing text around a fixed token.
- **`readyTimeoutMs`** — how long to wait for the marker (default `30000`). Bump it for slow first boots (cold installs, model downloads, big repos); lower it for fast feedback while you dial in a marker.
- **`trustPrompt: false`** — disables the trust-folder gate entirely (e.g. an agent that doesn't prompt, or a pre-trusted dir). Set `{ marker, confirm }` to teach homestead a non-Claude trust prompt.

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
