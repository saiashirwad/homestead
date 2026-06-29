---
name: homestead-decompose
description: Use when the user wants to turn a goal into issues, plan an epic, break a big thing down into interdependent issues, or decompose a goal into a runnable wave plan (e.g. "turn this goal into issues", "plan an epic", "break this down into interdependent issues", "decompose this goal"). Produces an epic + grounded child issues carrying the touches:/depends-on: metadata that `homestead plan` schedules on.
---

# homestead-decompose

## Overview

Turn "do this big thing" into an **epic + grounded child issues** that another agent can build without re-discovering the codebase, each annotated with the exact `touches:`/`depends-on:` metadata `homestead plan` parses into collision-aware waves. You are writing the *input* to the orchestration machine: `homestead plan` (`src/cli.ts:153`) reads these issues, `homestead issue` provisions a worktree per child, agents build in parallel, `homestead land` integrates. If the decomposition is wrong, every downstream step inherits the error.

This is a **See/Trust** gap one level up: you trust the *plan* before you trust the run. A plan full of confident-but-wrong symbols, or with file collisions the scheduler can't see, fails *after* you've spent agents on it.

**The golden rule: verify every symbol against the code before you write it.** Every `file.ts:line` and symbol name in an issue must be *read*, not *recalled*. This is the load-bearing step, not a nicety — see §1.

No code; this is judgment encoded as a procedure. Work the recipe in order.

## 1. The golden rule — verify symbols against the code before you write

Drafting issues against remembered APIs feels fast and is the single biggest way decomposition fails: an issue full of confident wrong symbols sends an agent down a dead end it can't escape, because the issue *looks* authoritative. This session, three claims that "felt right" were only caught by opening the file:

| Recalled (wrong) | Verified against the code |
|---|---|
| `herdr worktree list` returns the worktree's directory path, so an agent can resolve a worktree → its path. | The schema is **`branch` + `open_workspace_id` only** — no path field (`src/herdr/types.ts:21-24`). The whole "resolve worktree to a directory" path had to be dropped. |
| The idle `❯` prompt marker means "the agent is idle / done". | `❯` is a valid **REPL-up** signal (the default ready marker, `src/agent/defaults.ts:6`) but a **broken idle/done** signal: Claude Code's TUI *always* draws `❯`, so it never means "finished" (`src/agent/wait.ts:111`). |
| A `TrackingState` fixture only needs `number`/`url`/etc. | `kind` is now **required** (`src/tracking.ts:24`); fixtures written without it break. |

The rule: open the file, find the symbol, copy the real `file.ts:line` into the issue. If you cite a function, a flag, a schema field, or a line number you have not just read, you are guessing — and a guess in an issue is worse than a gap, because it reads as fact.

## 2. Write each child issue in the homestead PRD format

Each child issue is an engineer's issue, not marketing. Use the full section set (the same shape this repo's issues use):

- **Problem** — what's missing and why it matters; tie it to the project framing (the Await/See/Trust strands the epic hangs off).
- **Goal** — one sentence: what becomes possible when this lands.
- **Proposed design** — the approach, citing **verified** `file.ts:line` for every symbol you reference (see §1).
- **CLI surface** — new/changed commands and flags, or "None" for a non-command change.
- **Acceptance criteria** — `- [ ]` checkboxes, each independently checkable.
- **Testing** — what proves it works (automated tests, or a concrete manual acceptance check).
- **Dependencies** — what must land first (logical *and* file-level — see §4).
- **Out of scope** — what this issue deliberately does not do.
- **Effort** — rough size (XS/S/M/L) and where the cost lives.

## 3. Emit the dependency metadata block — exact grammar

At the **very top of every child issue body**, before the prose, emit a fenced block:

````
```
touches: src/cli.ts, src/issue/provision.ts
depends-on: homestead plan — schedule interdependent issues into collision-aware waves
```
````

This is the contract `homestead plan` parses (`parseWaveMetadata`, `src/waves.ts:84-104`). The grammar is **not** what you'd guess — verify it against `src/waves.ts` if you doubt any of this:

- **It must be inside a ` ``` ` code fence.** The parser scans fenced blocks and uses the **first fence that contains a `touches:` line** (`src/waves.ts:89-95`). Put it at the top so it wins over any later fence (e.g. a CLI example).
- **`touches:`** is a comma-separated list of the real source paths this issue creates or edits.
- **`depends-on:` takes other issues' _titles_, not `#numbers`.** ⚠️ This is the easy thing to get wrong. The planner resolves each title to a number by normalized (lowercased, whitespace-collapsed) match against the issue set (`src/waves.ts:126,134`). A `#47` in this line matches no title and throws a **dangling-dependency** error (`src/waves.ts:136-140`). Real example from the test suite: `depends-on: agent wait, tracking kind` (`src/waves.test.ts:19`).
- **`none`** (case-insensitive, alone) means no dependencies → empty list (`src/waves.ts:63`).
- A trailing **`# comment`** on either line is stripped; values are split on commas and trimmed (`src/waves.ts:56-64`).

### `touches:` must be accurate and concrete — it decides parallelism

`touches:` is what lets the scheduler run issues at the same time. Two rules the parser enforces, so you must respect:

