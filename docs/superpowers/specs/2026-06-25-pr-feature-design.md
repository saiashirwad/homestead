# Design: `homestead pr` and `homestead review`

**Date:** 2026-06-25
**Status:** Approved (pre-implementation)

## Summary

Add two subcommands that pull a GitHub pull request into an isolated worktree
and launch Claude Code in a herdr pane, seeded with a mode-specific kickoff
prompt:

- **`homestead review <pr>`** — evaluate a PR. Claude summarizes what it does,
  runs the project's checks, and flags risks. Read-only intent (don't edit).
- **`homestead pr <pr>`** — continue building on a PR. Claude runs the checks,
  then keeps working: fixes failures, addresses review comments, pushes commits.

Both follow homestead's existing philosophy: **homestead sets up the worktree
and seeds the agent; you drive the session from there.** homestead itself does
not summarize or run checks — the agent does, inside the pane.

## Goals / Non-goals

**Goals**

- One command to go from a PR number/URL to a ready, isolated worktree with
  Claude already oriented on the PR.
- Reuse the existing worktree provisioning, herdr launch, and teardown
  machinery wholesale.
- Work for both same-repo PRs (the common case — agent-created branches) and
  cross-repo (fork) PRs, with honest limits on the latter.

**Non-goals**

- homestead computing/printing the summary or running checks itself
  (agent-driven by decision).
- Pushing commits back to a contributor's fork (`pr` refuses on cross-repo PRs).
- Posting the review back to GitHub as a PR comment (out of scope; the review
  lives in the pane). May be a future addition.
- A new teardown path — existing `kill` / `close` / `complete` already clean up
  the resulting worktree + branch by name.

## User-facing behavior

```bash
homestead review 87                                  # PR number
homestead review https://github.com/o/r/pull/87      # PR URL
homestead pr 87                                       # continue work (same-repo only)
```

- Argument accepts a bare PR number or a GitHub PR URL (mirrors `parseIssueArg`).
- Same-repo PR: worktree is created on the PR's real head branch; pushing works.
- Fork PR + `review`: read-only checkout via `refs/pull/<n>/head` into a local
  `pr-<n>` branch; review works, pushing is not wired.
- Fork PR + `pr`: refuses with a clear message:
  `✗ cross-repo PR #87 can't be continued here. Try: homestead review 87`.

Teardown afterward uses the existing commands by **branch name** (not the PR
number), e.g. `homestead kill <branch>` (review throwaway) or
`homestead close <branch>` / `homestead complete <branch>` (work you finished).
The launch output prints the branch name so it's clear what to tear down — for a
same-repo PR that's the head branch (e.g. `feat/rate-limit`), for a fork it's
`pr-<n>`. Note `homestead kill 87` would be interpreted as issue/branch `87`, not
"PR #87's worktree", so use the printed branch name.

## Architecture

A new thin module `src/pr/` orchestrates four steps; three of them are existing
functions.

### 1. Parse the PR argument — `src/pr/ref.ts` (new, pure, tested)

```ts
export interface PrRef {
  readonly number: number;
  readonly owner?: string;
  readonly repo?: string;
  readonly ghArg: string; // "87" or full PR URL
}
export const parsePrArg = (token: string): PrRef | undefined => { ... }
```

Direct analog of `parseIssueArg` in `src/issues.ts`, with the URL regex matching
`/pull/<n>` instead of `/issues/<n>`. Unit-tested the same way `parseIssueArg`
would be.

### 2. Resolve PR metadata — `src/pr/resolve.ts` (new)

```ts
const PrViewSchema = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  url: Schema.String,
  headRefName: Schema.String,
  baseRefName: Schema.String,
  isCrossRepository: Schema.Boolean,
});
export type PrView = typeof PrViewSchema.Type;

export const resolvePr = (ref: PrRef) =>
  capture("gh", ["pr", "view", ref.ghArg, "--json",
    "number,title,url,headRefName,baseRefName,isCrossRepository"])
  // decode via Schema.fromJsonString, map SchemaError -> ExternalCommandError
```

Mirrors `resolveIssue` in `src/issues.ts` exactly (same `capture` + Schema
decode + error mapping pattern).

### 3. Decide the local branch — `src/pr/branch.ts` (new, pure, tested)

A pure function decides the local branch name and how to materialize it, given
the PR metadata. This is the one piece of genuinely new logic, so it is pure and
unit-tested.

