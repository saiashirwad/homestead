# Homestead config callbacks — design spec

**Date:** 2026-06-25
**Status:** Approved design, pre-implementation
**Author:** Sai Ashirwad (with Claude)

## Problem

Homestead's `homestead.config.ts` lets users customize a few behaviors via callbacks
(`branch`, `prompt`, `worktreeDir`, `afterSetup`, `pr.reviewPrompt`/`workPrompt`,
`env.derive`, `issues.comment`). But most user-visible strings and behaviors are
hardcoded: GitHub issue comments (stop/review/close), labels, close reason, assignee,
herdr workspace names, PR branch names, console status lines, and several scalar config
fields that would be more useful as per-work-item functions.

This spec covers a full sweep: expose the remaining customization points as callbacks,
unify the context object every callback receives, and add the lifecycle hooks and event
reporter that the current API lacks.

## Goals

- Let users customize **what messages** homestead posts to GitHub issues and prints to the console.
- Add **lifecycle hooks** at launch and teardown (the API only has `afterSetup` today).
- Convert remaining **static fields** to value-or-callback unions where per-work-item variation is real.
- Standardize on **one context-object base** all callbacks receive.

## Non-goals

- Commit messages / PR titles / PR bodies. Homestead never writes these — the AI agent does,
  via its prompt. There is nothing to expose. Confirmed: no `git commit` / `gh pr create` in `src/`.
- Making genuine constants (service host/port, ready markers, surface kind) into callbacks.

## Breaking change notice

Unifying the context object changes the signatures of existing callbacks
(`branch`, `prompt`, `worktreeDir`, `afterSetup`, `env.derive`, `pr.*Prompt`,
`issues.comment`). This is a **breaking config-API change**. It ships with a minor/major
version bump and a migration note in the changelog/README. Old configs that destructure
the old context fields must update.

---

## Architecture: the two-layer pattern (must follow)

Config is decoded through `Schema.Struct` in `src/config-schema.ts`. **Functions do not
decode through `Schema.String`/`Schema.Array`.** That is why every existing callback lives
in `src/types.ts` as an interface that `extends`/`Omit`s the schema-decoded `*Data` type and
layers the function-typed field on top. The `*_DATA_FIELDS` / `*_SCALAR_FIELDS` arrays in
`config-schema.ts` enumerate which keys are plain data (copied straight off the decoded
object) vs. which are overridden by callbacks in `types.ts`.

**Every new callback in this spec follows that pattern:** schema stays scalar/data-only;
the callable form is declared only in `types.ts`; the field lists are updated so the merge
logic knows a key is callback-bearing.

---

## Section 1 — Unified context base

Introduce one base shape in `src/types.ts` that all callbacks receive:

```ts
export interface HomesteadContext {
  readonly repoName: string;
  readonly slug: string;
  readonly branch: string;
  readonly worktreeDir: string;
  readonly item?: WorkItem;   // present in issue flows
  readonly pr?: PrView;       // present in PR flows
  readonly env: (key: string) => string | undefined;
}
```

Existing callbacks migrate to receive `HomesteadContext` (possibly intersected with
stage-specific extras). Concretely:

- `worktreeDir(ctx)` — today `{ repoName, slug, branch }`. Widen to `HomesteadContext`.
  Note: at worktree-planning time `worktreeDir` itself is being computed, so the `worktreeDir`
  field of the context is the *target* dir already resolved by the planner, or omitted — see
  Open Questions.
- `WorktreeContext` (used by `env.derive`, `afterSetup`) — reconcile with `HomesteadContext`.
  Keep `targetDir`/`primaryRoot`/`plan` as stage extras intersected on top.
- `AgentPromptContext` — fold `item`/`branch`/`worktreeDir`/`repoName`/`args` into the base;
  keep `args` as an extra.
- `TrackingContext` — already `WorkItem & { branch, worktreeDir, host }`; re-express as
  `HomesteadContext & { host: string }`.

The deliverable is a single documented base plus a small set of named stage-extra
intersections, replacing the four near-duplicate shapes.

### Enabler: widen `TrackingState`