- **List real files, not directories-in-spirit.** `src/cli.ts`, `src/issue/provision.ts` — not "the CLI layer". When two issues list an **overlapping path**, the planner will not put them in the same wave even if they're logically independent (`src/waves.ts:186-198`).
- **Never omit `touches:`.** An issue with no `touches:` is treated as **colliding with everything** — isolated into its own wave and flagged with a warning (`src/waves.ts:182-184`, `218-221`). That serializes it. If you genuinely don't know the files yet, that's a sign the issue isn't grounded enough to schedule.

## 4. Dependencies are file-level, not only logical

Beyond "B needs A's feature", flag **shared-file collisions** — two issues that edit the same file collide on merge even when neither needs the other. The two known hazards in this repo:

- **`src/cli.ts`** — every subcommand registers here via `Command.withSubcommands` (`src/cli.ts:647`, `662`). Any two issues that add a command both edit `cli.ts`. List `src/cli.ts` in `touches:` for each so the scheduler serializes them; do **not** pretend they're independent.
- **`src/generated/*.d.ts`** — these are **regenerated, not merged** (`bun run gen:config-types`; `package.json:28`, verified by `check` at `package.json:31`). Two issues that both change the config schema both regenerate this file, and git cannot merge two regenerations cleanly. Put the second in `depends-on:` the first (so they land in different waves), and say so in **Out of scope** / **Dependencies**.

When you spot a file-level collision, write it into both the `touches:` block (so the planner sees it) **and** the prose Dependencies section (so a human reading the issue sees it).

## 5. Emit the epic structure

Produce **one epic / tracking issue** that lists the children, and give every child:

- a **`Part of #<epic>`** line, and
- a **`Depends on #N`** line for each logical prerequisite.

This gives GitHub the dependency graph *and* gives `homestead plan` a second source of truth beside the metadata block.

**The chicken-and-egg:** `Depends on #N` needs real issue numbers, which don't exist until the issues are filed. Resolve it by **create order**: file the epic first, then the children, then backfill the `#N` cross-references. Or — since the planner resolves `depends-on:` by **title** (§3) — write the titles in `depends-on:` from the start and let the numbers follow. The metadata block does not need numbers to schedule correctly.

## 6. Wave composition — slice issues to match how waves actually run

Tell the author how the plan will run, because the slicing must match the runtime:

- Waves compose off **local `main`** by default — `resolveDefaultBaseRef` forks each new worktree from the local default branch (`src/worktree/base-ref.ts:13`, used at `src/worktree/plan.ts:204`).
- Or off an integration branch via **`homestead issue --from <ref>`** (`src/cli.ts:123` → `resolveIssueBase`, `src/issue/provision.ts:63`).

So a child that genuinely depends on another's *code* belongs in a **later wave** (built after the first lands), not the same one. **Prefer cutting issues so each wave's files are disjoint** — that's what lets a wave fan out safely.

## The one risky call: how aggressively to split

Over-splitting creates **artificial** file collisions (ten issues all touching `src/cli.ts`) that serialize everything you hoped to parallelize. Under-splitting buries the parallelism. The stance:

1. **Split by file ownership first** — issues that own disjoint files parallelize cleanly.
2. **Then by logical dependency** — order the rest into waves.
3. **Warn loudly when a clean split isn't possible.** A `src/cli.ts`-heavy epic (many new subcommands) cannot fan out — every issue touches `cli.ts`. Say that plainly ("these five all edit `cli.ts`, so they serialize regardless of logic") rather than emitting waves that pretend to be independent and then collide at merge.

## Worked example

Goal: *"Add a `homestead status` command that prints a worktree summary, and add a retry/backoff helper to the agent-wait loop."* Two features — one touches `src/cli.ts` (a new subcommand), one is isolated in the agent layer.

After reading the code to ground both, you'd emit two children:

**Child A — "homestead status: print a worktree summary"**

````
```
touches: src/cli.ts, src/status.ts
depends-on: none
```
````
> **Problem** … **Proposed design** — register a `statusCommand` via `Command.withSubcommands` (`src/cli.ts:647`), reading tracking state from `src/tracking.ts` … *(cite only lines you read)*

**Child B — "agent-wait: retry with backoff"**

````
```
touches: src/agent/wait.ts
depends-on: none
```
````
> **Proposed design** — wrap the poll loop in `src/agent/wait.ts` (note: it no longer greps for `❯`, `src/agent/wait.ts:111`) …

**The collision call:** A and B touch *disjoint* files (`cli.ts`+`status.ts` vs `agent/wait.ts`) and neither depends on the other → **`homestead plan` schedules both in Wave 1, built in parallel.** If a third child *also* added a subcommand, it would list `src/cli.ts` in `touches:` too — colliding with A — and the planner would push it to a **separate wave**. You'd flag that in the epic: *"Child C shares `cli.ts` with Child A, so it can't run in the same wave; it lands after A."* Run `homestead plan <A> <B> <C>` to see the waves before filing.

## Finishing

- The skill **outputs issue text**; it does not file issues or run waves. A human (or other tooling) files them with `gh issue create`, and `homestead issue` / `homestead plan` consume them.
- Before handing off, sanity-check each block against `src/waves.ts`: fenced, `touches:` concrete, `depends-on:` by **title**, no `#numbers` in the block.
- Summarize the wave shape you expect (which children parallelize, which serialize and why), and call out any collision you could not split away — don't claim independence you didn't achieve.