```ts
export type PrCheckout =
  | { kind: "same-repo"; branch: string }   // branch = headRefName
  | { kind: "fork"; branch: string };       // branch = `pr-${number}`

export const planPrCheckout = (pr: PrView): PrCheckout =>
  pr.isCrossRepository
    ? { kind: "fork", branch: `pr-${pr.number}` }
    : { kind: "same-repo", branch: pr.headRefName };
```

The side-effecting "ensure the local branch exists at the PR head" step lives
next to it (not unit-tested, like the rest of the git/gh side effects):

- **same-repo:** `git fetch origin <headRefName>`, then create the local branch
  **only if it doesn't already exist**:
  `git branch <headRefName> origin/<headRefName>`. If it already exists locally,
  leave it as-is and let `setupWorktree`/`git worktree add` attach to it — never
  force-reset it, to avoid clobbering unpushed local commits (an agent may have
  created this branch). The branch may then be behind origin; that matches how
  the existing `worktree` command reuses an existing branch.
- **fork:** `git fetch origin pull/<n>/head:pr-<n>` (creates/updates local
  `pr-<n>` — safe because forks aren't pushed to locally).

### 4. Provision + launch — `src/pr/provision.ts` (new)

```ts
export const launchPr = (input: {
  mode: "review" | "work";
  ref: PrRef;
  config: HomesteadConfig;
  repo: Repo;
  agent: ResolvedAgentConfig;
}) => Effect.gen(function* () {
  const pr = yield* resolvePr(input.ref);
  const checkout = planPrCheckout(pr);

  if (input.mode === "work" && checkout.kind === "fork") {
    return yield* new UsageError({ message:
      `cross-repo PR #${pr.number} can't be continued here. Try: homestead review ${pr.number}` });
  }

  yield* ensureLocalBranch(input.repo.primaryRoot, pr, checkout);

  // Reuse setupWorktree: resolveTarget already attaches to an existing branch
  // via `git worktree add <dir> <branch>` when refs/heads/<branch> exists.
  const plan = yield* setupWorktree(input.config, { create: checkout.branch }, input.repo);

  const prompt = buildPrPrompt(input.mode, pr, input.config);
  const surface = input.agent.surface ?? "worktree";
  const herdr = yield* Herdr;
  const paneId = yield* herdr.createSurface(surface, plan.targetDir, `pr-${pr.number}`);
  yield* launchAndSeed(paneId, toSpec(input.agent), prompt, {
    readyTimeoutMs: input.agent.readyTimeoutMs,
  });
});
```

**Reuse map:**

| Step | Reused from |
|---|---|
| Worktree provisioning (env, ports, services, setup) | `setupWorktree` (`worktree/index.ts`) |
| Attach worktree to existing branch | `resolveTarget` (`worktree/plan.ts:110`) — already handles `refs/heads/<branch>` exists |
| Launch agent + seed prompt | `launchAndSeed` + `toSpec` (`herdr/launch.ts`) |
| Agent defaults (command, trust prompt, ready marker) | `resolveAgentDefaults` (`agent/defaults.ts`) |
| Teardown | existing `kill` / `close` / `complete` |

Note: the issue flow's `launchAgent` (`herdr/agent.ts`) is issue-specific (uses
`item.number`, `issue-<n>` surface label, `AgentPromptContext`). The PR flow
calls the lower-level `launchAndSeed` directly instead of generalizing
`launchAgent`, keeping the issue path untouched.

## Kickoff prompts

Built in `src/pr/prompt.ts`. Context is PR metadata, not a `WorkItem`:

```ts
export interface PrPromptContext {
  readonly pr: PrView;
  readonly checks?: string;        // from config.pr.checks if set
}
```

**Default review prompt** (`mode: "review"`):

> You're reviewing PR #87: "Add rate limiter" (<url>), branch
> `feat/rate-limit` → `main`. Read the diff and the surrounding code until you
> understand it. Then: (1) summarize what the PR does and why, (2) run the
> project's checks [`<config.pr.checks>` if set, else "find and run them, e.g. a
> `check`/`test` script"], (3) flag any bugs, risks, or gaps. Do not edit code —
> this is a review.

**Default work prompt** (`mode: "work"`):

> You're continuing PR #87: "Add rate limiter" (<url>), branch
> `feat/rate-limit` → `main`. Read the diff and the surrounding code to see
> what's been done and what's left. Run the project's checks [`<checks>` / infer],
> then keep working: fix failures, address review feedback, and commit. Show me
> your plan before large changes.

Both default prompts are overridable via config (below).

## Config

Add an optional `pr` block, following the existing `agent` / `issues` split
(data schema for serializable scalars in `config-schema.ts`; function overrides
layered in `types.ts`).

`src/config-schema.ts`:

```ts
export const PrConfigDataSchema = Schema.Struct({
  checks: Schema.optional(Schema.String), // e.g. "bun run check"
});
export type PrConfigData = typeof PrConfigDataSchema.Type;
// add `pr: Schema.optional(PrConfigDataSchema)` to ConfigDataSchema
```

`src/types.ts`:

```ts
export interface PrConfig extends PrConfigData {
  readonly reviewPrompt?: (ctx: PrPromptContext) => string;
  readonly workPrompt?: (ctx: PrPromptContext) => string;
}
// add `readonly pr?: PrConfig` to HomesteadConfig
```

`config.pr.checks` is interpolated verbatim into the prompt when present;
otherwise the prompt tells Claude to find and run the checks itself. Defaults
ship for both prompts, so the `pr` block is entirely optional.

## CLI wiring (`src/cli.ts`)

Add a `prTarget` argument (PR number or URL → `PrRef`, via `parsePrArg`,
mirroring the existing `issueRef` `Argument.filterMap`), then two commands:

```ts
const reviewCommand = Command.make("review", { ref: prTarget }, ({ ref }) =>
  Effect.gen(function* () {
    const repo = yield* resolveRepo();
    const config = yield* loadConfig(repo.primaryRoot);
    const agent = yield* requireAgentConfig(config.agent).pipe(
      Effect.catchTag("UsageError", (e) => fail(e.message)));
    yield* launchPr({ mode: "review", ref, config, repo, agent })
      .pipe(Effect.catchTag("UsageError", (e) => fail(e.message)));
  })).pipe(Command.withDescription("pull a PR into a worktree; Claude summarizes + runs checks"));

