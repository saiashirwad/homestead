# githog

**Config-driven git-worktree + agent provisioning.** Built on [Effect](https://effect.website) (v4) and [Bun](https://bun.sh).

githog gives every git worktree its own isolated dev environment — its own ports, its own database, its own `.env` — and can fan a batch of GitHub issues out into parallel coding agents, each in its own worktree. One small `githog.config.ts` per project describes how to provision a worktree; githog does the rest.

```bash
githog setup --create my-feature        # isolate a new worktree (ports, .env, services, setup)
githog implement-issues 21 22 23         # one worktree + agent per issue, in parallel
githog listen                            # auto-implement issues labelled `agent:ready`
githog kill my-feature                   # remove the worktree, branch, and agent surface
```

## Why

Multiple worktrees of one repo usually collide: they share a database, they fight over dev ports (`3000`, `5173`, …), and each needs its `.env` set up by hand. githog carves out a per-worktree slice — a database named for the branch, the next free ports, a copied-and-rewritten `.env` — so any number of worktrees (and the agents working in them) run side by side without stepping on each other.

The two halves compose: `implement-issues` calls the same worktree provisioning in-process (one Effect graph, no nested shell-outs) and then attaches an agent to each resolved worktree.

## Install

```bash
git clone https://github.com/<you>/githog
cd githog
bun install        # also clones the Effect source into .repos/effect (for the effect-ts dev workflow)
bun link           # puts a `githog` binary on your PATH (~/.bun/bin)
```

The bin is a live symlink to the source, so a `git pull` updates it with no rebuild.

**Runtime prerequisites** (per command):

- `git` — always
- `gh` (authenticated) — for `implement-issues`, `listen`, and issue tracking
- a herdr terminal session — for `implement-issues`, `listen`, and the herdr side of `kill`

## Configure

Each project that uses githog has a `githog.config.ts` at its repo root. See [`githog.config.example.ts`](./githog.config.example.ts) for a fully-worked, copy-pasteable example.

```ts
import { defineConfig } from "githog";

export default defineConfig({
  // env keys made unique per worktree (scans sibling worktrees, takes the lowest free value ≥ base)
  ports: [
    { key: "PORT", base: 3000 },
    { key: "CLIENT_PORT", base: 5173 },
  ],

  env: {
    source: ".env",          // copied from the primary checkout (default ".env")
    fallback: ".env.example", // used only if source is missing
    // per-worktree derived keys — `slug` is the branch name slugified, `env` reads the source .env
    derive: ({ slug, env }) => ({
      DATABASE_URL: withDbName(env("DATABASE_URL") ?? DEFAULT_DB_URL, `myapp_${slug}`),
    }),
  },

  // TCP dependencies probed before setup; started via `start` if down
  services: [
    { name: "postgres", host: "localhost", port: 5432, start: ["docker", "compose", "up", "-d", "db"] },
  ],

  // ordered provisioning commands run in the new worktree
  setup: [
    { label: "install", run: ["bun", "install"] },
    { label: "migrate", run: ["bun", "run", "db:migrate"], injectEnv: ["DATABASE_URL"] },
    { label: "seed", run: ["bun", "run", "db:seed"], injectEnv: ["DATABASE_URL"], fatal: false },
  ],

  // the agent loop: githog plans the issue, then drives the agent headlessly
  // with a clean context each iteration until it's done (ADR-0001)
  agent: {
    command: ["claude"],
    loop: { maxIterations: 25 },
  },
});
```

| Field | What it controls |
| --- | --- |
| `ports` | env keys made unique per worktree by scanning every sibling worktree's `.env` and taking the lowest free value ≥ `base`. |
| `env.source` / `env.fallback` | which `.env` body to copy from the primary checkout (default `.env`, falling back to `.env.example`). |
| `env.derive` | function returning per-worktree key overrides (e.g. a DB name keyed off the branch `slug`). |
| `services` | TCP dependencies probed before setup; if unreachable, `start` is run and githog polls until it's up. |
| `setup` | ordered commands. Tokens `{{slug}}`, `{{branch}}`, `{{targetDir}}`, `{{env:KEY}}` are substituted; `injectEnv` puts computed-env values in the child's environment (beating any baked-in `--env-file`); `fatal: false` warns-and-continues. |
| `agent` | `command` (default `["claude"]`), `surface` (`"worktree"` nests under the repo, `"workspace"`, or `"tab"`), and the `loop` block. |
| `agent.loop` | the agent loop knobs: `maxIterations` (cap, default 25), `completionSentinel`/`blockedTag` (default `<promise>COMPLETE</promise>` / `blocked`), `planSkill`/`implementSkill` (default `githog-plan`/`githog-implement`), `taskFile` (default `TASKS.md`), `seedSkills` (default true), and `planPrompt`/`iterationPrompt` overrides. |
| `worktreeDir` | where new worktrees land (default `~/worktrees/<repo>/<slug>`). |
| `issues.branch` | branch name per issue (default the issue number). |
| `issues.label` / `issues.assign` / `issues.comment` | **opt-in** issue tracking — see below. |
| `issues.reviewLabel` / `issues.blockedLabel` | terminal labels the loop swaps `agent:wip` into (default `agent:review` / `agent:blocked`); both free a `listen` slot. |
| `afterSetup` | an Effect escape hatch for arbitrary provisioning, with the full Bun platform (`FileSystem`, `Path`, subprocess) in scope. |

### Issue tracking (opt-in)

So you can see at a glance which issues an agent is on, githog can mark the GitHub issue when an agent **starts** and reverse it on `kill`. All three are opt-in — omit them and githog never touches your tracker.

```ts
issues: {
  label: "agent:wip",                          // add on start (auto-created), remove on kill
  assign: true,                                // assign the gh user (@me) on start, unassign on kill
  comment: true,                               // 🤖 start comment + 🛑 stop comment
  // comment: (ctx) => `started on ${ctx.branch} @ ${ctx.host}`,  // ...or custom text
}
```

githog records what it applied (per repo+branch, under `~/.githog/state/`) so `kill` reverses *exactly* what githog set — nothing else, even with custom branch names. Every gh call is best-effort: a failure warns and continues, it never aborts provisioning or teardown. "Done" is still signaled by your PR/merge — githog only knows *start* (`implement-issues`) and *stop* (`kill`).

A config can also be a plain `export default { ... }` (no `githog` import) when the package isn't resolvable from the repo — handy in projects on a different package manager.

## Commands

### `githog setup`

Provision/isolate one worktree.

```bash
githog setup                              # isolate the worktree you're standing in
githog setup --create my-feature          # create a new worktree on `my-feature`, then isolate it
githog setup --create my-feature --from main --dir ~/wt/x
githog setup --create my-feature --no-setup   # skip the config's setup steps (env/ports only)
githog setup --create my-feature --dry-run    # print the plan, change nothing
```

Re-running on an already-isolated worktree is idempotent — it reuses the existing ports.

### `githog implement-issues`

For each GitHub issue: create a worktree, provision it, open a herdr surface pointed at it, and start the **agent loop** inside that pane (see below). Run from inside the target repo, in a herdr session.

```bash
githog implement-issues 21 22 23
githog 21                                  # bare form (no subcommand) implies implement-issues
githog https://github.com/<you>/myapp/issues/21
```

An issue can be a number or a full GitHub issue URL. A URL is a convenience over the number — it must point at the repo you're running in (the worktree is branched from the local clone here; githog does no cross-repo lookup or cloning), and a URL for a different repo is rejected with a clear message.

Worktrees are provisioned **sequentially** (the port scanner reads sibling `.env` files, so parallel setup would hand out colliding ports); each loop then runs independently in its own herdr pane.

### The agent loop

githog doesn't take one shot at an issue — it drives the agent to done (per [ADR-0001](./docs/adr/0001-githog-driven-agent-loop.md)). After a worktree is provisioned, githog runs `githog loop <issue>` **inside the herdr pane** so you can watch it scroll by live:

1. **Plan pass** — a one-shot `claude -p` invocation (`/githog-plan`) decomposes the issue into an atomic, vertical-slice task list committed to `TASKS.md` (the loop's first commit and its cross-iteration memory).
2. **Iterations** — each iteration is a fresh `claude -p` invocation (`/githog-implement`) with a **clean context**: it picks the next incomplete task from `TASKS.md`, implements it, runs its own checks, commits, and marks the task done.
3. **Stop** — githog parses each invocation's output for sentinels. `<promise>COMPLETE</promise>` ends the loop happily; the iteration cap or a `<blocked>reason</blocked>` ends it as blocked.
   - **Complete** → `gh pr create` from the branch, link the issue, swap `agent:wip → agent:review`. The worktree is left alive for inspection.
   - **Blocked** → push the partial branch, swap `agent:wip → agent:blocked`, post the reason as a comment. No PR.

The prompt logic ships as editable Claude skills (`githog-plan`, `githog-implement`) seeded into each worktree at provision time, so you can read, tune, or run them by hand; a built-in default applies if a skill is absent. Override the cap, sentinels, skill names, or supply custom prompts via `agent.loop`.

### `githog listen`

Watch the repo and auto-implement issues as they're queued. Run it in a long-lived herdr pane.

```bash
githog listen
```

Label an issue **`agent:ready`** and githog picks it up: it claims the issue (swaps the label to `agent:wip` so it's never grabbed twice), then runs the same flow as `implement-issues` — provision a worktree and start the agent loop. The loop drains the issue to a terminal state on its own; the label *is* the queue:

```
agent:ready ──(githog claims)──► agent:wip ──(loop completes)──► agent:review (PR open)
                                          └──(cap / <blocked>)──► agent:blocked
```

It polls every `intervalSeconds` (default 30), never spawns more than `maxConcurrent` loops (default 3, gauged by counting open `agent:wip` issues — both `agent:review` and `agent:blocked` free a slot), and skips any issue whose branch already exists. A failure on one issue — or one poll — logs and continues; the daemon doesn't die. Fill a backlog of `agent:ready` issues and let it run overnight; come back to a queue of PRs to review.

```ts
listen: { label: "agent:ready", intervalSeconds: 30, maxConcurrent: 3 }
```

On an interactive terminal, `listen` renders a **live dashboard** ([OpenTUI](https://opentui.com)) with three columns — **queued** / **in progress** / **done** — plus a detail pane showing the current issue's provisioning step and captured setup output. Newly-pulled-in issues flash `NEW`; finished ones (their `agent:wip` label gone) move to **done**. Press `q` to quit (agents keep running in their herdr panes). Piped/non-TTY, or with `--plain`, it falls back to line logs.

```
┌ githog listen ──── orderservice · trigger agent:ready · every 30s · 2/3 active ┐
│ QUEUED (1)          IN PROGRESS (2)            DONE (2)                         │
│  · #42 tax bug NEW   ⟳ #34 import gate worktree  ✓ #29 payee refactor          │
│                      ▸ #37 webhook retries       ✓ #31 seed cleanup            │
├ detail · #34 ───────────────────────────────────────────────────────────────  │
│  ⟳ provisioning · worktree                                                     │
│  > pnpm --filter @app/server db:migrate                                        │
│  [✓] migrations applied successfully                                           │
└ q quit · agents run in their own herdr worktree panes ───────────────────────  ┘
```

Detection is **polling** (a local CLI can't receive GitHub webhooks), which needs no infra and works behind NAT. Since claiming is a label swap, there's a tiny race window if you run `listen` on two machines against one repo — fine for a single dev box.

### `githog kill`

The inverse — tear a worktree down completely.

```bash
githog kill 33
githog kill my-feature other-branch
```

Takes branch names (a number or issue URL maps to its branch under the default scheme). It closes the herdr worktree workspace, removes the git worktree, and deletes the branch — each step best-effort and idempotent, so re-running or killing a partially-gone worktree is safe.

## Develop

```bash
bun run typecheck   # tsc --noEmit
bun test            # pure-helper unit tests
```

Built on Effect 4 (`effect@beta`) and `@effect/platform-bun`. Subprocess work uses `effect/unstable/process`; the CLI runs on `BunRuntime`/`BunServices`.
