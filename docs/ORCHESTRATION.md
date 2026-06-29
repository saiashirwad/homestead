# Orchestration contract

This document is the contract any coding agent — Claude or otherwise — must honor
to be driven by homestead's worktree orchestration. Homestead boots an agent in a
worktree, waits for it to finish, and then decides whether the work can be landed.
Three load-bearing primitives make that possible:

1. **The status sentinel** — how an agent reports its own outcome.
2. **The `agent wait` exit-code contract** — how an orchestrator reads that outcome.
3. **The provenance markers** — how auto-generated work is told apart and protected
   from being silently landed.

It documents the *stable interface* — file shapes and exit codes — and points to
source for the mechanics, so it does not rot every time an internal function moves.
The Claude-flavored skills under `src/skills/` sit *on top* of this contract; they
decide *when* to call the primitives. This document defines the primitives
themselves, so any agent can build an equivalent layer. Everything below describes
the current on-`main` behavior; the cited symbols are the source of truth.

---

## 1. The status sentinel — `.homestead/agent-status.json`

When an agent stops, it reports its own outcome by writing a single JSON file
inside its worktree:

```
<worktree-root>/.homestead/agent-status.json
```

The path constant is `AGENT_STATUS_RELPATH = ".homestead/agent-status.json"`
(`src/agent/status.ts`), relative to the worktree root.

This is the *agent reporting on itself*. It is distinct from homestead's own
tracking state under `~/.homestead/state/…`, which is homestead's record of what it
provisioned. The sentinel must never be committed — homestead's setup adds
`.homestead/` to the worktree's `.gitignore`.

### Schema

`AgentStatusFileSchema` (`src/agent/status.ts:13`):

| Field      | Type                                | Required | Meaning                                              |
| ---------- | ----------------------------------- | -------- | ---------------------------------------------------- |
| `status`   | `"done" \| "blocked" \| "failed"`   | yes      | The outcome (see below).                             |
| `summary`  | `string`                            | yes      | One short plain-English paragraph. The first thing a human reads. |
| `details`  | `string`                            | no       | Optional longer context.                             |
| `at`       | `string` (ISO-8601, best-effort)    | no       | When the agent wrote it.                             |

Minimal valid file:

```json
{
  "status": "done",
  "summary": "Implemented the feature and verified the test suite passes."
}
```

### What each `status` value means

Verbatim from the instruction homestead appends to the agent's kickoff prompt
(`STATUS_FILE_INSTRUCTION`, `src/agent/defaults.ts:12`):

- **`done`** — only if the work is complete *and you have verified it*.
- **`blocked`** — you need a human decision or an external dependency.
- **`failed`** — you tried and could not finish.

### Two ways the file gets written

**Best-effort (default mode).** The agent itself writes the sentinel as its last
action, because the `STATUS_FILE_INSTRUCTION` tail is appended to its kickoff
prompt. ⚠ This is a request to the model, not a guarantee — in practice agents skip
it roughly half the time. A file the model "might" write cannot be trusted on its
own; that is exactly why the `agent wait` backstop (§2) and autonomous mode exist.

**Deterministic (autonomous mode).** `homestead agent finalize` writes the sentinel
from the agent's exit code and the project's `check` command — not from the model's
memory (`src/agent/finalize.ts`). The rule (`decideAutonomousStatus`,
`finalize.ts:32`):

- A model-written **`blocked` is sacred and is never overridden.** Only a human can
  adjudicate "a decision is needed", and no automated check can. If the existing
  sentinel says `blocked`, finalize leaves it alone.
- Otherwise the authoritative signal is the **`check` exit code if a check is
  configured, else the inner agent's exit code**: `0 → done`, non-zero → `failed`.
  (An interactive `/exit` always exits `0`, so a configured check is preferred
  whenever present.)
- The model's `summary` is preserved when it left a non-empty one (`finalSummary`,
  `finalize.ts:46`); otherwise finalize writes a plain description of what it
  observed, so the sentinel is never empty.

In autonomous mode the kickoff tail (`AUTONOMOUS_STATUS_INSTRUCTION`,
`src/agent/defaults.ts:28`) additionally tells the agent to **exit the session
(`/exit`) as its final act** — that exit is what triggers `finalize`.

---

## 2. The `agent wait` exit-code contract

`homestead agent wait` blocks until the agent reaches an outcome, then exits with a
code an orchestrator branches on (`exitCodeFor`, `src/agent/wait.ts:19`):

| Exit | Outcome     | Meaning                              | Orchestrator should…           |
| ---- | ----------- | ------------------------------------ | ------------------------------ |
| `0`  | `done`      | Sentinel says `done`.                | Proceed (e.g. land / review).  |
| `1`  | `failed`    | Sentinel says `failed`.              | Retry or inspect.              |
| `2`  | `blocked`   | Sentinel says `blocked`.            | Get a human decision.          |
| `3`  | `no-signal` | No trustworthy signal at all.        | Investigate — do **not** land. |

**The load-bearing rule: `3` means no trustworthy signal — never treat unknown as
done.** `no-signal` is its own outcome (`WaitOutcome`, `wait.ts:12`), with two
reasons: `timeout` (the deadline elapsed) and `idle-pane` (the backstop tripped).

### How `wait` decides