const prCommand = Command.make("pr", { ref: prTarget }, ({ ref }) =>
  /* same, mode: "work" */ ).pipe(
  Command.withDescription("pull a PR into a worktree; Claude continues the work"));
```

Register both in `Command.withSubcommands([...])`. Single-PR argument (not
`atLeast(1)`) to start — multi-PR fan-out can come later if wanted.

## Error handling

- **PR not found / `gh` not authed:** `gh pr view` fails → mapped to
  `ExternalCommandError` (same as `resolveIssue`), surfaced by the existing
  top-level `catchTags` in `cli.ts`.
- **`pr` on a cross-repo PR:** `UsageError` with the
  `Try: homestead review <n>` hint; caught and printed via the existing `fail`.
- **No `agent` config block:** reuse `requireAgentConfig` — same message the
  issue flow gives.
- **git fetch / worktree-add failures:** surface via the existing `run` helper,
  matching the worktree flow's behavior.

## Testing

Mirror the existing test style (pure functions only; git/gh/herdr side effects
are not unit-tested anywhere in the codebase):

- `src/pr/ref.test.ts` — `parsePrArg`: bare number, full URL, `/pull/` vs
  `/issues/` discrimination, garbage → `undefined`.
- `src/pr/branch.test.ts` — `planPrCheckout`: same-repo → head branch;
  cross-repo → `pr-<n>`.

`bun run check` (typecheck + tests) must pass.

## File-level change list

| File | Change |
|---|---|
| `src/pr/ref.ts` | new — `parsePrArg`, `PrRef` |
| `src/pr/resolve.ts` | new — `resolvePr`, `PrViewSchema` |
| `src/pr/branch.ts` | new — `planPrCheckout`, `ensureLocalBranch` |
| `src/pr/prompt.ts` | new — `PrPromptContext`, default review/work prompts, `buildPrPrompt` |
| `src/pr/provision.ts` | new — `launchPr` orchestration |
| `src/pr/ref.test.ts` | new — parser tests |
| `src/pr/branch.test.ts` | new — checkout-decision tests |
| `src/config-schema.ts` | add `PrConfigData` + `pr` field |
| `src/types.ts` | add `PrConfig` + `HomesteadConfig.pr` |
| `src/cli.ts` | add `prTarget`, `reviewCommand`, `prCommand`, register them |
| `README.md` | document `review` / `pr` in the command cheatsheet |
| `homestead.config.example.ts` | show an example `pr` block |

## Open questions

None blocking. Possible future work: post the review back as a PR comment;
multi-PR fan-out; pushing to forks when maintainer-edits is allowed.