Teardown stages (`kill`/`close`/`complete`) currently load only the persisted
`TrackingState` (`{ number, url, label?, assigned?, commented? }` in `src/tracking.ts`).
Without `title` and `worktreeDir`, teardown callbacks can't populate `item`/`worktreeDir`
in the context. **Widen the `TrackingState` schema to persist `title` and `worktreeDir`**
at start time so later stages can rehydrate a full `HomesteadContext`. Reading older
tracking state that lacks these fields must degrade gracefully (fields optional; context
fields omitted when absent).

---

## Section 2 — Lifecycle hooks

Mirror `afterSetup`'s signature `(ctx) => Effect.Effect<void, never, HomesteadServices>`
so a hook can talk to the filesystem / herdr / child processes.

```ts
readonly afterLaunch?:
  (ctx: HomesteadContext & { readonly paneId: string }) => Effect.Effect<void, never, HomesteadServices>;

readonly beforeTeardown?:
  (ctx: HomesteadContext & { readonly verb: "kill" | "close" | "complete"; readonly tracked: boolean })
    => Effect.Effect<void, never, HomesteadServices>;

readonly afterTeardown?:
  (ctx: HomesteadContext & { readonly verb: "kill" | "close" | "complete"; readonly reviewLabel?: string })
    => Effect.Effect<void, never, HomesteadServices>;
```

- `afterLaunch` fires after the agent pane is up (`src/herdr/agent.ts`, post line ~28).
- `beforeTeardown` / `afterTeardown` fire at the top/bottom of each teardown verb in
  `src/teardown.ts`. **`tracked` matters:** teardown already special-cases owned branches
  vs. PR-author branches; surfacing `tracked` keeps a user hook from acting on a remote it
  doesn't own.

Hook failures: a hook returns `Effect<void, never, ...>` (no error channel), matching
`afterSetup`. If a hook can fail, it must handle its own errors; homestead does not abort
teardown on hook trouble.

---

## Section 3 — `onEvent` reporter

Replace the ~15 hardcoded `Console.log` status lines (worktree creating; agent
launching/launched; issues summary; PR launching/launched; teardown start/done) with a
single structured reporter. The **default implementation reproduces today's exact log
lines and glyphs**, so behavior is unchanged unless overridden.

```ts
readonly onEvent?: (e: HomesteadEvent) => Effect.Effect<void, never, HomesteadServices>;

type HomesteadEvent =
  | { type: "worktree.creating"; branch: string; targetDir: string; from?: string }
  | { type: "agent.launching" | "agent.launched"; item: WorkItem; command: ReadonlyArray<string>; paneId?: string; worktreeDir: string }
  | { type: "pr.launching" | "pr.launched"; pr: PrView; mode: "review" | "work"; branch: string; paneId?: string }
  | { type: "issues.summary"; launched: number; total: number }
  | { type: "teardown"; verb: "kill" | "close" | "complete"; branch: string; phase: "start" | "done"; reviewLabel?: string };
```

Call sites currently logging directly (`src/teardown.ts`, `src/herdr/agent.ts`,
`src/issue/provision.ts`, `src/pr/provision.ts`, `src/worktree/plan.ts`) emit events
instead. Console output is centralized in the default reporter.

**Design note:** issue *comments* (Section 4) stay as per-field string callbacks because
they are content the user authors; console *logs* go through `onEvent` because they are
status the user may want to suppress or reformat wholesale. These are intentionally two
mechanisms.

---

## Section 4 — GitHub issue message callbacks

On the `issues` block (`IssuesConfig` in `types.ts`, scalars in `IssuesConfigDataSchema`).
Make the comment surface symmetric with the existing `comment` (start) callback, and make
the remaining hardcoded values customizable.

```ts
// comment (start) already exists: boolean | ((ctx: TrackingContext) => string)
readonly stopComment?:   boolean | ((ctx: HomesteadContext & { host: string }) => string);
readonly reviewComment?: boolean | ((ctx: HomesteadContext & { host: string }) => string);  // currently no comment posted
readonly closeComment?:  boolean | ((ctx: HomesteadContext & { host: string }) => string);   // currently no comment posted

readonly closeReason?: "completed" | "not planned" | ((ctx: HomesteadContext) => "completed" | "not planned");
readonly labelColor?:  string | ((ctx: { label: string; kind: "wip" | "review" }) => string);  // today: hardcoded "1D76DB"

readonly label?:       string | ((item: WorkItem) => string);   // today: scalar string
readonly reviewLabel?: string | ((item: WorkItem) => string);   // today: scalar string
readonly assign?:      boolean | string | ((item: WorkItem) => string | ReadonlyArray<string>);  // today: boolean → "@me"
```