**The sentinel is primary.** `wait` polls `.homestead/agent-status.json`. An absent,
empty, or malformed/partial file all read as "no status yet" and keep polling —
never an error (`readStatus`, `wait.ts:95`). The first valid sentinel it reads is
the result.

**The backstop is secondary**, and only runs when a `--pane` is given. After a grace
window (default 15s — herdr can briefly report `idle` before the agent gets going),
`wait` consults herdr's own `agent_status` via `herdr.pane.get`. Counting a default
of 3 consecutive `idle`/`done` reads as "the agent stopped without leaving a
sentinel" → exit `3` (`idle-pane`).

### ⚠ Do-not-regress: the backstop reads `agent_status`, NOT pane text

The backstop consults herdr's structured `agent_status`, where
`STOPPED_STATUSES = {"idle", "done"}` (`wait.ts:113`). A `working` status, and a
transient `blocked` permission-prompt, must **not** count as stopped.

It must **never** grep pane text for the ready marker `❯`. Claude Code's TUI always
draws `❯` whether it is working or idle, so a text backstop fires against actively
working agents and returns a false exit `3`. `❯` is only valid as the *launch*
signal ("the REPL is up, send the prompt") — never as an idle/done signal.

---

## 3. Provenance markers — telling auto-work apart, and protecting it

Machine-spawned work must be distinguishable from work a human started, so an
orchestrator (or a human) never silently lands an agent's auto-work as if it were
their own. Two record *shapes* carry this provenance.

### Global tracking state — `~/.homestead/state/<repo-slug>/<branch-slug>.json`

`TrackingStateSchema` (`src/tracking.ts:23`). The discriminator is
`kind: "issue" | "spawn"`, which **decoding-defaults to `"issue"`** so old state
files that carry no `kind` keep decoding as issue-work — a zero-touch migration
(`tracking.ts:24`).

Spawn-work carries a nested `spawn: SpawnProvenanceSchema` (`tracking.ts:12`):

| Field        | Type                | Meaning                                                        |
| ------------ | ------------------- | ------------------------------------------------------------- |
| `spawnedBy`  | `string`            | Free text: `"agent spawn"`, a parent paneId, or a username. Default `DEFAULT_SPAWNED_BY = "agent spawn"`. |
| `paneId`     | `string` (optional) | The herdr pane the agent runs in.                             |
| `promptSlug` | `string` (optional) | Slug of the prompt it was spawned with.                       |
| `spawnedAt`  | `string`            | ISO-8601 spawn time.                                          |

This is the record the **`complete` gate reads** (§ below).

### Worktree-local marker — `.homestead-agent.json`

`AGENT_MARKER_FILE = ".homestead-agent.json"` (`tracking.ts:51`), shape
`AgentMarkerSchema` (`tracking.ts:41`):

| Field        | Type                | Meaning                                                              |
| ------------ | ------------------- | ------------------------------------------------------------------- |
| `kind`       | `"spawn"`           | Always `"spawn"`.                                                    |
| `spawnedBy`  | `string`            | As above.                                                           |
| `paneId`     | `string` (optional) | As above.                                                           |
| `promptSlug` | `string` (optional) | As above.                                                           |
| `statusFile` | `string` (optional) | Where this agent's sentinel lives. Defaults to `AGENT_STATUS_RELPATH`. |
| `createdAt`  | `string`            | ISO-8601 creation time.                                              |

It is self-describing: a tool whose `cwd` is inside the worktree can detect
auto-work by reading this one local file, without resolving repo-slug +
branch-slug back to the global state dir. It is written inside the worktree
alongside `.env` and is gitignored.

The `agent spawn` flow writes this **worktree-local marker** at provision time
(`src/agent/spawn.ts:99`, via `writeAgentMarker`); it deliberately makes no GitHub
calls and writes no global tracking state of its own. The marker is read by the
dashboard, the GC, and the agent prompt/result paths to recognize auto-work.

> Note: the two records have different writers and readers — they are not written
> together. `agent spawn` writes the local marker; the global `kind: "spawn"`
> tracking state is the shape used when a spawn flow records tracking state, and it
> is what the `complete` gate below inspects.

### The `--allow-spawned` gate on `complete`

`homestead complete` lands and closes work *irreversibly*. To stop an orchestrator
(or a human) from silently merging an agent's auto-work as if it were their own,
`runBranchTeardown` refuses **before any destructive step** when the branch is
`kind: "spawn"` and `--allow-spawned` was not passed (`src/teardown.ts:148`):

- It prints who spawned the branch and when.
- It deliberately does **not** emit a "done" event, so the reporter never renders a
  false `✓ completed`. Nothing is torn down.

`kill` is **exempt** from this gate: it is reversible — it keeps the branch — so it
always passes `allowSpawned: true` (`teardown.ts:179`).

---

## The Claude-flavored layer

The skills under `src/skills/` — `homestead-local-complete`, `homestead-teardown`,
`homestead-pr-triage`, `homestead-setup`, `homestead-decompose` — are the
Claude-flavored *judgment* layer that sits on top of this contract. They decide
*when* to call the primitives (when it is safe to land, when a branch is someone
else's, how to set a repo up, how to slice a goal into collision-aware issues). This
document defines the primitives themselves so that any agent — not just Claude — can
build an equivalent layer.

> Coming later (other epic issues): an MCP server and a `homestead plan` / wave
> scheduler. This document covers only the existing CLI and file contract.
