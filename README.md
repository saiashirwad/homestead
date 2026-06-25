# homestead

[![Built with AI assistance](https://img.shields.io/badge/built%20with-AI%20assistance-555?style=flat-square)]()

Two worktrees of the same repo shouldn't share a database or fight over port 3000.

homestead gives each one its own slice — ports, `.env`, setup — and opens it in [herdr](https://herdr.dev). Point it at GitHub issues and you get a worktree and coding agent per issue, side by side. For each issue, homestead boots the agent, waits for its REPL, and types a kickoff prompt once — then you drive the session from there.

```bash
homestead worktree my-feature     # branch, provision, open
homestead issue 21 22 23          # same, plus an agent in each pane
homestead review 87               # open PR #87 in a worktree; Claude reviews it (read-only)
homestead pr 87                   # open PR #87 in a worktree; Claude continues it (same-repo only)
homestead close 21                # tear down, keep the branch, issue → review
homestead complete 21             # mark issue completed on GitHub, remove branch (local + remote)
homestead kill my-feature         # tear down everything, reverse issue signals
```

`issue`, `close`, `complete`, and `kill` accept a branch name, an issue number, or a GitHub issue URL.

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

`init` scaffolds a starter `homestead.config.ts` (only if one doesn't exist), writes the
generated types to `generated/homestead.config.types.d.ts`, and installs homestead's
bundled Claude Code skills into `.claude/skills/`. Edit `homestead.config.ts` — ports, env, setup steps. Then:

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

## Shared services

Some dependencies — a database, a Redis instance — are shared across worktrees rather than
spun up per worktree. List them under `services`; homestead probes each one's TCP port during
provisioning and, if it's not reachable, runs its `start` command and waits for it to come up.

```ts
services: [
  {
    name: "postgres",
    host: "127.0.0.1",
    port: 5432,
    start: ["docker", "compose", "up", "-d", "db"],  // optional; run if port is dead
    timeoutMs: 15_000,                                 // optional; wait window (default 15s)
  },
],
```

`start` and `timeoutMs` are optional — omit `start` to only probe (and fail provisioning if the
service is down).

## Configuration reference

Most config fields are static values. Several accept **callbacks** that homestead resolves at the right lifecycle stage. Callbacks receive a unified **`HomesteadContext`** (plus stage-specific extras where noted).

### `HomesteadContext`

Every callback shares this base shape:

| Field | Type | Notes |
| --- | --- | --- |
| `repoName` | `string` | Slugified repo name |
| `slug` | `string` | Worktree slug (often derived from branch) |
| `branch` | `string` | Git branch name |
| `worktreeDir` | `string` | Absolute path to the worktree |
| `item` | `WorkItem?` | Present on issue flows (`number`, `url`, `title`) |
| `pr` | `PrView?` | Present on PR flows |
| `env` | `(key) => string \| undefined` | Read env vars from the worktree's `.env` source |

**Extensions** used by specific callbacks:

- **`WorktreeContext`** — `HomesteadContext & { targetDir, primaryRoot }` — used by `env.derive` and `afterSetup`
- **`AgentPromptContext`** — `HomesteadContext & { args }` — used by `agent.prompt`
- **`TrackingContext`** — `HomesteadContext & { host }` — used by `issues.comment`
- **`SurfaceCtx`** — `HomesteadContext & { kind: "issue" \| "pr" }` — used by `agent.surfaceLabel`

**Special cases:**

- Inside the **`worktreeDir`** callback, `ctx.worktreeDir` is always `""` — you are defining the path, not reading it.
- At **teardown hooks** (`beforeTeardown`, `afterTeardown`), `ctx.worktreeDir` is `""` and `ctx.env()` always returns `undefined`.

### Lifecycle hooks

Hooks return `Effect.Effect<void, never, HomesteadServices>` — import `Effect` from `effect` in your config when using them.

| Hook | When | Extra fields |
| --- | --- | --- |
| `afterSetup` | After provisioning finishes (env written, setup steps run) | `{ plan: Plan }` on `WorktreeContext` |
| `afterLaunch` | After agent pane is created and kickoff prompt typed | `{ paneId: string }` |
| `beforeTeardown` | Before worktree removal (`kill`, `close`, `complete`) | `{ verb, tracked: boolean }` |
| `afterTeardown` | After teardown completes | `{ verb, reviewLabel? }` — `reviewLabel` only on `close` |

```ts
import { Effect } from "effect";
import type { HomesteadConfig } from "./generated/homestead.config.types";

export default {
  afterLaunch: (ctx) =>
    Effect.sync(() => console.log(`Agent ready in pane ${ctx.paneId} on ${ctx.branch}`)),
  beforeTeardown: (ctx) =>
    ctx.tracked ? Effect.sync(() => console.log(`Tearing down tracked ${ctx.branch}`)) : Effect.void,
  afterTeardown: (ctx) =>
    ctx.verb === "close"
      ? Effect.sync(() => console.log(`Moved to ${ctx.reviewLabel}`))
      : Effect.void,
} satisfies HomesteadConfig;
```

### `onEvent` and `HomesteadEvent`

Replace homestead's default console reporter with your own handler. Omit `onEvent` to keep the built-in log lines.

```ts
import { Effect } from "effect";

onEvent: (e) =>
  Effect.sync(() => {
    if (e.type === "agent.launched") console.log(`custom: #${e.item.number} → ${e.paneId}`);
  }),
```

**Event union** (`HomesteadEvent`):

| `type` | Payload |
| --- | --- |
| `"worktree.creating"` | `{ branch, targetDir, from? }` |
| `"agent.launching"` | `{ item, command, worktreeDir }` |
| `"agent.launched"` | `{ item, command, paneId, worktreeDir }` |
| `"pr.launching"` | `{ pr, mode: "review" \| "work", branch }` |
| `"pr.launched"` | `{ pr, mode, branch, paneId }` |
| `"issues.summary"` | `{ launched, total }` |
| `"teardown"` | `{ verb: "kill" \| "close" \| "complete", branch, phase: "start" \| "done", reviewLabel? }` |

### `issues.*` callbacks

All issue-tracking fields are opt-in. Omit them to never touch GitHub issues.

| Field | Form | Default when enabled |
| --- | --- | --- |
| `branch` | `(item) => string` | *(required if using issue flow)* — no default |
| `label` | `string \| (item) => string` | `"agent:wip"` if set as string |
| `reviewLabel` | `string \| (item) => string` | `"agent:review"` |
| `assign` | `boolean \| string \| (item) => string \| string[]` | `true` → `["@me"]`; `false`/omit → no assign |
| `comment` | `boolean \| (ctx: TrackingContext) => string` | ``homestead: agent started on `{branch}` ({host}) — worktree `{worktreeDir}``` |
| `stopComment` | `boolean \| (ctx) => string` | off by default; `true` → ``homestead: agent stopped on `{branch}` ({host})``` |
| `reviewComment` | `boolean \| (ctx) => string` | off by default; `true` → ``homestead: `{branch}` moved to review ({host})``` |
| `closeComment` | `boolean \| (ctx) => string` | off by default; `true` → ``homestead: `{branch}` completed ({host})``` |
| `closeReason` | `"completed" \| "not planned" \| (ctx) => …` | `"completed"` |
| `labelColor` | `string \| ({ label, kind }) => string` | `"1D76DB"` — `kind` is `"wip"` or `"review"` |

Stop/review/close comment callbacks receive `HomesteadContext & { host: string }`.

```ts
issues: {
  branch: (item) => String(item.number),
  label: "agent:wip",
  assign: true,
  comment: true,
  stopComment: (ctx) => `Stopped on \`${ctx.branch}\` (${ctx.host})`,
  reviewComment: true,   // uses default body above
  closeComment: false,   // no comment on complete
  closeReason: "completed",
  labelColor: ({ kind }) => (kind === "review" ? "0E8A16" : "1D76DB"),
},
```

### Callable config fields

These static-or-callback fields are resolved once at the relevant stage:

| Field | Static | Callback receives | Default |
| --- | --- | --- | --- |
| `agent.command` | `string[]` | `HomesteadContext & { args }` | `["claude"]` |
| `agent.surfaceLabel` | — | `HomesteadContext & { kind: "issue" \| "pr" }` | `issue-{n}` / `pr-{n}` |
| `setup` | `SetupStep[]` | `HomesteadContext & { plan }` | `[]` (no steps) |
| `pr.checks` | `string` | `{ pr, checks? }` | omitted from kickoff prompt |
| `pr.reviewPrompt` | — | `PrPromptContext` | sensible default for `review` |
| `pr.workPrompt` | — | `PrPromptContext` | sensible default for `pr` |
| `pr.prBranch` | — | `{ pr, kind: "fork" \| "same-repo" }` | `pr-{n}` (fork) or `pr.headRefName` (same-repo) |
| `ports[].base` | `number` | `HomesteadContext` | *(required)* |

```ts
agent: {
  command: (ctx) => (ctx.args.includes("--fast") ? ["claude", "--fast"] : ["claude"]),
  surfaceLabel: (ctx) => (ctx.kind === "issue" ? `issue-${ctx.item!.number}` : `pr-${ctx.pr!.number}`),
},
setup: (ctx) =>
  ctx.branch.startsWith("docs-")
    ? [{ label: "install", run: ["bun", "install"] }]
    : [
        { label: "install", run: ["bun", "install"] },
        { label: "migrate", run: ["bun", "run", "db:migrate"], injectEnv: ["DATABASE_URL"] },
      ],
pr: {
  checks: ({ pr }) => (pr.baseRefName === "main" ? "bun run check" : "bun test"),
  prBranch: ({ pr, kind }) => (kind === "fork" ? `review-pr-${pr.number}` : pr.headRefName),
},
ports: [{ key: "PORT", base: (ctx) => (ctx.slug.startsWith("api-") ? 4000 : 3000) }],
```

### Migrating from v0.1.8

**v0.2.0** unifies all callback context onto `HomesteadContext`. Update any custom callbacks that relied on the old ad-hoc shapes:

| Callback | v0.1.8 shape | v0.2.0 shape |
| --- | --- | --- |
| `worktreeDir` | `{ repoName, slug, branch }` | `HomesteadContext` — `worktreeDir` is `""` inside |
| `env.derive`, `afterSetup` | standalone `WorktreeContext` | `HomesteadContext & { targetDir, primaryRoot, plan? }` |
| `agent.prompt` | `{ item, branch, worktreeDir, repoName, args }` | `HomesteadContext & { args }` — use `ctx.repoName`, `ctx.item`, etc. |
| `issues.comment` | `{ item, branch, worktreeDir, host }` | `HomesteadContext & { host }` |
| `issues.stopComment` / `reviewComment` / `closeComment` | *(new in 0.2.0)* | `HomesteadContext & { host }` |
| Teardown hooks | *(new in 0.2.0)* | `HomesteadContext & { verb, … }` |

Fields that still take `(item: WorkItem)` only — `issues.branch`, `label`, `reviewLabel`, `assign` — are unchanged.

Re-run `homestead init` after upgrading to refresh `generated/homestead.config.types.d.ts`.

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

| Command | What it does | Flags |
| --- | --- | --- |
| `init` | scaffold `homestead.config.ts`, generated types, and Claude skills | — |
| `worktree <name>` | new worktree — ports, env, setup | `--from <ref>`, `--dir <path>`, `--no-setup`, `--dry-run` |
| `issue <ref>...` | same, plus an agent in each pane | — |
| `review <ref>` | pull a PR into a worktree; Claude reviews it (read-only) | — |
| `pr <ref>` | pull a PR into a worktree; Claude continues it (same-repo only) | — |
| `close <ref>...` | tear down, keep the branch, issue → review | — |
| `complete <ref>...` | mark issue completed on GitHub, remove worktree + branch | `--keep-remote` |
| `kill <ref>...` | tear down everything, reverse issue signals | `--keep-remote` |

`<ref>` is a branch name, an issue number, or a GitHub issue/PR URL, depending on the command.

## Prerequisites

| | `worktree` | `issue` | `review` / `pr` |
| --- | --- | --- | --- |
| git | ✓ | ✓ | ✓ |
| herdr session | ✓ | ✓ | ✓ |
| `gh` (authenticated) | | ✓ | ✓ |