Defaults preserve current behavior:
- `stopComment` default body: `` homestead: agent stopped on `${branch}` (${host}) ``
- `reviewComment` / `closeComment` default: **off** (no comment) — matches today.
- `closeReason` default: `"completed"`.
- `labelColor` default: `"1D76DB"` for both kinds.
- `assign` default: `true` → `@me`.

Hardcoded sites to route through these: `src/tracking.ts` (`LABEL_COLOR`, stop comment,
review-label add/remove, close `--reason completed`, `--add-assignee @me`).

---

## Section 5 — Field callbacks (value-or-callback unions)

Each declared in `types.ts` over the decoded `*Data` type; schema stays scalar.

| Field | Current type | New type | Use case |
|---|---|---|---|
| `agent.command` | `string[]` | `string[] \| ((ctx: HomesteadContext & { args }) => string[])` | `--model opus` only for `hard` issues; inject issue # as arg |
| `setup` | `SetupStep[]` | `SetupStep[] \| ((ctx: HomesteadContext & { plan: Plan }) => SetupStep[])` | conditional/computed steps (skip seed for docs-only branch) |
| `pr.checks` | `string` | `string \| ((ctx: PrPromptContext) => string)` | full e2e into `main`, smoke check otherwise |
| `ports[].base` | `number` | `number \| ((ctx: HomesteadContext) => number)` | deterministic per-issue port |
| `surfaceLabel` (new, on `agent`) | n/a (hardcoded `issue-${n}`/`pr-${n}`) | `(ctx: HomesteadContext & { kind: "issue" \| "pr" }) => string` | rename herdr workspaces; single source of truth |
| `pr.prBranch` (new) | n/a (hardcoded `pr-${n}`) | `(ctx: { pr: PrView; kind: "fork" \| "same-repo" }) => string` | customize PR fork branch naming |

`surfaceLabel` has two call sites (`src/herdr/agent.ts`, `src/pr/provision.ts`) and the
`issue-*`/`pr-*` prefix also appears in user-facing copy (`src/issue/provision.ts`); the
callback becomes the single source so copy and naming stay consistent.

`prBranch` default: `kind === "fork" ? `pr-${pr.number}` : pr.headRefName` (`src/pr/branch.ts`).

---

## Implementation order

1. **Section 1 base + `TrackingState` widening** — foundation; everything else uses the context.
2. **Section 4 issue message callbacks** — the original ask; self-contained once context exists.
3. **Section 2 lifecycle hooks** — structural; small surface.
4. **Section 3 `onEvent` reporter** — mechanical; default keeps current output.
5. **Section 5 field callbacks** — independent unions, can land incrementally.

Each section ships with tests and a `homestead.config.ts` dogfood update demonstrating the
new surface.

---

## Testing strategy

- **Schema decode tests:** scalar forms still decode; callback forms bypass schema and resolve
  in `types.ts` merge. Verify `*_DATA_FIELDS` / `*_SCALAR_FIELDS` updates.
- **Default-equivalence tests:** with no overrides, every new callback/event/hook reproduces
  today's exact strings (snapshot the comment bodies, label color, close reason, log lines).
- **Context-population tests:** issue flow populates `item`; PR flow populates `pr`; teardown
  stages rehydrate `title`/`worktreeDir` from widened `TrackingState`; old tracking state
  without those fields degrades gracefully.
- **Hook ordering tests:** `beforeTeardown` runs before any GitHub mutation; `afterTeardown`
  after; `tracked` correctly reflects owned vs. PR-author branch.
- **Backward-compat note:** existing callback signature changes are covered by updating the
  dogfood config and its tests (the breaking change is intentional and verified, not silent).

---

## Open questions

1. **`worktreeDir` self-reference:** when resolving the `worktreeDir` callback, the
   `worktreeDir` field of `HomesteadContext` isn't known yet. Resolve by omitting it for that
   one callback, or by passing the planner's target dir. Decide during implementation.
2. **`env` accessor at teardown:** the resolved env may not be loaded at teardown time. If so,
   `ctx.env` returns `undefined` for all keys at teardown stages — document, don't fake it.
