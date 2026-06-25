# `homestead pr` + `homestead review` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two subcommands that pull a GitHub PR into an isolated worktree and launch Claude Code in a herdr pane, seeded with a review or continue-work kickoff prompt.

**Architecture:** A thin new `src/pr/` module orchestrates: parse PR arg → `gh pr view` → ensure a local branch at the PR head → reuse the existing `setupWorktree` → open a herdr surface and `launchAndSeed` the agent. homestead does not summarize or run checks itself; the agent does, inside the pane. The issue flow is untouched.

**Tech Stack:** Bun, TypeScript, Effect v4 (`effect`, `effect/unstable/cli`), the `gh` CLI and `git` invoked as subprocesses.

## Global Constraints

- Use **Bun**, not Node: `bun test`, `bun run typecheck`, `bun run check`. Bun loads `.env` automatically.
- **Effect v4** (`effect@4.0.0-beta.85`). Schema is `effect/Schema`; CLI is `effect/unstable/cli`. Never install `@effect/schema` or `@effect/cli`.
- Mirror existing patterns exactly: subprocess calls go through `capture` / `run` / `runExit` from `src/process.ts`; never call a child process directly.
- `gh` and `git` side effects are **not** unit-tested anywhere in this codebase. Do not invent mocking infrastructure. Pure functions get real tests; side-effecting code is verified by `bun run typecheck` and CLI smoke tests.
- Every commit message ends with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Work on branch `feat/pr-review-commands` (already created; the design spec is committed there).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/pr/ref.ts` | Parse a PR number / URL into `PrRef` (pure) |
| `src/pr/resolve.ts` | `gh pr view` → validated `PrView` |
| `src/pr/branch.ts` | Decide the local branch (`planPrCheckout`, pure) + materialize it (`ensureLocalBranch`) |
| `src/pr/prompt.ts` | Build the review/work kickoff prompts |
| `src/pr/provision.ts` | `launchPr` — the orchestration |
| `src/pr/*.test.ts` | Unit tests for the pure functions |
| `src/config-schema.ts` | Add `PrConfigData` schema + `pr` field |
| `src/types.ts` | Add `PrPromptContext`, `PrConfig`, `HomesteadConfig.pr` |
| `src/config.ts` | Merge the `pr` block (data + function overrides) |
| `src/cli.ts` | `prRefArg`, `reviewCommand`, `prCommand`, register them |
| `README.md`, `homestead.config.example.ts` | Docs |

---

## Task 1: PR argument parser

**Files:**
- Create: `src/pr/ref.ts`
- Test: `src/pr/ref.test.ts`

**Interfaces:**
- Produces: `interface PrRef { readonly number: number; readonly owner?: string; readonly repo?: string; readonly ghArg: string }` and `parsePrArg(token: string): PrRef | undefined`

- [ ] **Step 1: Write the failing test**

Create `src/pr/ref.test.ts`:

```ts
import { expect, test } from "bun:test";
import { parsePrArg } from "./ref.ts";

test("parsePrArg parses a bare number", () => {
  expect(parsePrArg("87")).toEqual({ number: 87, ghArg: "87" });
});

test("parsePrArg parses a full PR URL", () => {
  expect(parsePrArg("https://github.com/o/r/pull/87")).toEqual({
    number: 87,
    owner: "o",
    repo: "r",
    ghArg: "https://github.com/o/r/pull/87",
  });
});

test("parsePrArg rejects an issue URL", () => {
  expect(parsePrArg("https://github.com/o/r/issues/87")).toBeUndefined();
});

test("parsePrArg rejects garbage", () => {
  expect(parsePrArg("not-a-pr")).toBeUndefined();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/pr/ref.test.ts`
Expected: FAIL — `Cannot find module './ref.ts'`.

- [ ] **Step 3: Write the implementation**

Create `src/pr/ref.ts`:

```ts
export interface PrRef {
  readonly number: number;
  readonly owner?: string;
  readonly repo?: string;
  readonly ghArg: string;
}

const PR_URL = /^(?:https?:\/\/)?github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/i;

export const parsePrArg = (token: string): PrRef | undefined => {
  if (/^\d+$/.test(token)) {
    return { number: Number(token), ghArg: token };
  }
  const match = PR_URL.exec(token);
  if (match === null) return undefined;
  const [, owner, repo, n] = match;
  return { number: Number(n), owner, repo, ghArg: `https://github.com/${owner}/${repo}/pull/${n}` };
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/pr/ref.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/pr/ref.ts src/pr/ref.test.ts
git commit -m "$(printf 'feat(pr): parse PR number / URL into PrRef\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 2: PR metadata resolver

**Files:**
- Create: `src/pr/resolve.ts`

**Interfaces:**
- Consumes: `PrRef` (Task 1); `capture` from `src/process.ts`; `ExternalCommandError` from `src/errors.ts`.
- Produces: `PrViewSchema`, `type PrView = { number: number; title: string; url: string; headRefName: string; baseRefName: string; isCrossRepository: boolean }`, and `resolvePr(ref: PrRef): Effect<PrView, ExternalCommandError, ChildProcessSpawner>`.

This task wraps `gh pr view`, a side effect. There is no mock harness in this codebase — verify with `bun run typecheck`, not a unit test. It mirrors `resolveIssue` in `src/issues.ts` exactly.

- [ ] **Step 1: Write the implementation**

Create `src/pr/resolve.ts`:

```ts
import { Effect, Schema } from "effect";
import { ExternalCommandError } from "../errors.ts";
import { capture } from "../process.ts";
import type { PrRef } from "./ref.ts";

export const PrViewSchema = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  url: Schema.String,
  headRefName: Schema.String,
  baseRefName: Schema.String,
  isCrossRepository: Schema.Boolean,
});
export type PrView = typeof PrViewSchema.Type;

export const resolvePr = Effect.fn("homestead/resolve-pr")(function* (ref: PrRef) {
  const json = yield* capture("gh", [
    "pr",
    "view",
    ref.ghArg,
    "--json",
    "number,title,url,headRefName,baseRefName,isCrossRepository",
  ]);
  const view: PrView = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PrViewSchema))(json).pipe(
    Effect.catchTag(
      "SchemaError",
      (error) => new ExternalCommandError({ command: "gh pr view", detail: error.message }),
    ),
  );
  return view;
});
```

- [ ] **Step 2: Verify it typechecks**

Run: `bun run typecheck`
Expected: exit 0, no errors referencing `src/pr/resolve.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/pr/resolve.ts
git commit -m "$(printf 'feat(pr): resolve PR metadata via gh pr view\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 3: PR checkout decision + local branch

**Files:**
- Create: `src/pr/branch.ts`
- Test: `src/pr/branch.test.ts`

**Interfaces:**
- Consumes: `PrView` (Task 2); `run` from `src/process.ts`; `refExists` from `src/worktree/base-ref.ts`.
- Produces:
  - `type PrCheckout = { readonly kind: "same-repo"; readonly branch: string } | { readonly kind: "fork"; readonly branch: string }`
  - `planPrCheckout(pr: PrView): PrCheckout` (pure)
  - `ensureLocalBranch(primaryRoot: string, pr: PrView, checkout: PrCheckout): Effect<void, never, ChildProcessSpawner>`

`planPrCheckout` is pure → TDD. `ensureLocalBranch` is a git side effect → typecheck only.

- [ ] **Step 1: Write the failing test for `planPrCheckout`**

Create `src/pr/branch.test.ts`:

```ts
import { expect, test } from "bun:test";
import { planPrCheckout } from "./branch.ts";
import type { PrView } from "./resolve.ts";

const base: PrView = {
  number: 87,
  title: "Add rate limiter",
  url: "https://github.com/o/r/pull/87",
  headRefName: "feat/rate-limit",
  baseRefName: "main",
  isCrossRepository: false,
};

test("planPrCheckout uses the head branch for same-repo PRs", () => {
  expect(planPrCheckout(base)).toEqual({ kind: "same-repo", branch: "feat/rate-limit" });
});

test("planPrCheckout uses pr-<n> for cross-repo PRs", () => {
  expect(planPrCheckout({ ...base, isCrossRepository: true })).toEqual({ kind: "fork", branch: "pr-87" });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/pr/branch.test.ts`
Expected: FAIL — `Cannot find module './branch.ts'`.

- [ ] **Step 3: Write the implementation**

Create `src/pr/branch.ts`:

```ts
import { Effect } from "effect";
import { run } from "../process.ts";
import { refExists } from "../worktree/base-ref.ts";
import type { PrView } from "./resolve.ts";

export type PrCheckout =
  | { readonly kind: "same-repo"; readonly branch: string }
  | { readonly kind: "fork"; readonly branch: string };

export const planPrCheckout = (pr: PrView): PrCheckout =>
  pr.isCrossRepository
    ? { kind: "fork", branch: `pr-${pr.number}` }
    : { kind: "same-repo", branch: pr.headRefName };

// Make sure a local branch points at the PR head, so setupWorktree can attach a
// worktree to it. Same-repo: fetch the head and create the branch only if it's
// missing (never force-reset — an agent may have unpushed commits on it). Fork:
// force-update a throwaway pr-<n> branch from the pull ref (safe; not pushed to).
export const ensureLocalBranch = Effect.fn("homestead/ensure-pr-branch")(function* (
  primaryRoot: string,
  pr: PrView,
  checkout: PrCheckout,
) {
  if (checkout.kind === "fork") {
    yield* run(
      "git fetch (pr head)",
      "git",
      ["fetch", "origin", `+pull/${pr.number}/head:${checkout.branch}`],
      { cwd: primaryRoot },
    );
    return;
  }

  yield* run("git fetch", "git", ["fetch", "origin", pr.headRefName], { cwd: primaryRoot });
  const exists = yield* refExists(primaryRoot, `refs/heads/${checkout.branch}`);
  if (!exists) {
    yield* run("git branch", "git", ["branch", checkout.branch, `origin/${pr.headRefName}`], {
      cwd: primaryRoot,
    });
  }
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/pr/branch.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Verify the whole project typechecks**

Run: `bun run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/pr/branch.ts src/pr/branch.test.ts
git commit -m "$(printf 'feat(pr): decide PR checkout branch + materialize it\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 4: Config plumbing for the `pr` block

**Files:**
- Modify: `src/config-schema.ts`
- Modify: `src/types.ts`
- Modify: `src/config.ts`
- Test: `src/config.test.ts`

**Interfaces:**
- Produces:
  - `PrConfigDataSchema`, `type PrConfigData = { checks?: string }`, `PR_DATA_FIELDS` (in `config-schema.ts`)
  - `interface PrPromptContext { readonly pr: PrView; readonly checks?: string }` (in `types.ts`)
  - `interface PrConfig extends PrConfigData { readonly reviewPrompt?: (ctx: PrPromptContext) => string; readonly workPrompt?: (ctx: PrPromptContext) => string }` and `HomesteadConfig.pr?: PrConfig` (in `types.ts`)
- Consumes: `PrView` (Task 2); the existing `pickDefined` / `mergeOptionalSection` helpers in `config.ts`.

- [ ] **Step 1: Add the data schema**

In `src/config-schema.ts`, add after the `IssuesConfigData` block (after the `ISSUES_SCALAR_FIELDS` const, ~line 70):

```ts
export const PrConfigDataSchema = Schema.Struct({
  checks: Schema.optional(Schema.String),
});
export type PrConfigData = typeof PrConfigDataSchema.Type;
export const PR_DATA_FIELDS = ["checks"] as const satisfies ReadonlyArray<keyof PrConfigData>;
```

Then add `pr` to `ConfigDataSchema` (in the `Schema.Struct({ ... })` around line 85):

```ts
export const ConfigDataSchema = Schema.Struct({
  ports: emptyPorts,
  services: emptyServices,
  setup: emptySetup,
  env: Schema.optional(EnvConfigDataSchema),
  agent: Schema.optional(AgentConfigDataSchema),
  issues: Schema.optional(IssuesConfigDataSchema),
  pr: Schema.optional(PrConfigDataSchema),
}).pipe(Schema.annotate({ parseOptions: { errors: "all" } }));
```

- [ ] **Step 2: Add the runtime types**

In `src/types.ts`:

Add `PrConfigData` to BOTH the `import type { ... } from "./config-schema.ts"` list (lines 5-12) and the `export type { ... } from "./config-schema.ts"` re-export list (lines 15-22). Then add an import for `PrView` near the `WorkItem` import:

```ts
import type { PrView } from "./pr/resolve.ts";
```

Add these interfaces (place them next to the existing `IssuesConfig` / `TrackingContext` block, before `HomesteadConfig`):

```ts
export interface PrPromptContext {
  readonly pr: PrView;
  readonly checks?: string | undefined;
}

export interface PrConfig extends PrConfigData {
  readonly reviewPrompt?: ((ctx: PrPromptContext) => string) | undefined;
  readonly workPrompt?: ((ctx: PrPromptContext) => string) | undefined;
}
```

Add the field to `HomesteadConfig` (after `readonly issues?: IssuesConfig;`):

```ts
  readonly pr?: PrConfig;
```

- [ ] **Step 3: Merge the block in `config.ts`**

In `src/config.ts`:

Extend the import from `./config-schema.ts` (line 3) to include `PR_DATA_FIELDS`:

```ts
import { ConfigDataSchema, type ConfigData, AGENT_DATA_FIELDS, ENV_DATA_FIELDS, ISSUES_SCALAR_FIELDS, PR_DATA_FIELDS } from "./config-schema.ts";
```

In `toConfigData` (the returned object, ~line 47), add a `pr` entry after `issues`:

```ts
  pr:
    config.pr === undefined
      ? undefined
      : pickDefined(config.pr, PR_DATA_FIELDS),
```

In `mergeValidatedConfig` (the returned object, ~line 68), add a `pr` entry after `issues`:

```ts
  pr: mergeOptionalSection(config.pr, data.pr, {
    reviewPrompt: config.pr?.reviewPrompt,
    workPrompt: config.pr?.workPrompt,
  }),
```

- [ ] **Step 4: Write the test**

In `src/config.test.ts`, add a new test after the `"validateConfigShape preserves function fields"` test:

```ts
test("validateConfigShape preserves pr block (checks + prompt overrides)", () => {
  const reviewPrompt = () => "review";
  const workPrompt = () => "work";
  const config: HomesteadConfig = {
    pr: { checks: "bun run check", reviewPrompt, workPrompt },
  };
  const merged = validateConfigShape(config);
  expect(merged.pr?.checks).toBe("bun run check");
  expect(merged.pr?.reviewPrompt).toBe(reviewPrompt);
  expect(merged.pr?.workPrompt).toBe(workPrompt);
});
```

- [ ] **Step 5: Run the test + typecheck**

Run: `bun test src/config.test.ts && bun run typecheck`
Expected: all config tests PASS; typecheck exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/config-schema.ts src/types.ts src/config.ts src/config.test.ts
git commit -m "$(printf 'feat(pr): add optional pr config block (checks + prompt overrides)\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 5: Kickoff prompts

**Files:**
- Create: `src/pr/prompt.ts`
- Test: `src/pr/prompt.test.ts`

**Interfaces:**
- Consumes: `PrView` (Task 2); `HomesteadConfig`, `PrPromptContext` (Task 4).
- Produces: `buildPrPrompt(mode: "review" | "work", pr: PrView, config: HomesteadConfig): string` (plus `defaultReviewPrompt` / `defaultWorkPrompt`).

- [ ] **Step 1: Write the failing test**

Create `src/pr/prompt.test.ts`:

```ts
import { expect, test } from "bun:test";
import { buildPrPrompt } from "./prompt.ts";
import type { PrView } from "./resolve.ts";
import type { HomesteadConfig } from "../types.ts";

const pr: PrView = {
  number: 87,
  title: "Add rate limiter",
  url: "https://github.com/o/r/pull/87",
  headRefName: "feat/rate-limit",
  baseRefName: "main",
  isCrossRepository: false,
};

test("review prompt summarizes, names the configured checks, and forbids editing", () => {
  const config: HomesteadConfig = { pr: { checks: "bun run check" } };
  const out = buildPrPrompt("review", pr, config);
  expect(out).toContain("reviewing PR #87");
  expect(out).toContain("bun run check");
  expect(out).toContain("Do not edit code");
});

test("review prompt without configured checks tells Claude to find them", () => {
  const out = buildPrPrompt("review", pr, {});
  expect(out).toContain("Find and run the project's checks");
});

test("work prompt is about continuing the PR", () => {
  const out = buildPrPrompt("work", pr, {});
  expect(out).toContain("continuing PR #87");
  expect(out).not.toContain("Do not edit code");
});

test("config reviewPrompt override wins", () => {
  const config: HomesteadConfig = { pr: { reviewPrompt: (ctx) => `CUSTOM ${ctx.pr.number}` } };
  expect(buildPrPrompt("review", pr, config)).toBe("CUSTOM 87");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/pr/prompt.test.ts`
Expected: FAIL — `Cannot find module './prompt.ts'`.

- [ ] **Step 3: Write the implementation**

Create `src/pr/prompt.ts`:

```ts
import type { HomesteadConfig, PrPromptContext } from "../types.ts";
import type { PrView } from "./resolve.ts";

const checkInstruction = (checks: string | undefined): string =>
  checks
    ? `Run the project's checks (\`${checks}\`)`
    : "Find and run the project's checks (e.g. a `check` or `test` script in package.json)";

const header = (verb: string, pr: PrView): string =>
  `You're ${verb} PR #${pr.number}: "${pr.title}"\n${pr.url}\n` +
  `branch \`${pr.headRefName}\` → \`${pr.baseRefName}\`.\n\n`;

export const defaultReviewPrompt = (ctx: PrPromptContext): string =>
  header("reviewing", ctx.pr) +
  `Read the diff and the surrounding code until you understand it, then:\n` +
  `1. Summarize what the PR does and why.\n` +
  `2. ${checkInstruction(ctx.checks)}.\n` +
  `3. Flag any bugs, risks, or gaps.\n\n` +
  `Do not edit code — this is a review.`;

export const defaultWorkPrompt = (ctx: PrPromptContext): string =>
  header("continuing", ctx.pr) +
  `Read the diff and the surrounding code to see what's done and what's left. ` +
  `${checkInstruction(ctx.checks)}, then keep working: fix failures, address review ` +
  `feedback, and commit. Show me your plan before large changes.`;

export const buildPrPrompt = (
  mode: "review" | "work",
  pr: PrView,
  config: HomesteadConfig,
): string => {
  const ctx: PrPromptContext = { pr, checks: config.pr?.checks };
  if (mode === "review") return (config.pr?.reviewPrompt ?? defaultReviewPrompt)(ctx);
  return (config.pr?.workPrompt ?? defaultWorkPrompt)(ctx);
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/pr/prompt.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/pr/prompt.ts src/pr/prompt.test.ts
git commit -m "$(printf 'feat(pr): review/work kickoff prompts\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 6: `launchPr` orchestration

**Files:**
- Create: `src/pr/provision.ts`

**Interfaces:**
- Consumes: `resolvePr` (Task 2); `planPrCheckout`, `ensureLocalBranch` (Task 3); `buildPrPrompt` (Task 5); `setupWorktree` + `Repo` from `src/worktree/index.ts`; `launchAndSeed`, `toSpec` from `src/herdr/launch.ts`; `Herdr` from `src/herdr/service.ts`; `UsageError` from `src/errors.ts`; `AgentConfig`, `HomesteadConfig` from `src/types.ts`; `PrRef` from `./ref.ts`.
- Produces: `launchPr(input: LaunchPrInput): Effect<void, UsageError | ExternalCommandError | ConfigInvalid | ServiceUnavailable | HerdrError | HerdrNotAvailable | HerdrTimeout, HomesteadServices>` where `LaunchPrInput = { mode: "review" | "work"; ref: PrRef; config: HomesteadConfig; repo: Repo; agent: AgentConfig }`.

Side-effecting orchestration → verify with `bun run typecheck` (no unit test). The fork-refusal branch is exercised by the CLI smoke test in Task 7.

- [ ] **Step 1: Write the implementation**

Create `src/pr/provision.ts`:

```ts
import { Console, Effect } from "effect";
import { UsageError } from "../errors.ts";
import { Herdr } from "../herdr/service.ts";
import { launchAndSeed, toSpec } from "../herdr/launch.ts";
import type { AgentConfig, HomesteadConfig } from "../types.ts";
import { setupWorktree, type Repo } from "../worktree/index.ts";
import { ensureLocalBranch, planPrCheckout } from "./branch.ts";
import { buildPrPrompt } from "./prompt.ts";
import type { PrRef } from "./ref.ts";
import { resolvePr } from "./resolve.ts";

export interface LaunchPrInput {
  readonly mode: "review" | "work";
  readonly ref: PrRef;
  readonly config: HomesteadConfig;
  readonly repo: Repo;
  readonly agent: AgentConfig;
}

export const launchPr = Effect.fn("homestead/launch-pr")(function* (input: LaunchPrInput) {
  const { mode, ref, config, repo, agent } = input;

  const pr = yield* resolvePr(ref);
  const checkout = planPrCheckout(pr);

  if (mode === "work" && checkout.kind === "fork") {
    return yield* new UsageError({
      message:
        `[homestead] cross-repo PR #${pr.number} can't be continued here. ` +
        `Try: homestead review ${pr.number}`,
    });
  }

  yield* Console.log(
    `\n▸ ${mode === "review" ? "Reviewing" : "Continuing"} PR #${pr.number}: ${pr.title}`,
  );

  yield* ensureLocalBranch(repo.primaryRoot, pr, checkout);

  // setupWorktree attaches a worktree to checkout.branch: resolveTarget sees
  // refs/heads/<branch> exists (we just ensured it) and runs `git worktree add
  // <dir> <branch>` instead of creating a new branch.
  const plan = yield* setupWorktree(config, { create: checkout.branch }, repo);

  const prompt = buildPrPrompt(mode, pr, config);
  const surface = agent.surface ?? "worktree";
  const herdr = yield* Herdr;
  const paneId = yield* herdr.createSurface(surface, plan.targetDir, `pr-${pr.number}`);
  yield* launchAndSeed(paneId, toSpec(agent), prompt, { readyTimeoutMs: agent.readyTimeoutMs });

  yield* Console.log(
    `  ✓ PR #${pr.number} ready on \`${checkout.branch}\` in herdr pane ${paneId} — switch in to drive it.\n` +
      `    Tear down with: homestead ${mode === "review" ? "kill" : "close"} ${checkout.branch}`,
  );
});
```

- [ ] **Step 2: Verify it typechecks**

Run: `bun run typecheck`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/pr/provision.ts
git commit -m "$(printf 'feat(pr): launchPr orchestration (resolve, checkout, worktree, agent)\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 7: CLI wiring

**Files:**
- Modify: `src/cli.ts`

**Interfaces:**
- Consumes: `parsePrArg` (Task 1); `launchPr` (Task 6); existing `resolveRepo`, `loadConfig`, `requireAgentConfig`, `fail`, `Herdr` plumbing already imported in `cli.ts`.
- Produces: `review` and `pr` subcommands registered on the `homestead` command.

- [ ] **Step 1: Add imports**

In `src/cli.ts`, add near the existing PR-flow imports:

```ts
import { parsePrArg } from "./pr/ref.ts";
import { launchPr } from "./pr/provision.ts";
```

- [ ] **Step 2: Add the `prRefArg` argument**

After the existing `issueRef` argument definition (~line 36), add:

```ts
const prRefArg = Argument.string("pr").pipe(
  Argument.filterMap(
    (token) => {
      const ref = parsePrArg(token);
      return ref === undefined ? Option.none() : Option.some(ref);
    },
    (token) => `[homestead] '${token}' is not a PR number or GitHub PR URL.`,
  ),
  Argument.withDescription("PR number or GitHub PR URL"),
);
```

- [ ] **Step 3: Add the two commands**

After `completeCommand` (and before the `const homestead = ...` definition), add:

```ts
const reviewCommand = Command.make(
  "review",
  { ref: prRefArg },
  ({ ref }) =>
    Effect.gen(function* () {
      const repo = yield* resolveRepo();
      const config = yield* loadConfig(repo.primaryRoot);
      const agent = yield* requireAgentConfig(config.agent).pipe(
        Effect.catchTag("UsageError", (e) => fail(e.message)),
      );
      yield* launchPr({ mode: "review", ref, config, repo, agent }).pipe(
        Effect.catchTags({
          UsageError: (e) => fail(e.message),
          HerdrError: (e) => fail(`[homestead] couldn't open the PR in herdr (${e.op})`),
          HerdrNotAvailable: (e) => fail(e.reason),
          HerdrTimeout: (e) => fail(`[homestead] agent never reached ready (${e.marker})`),
        }),
      );
    }),
).pipe(Command.withDescription("pull a PR into a worktree; Claude summarizes + runs checks (read-only)"));

const prCommand = Command.make(
  "pr",
  { ref: prRefArg },
  ({ ref }) =>
    Effect.gen(function* () {
      const repo = yield* resolveRepo();
      const config = yield* loadConfig(repo.primaryRoot);
      const agent = yield* requireAgentConfig(config.agent).pipe(
        Effect.catchTag("UsageError", (e) => fail(e.message)),
      );
      yield* launchPr({ mode: "work", ref, config, repo, agent }).pipe(
        Effect.catchTags({
          UsageError: (e) => fail(e.message),
          HerdrError: (e) => fail(`[homestead] couldn't open the PR in herdr (${e.op})`),
          HerdrNotAvailable: (e) => fail(e.reason),
          HerdrTimeout: (e) => fail(`[homestead] agent never reached ready (${e.marker})`),
        }),
      );
    }),
).pipe(Command.withDescription("pull a PR into a worktree; Claude continues the work (same-repo only)"));
```

- [ ] **Step 4: Register the commands**

Update the `Command.withSubcommands([...])` call to include both new commands:

```ts
  Command.withSubcommands([
    initCommand,
    worktreeCommand,
    issueCommand,
    killCommand,
    closeCommand,
    completeCommand,
    reviewCommand,
    prCommand,
  ]),
```

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: exit 0.

- [ ] **Step 6: Smoke-test the help output**

Run: `bun ./src/cli.ts --help`
Expected: SUBCOMMANDS lists both `review` and `pr` with their descriptions.

Run: `bun ./src/cli.ts review --help`
Expected: USAGE shows `homestead review [flags] <pr>` and the argument description "PR number or GitHub PR URL".

- [ ] **Step 7: Run the full check suite**

Run: `bun run check`
Expected: typecheck exit 0; all tests PASS.

- [ ] **Step 8: Commit**

```bash
git add src/cli.ts
git commit -m "$(printf 'feat(pr): wire up `homestead review` and `homestead pr` commands\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 8: Documentation

**Files:**
- Modify: `README.md`
- Modify: `homestead.config.example.ts`

**Interfaces:** none (docs only).

- [ ] **Step 1: Update the README cheatsheet**

In `README.md`, the command block currently reads (around line 10-14):

```
homestead worktree my-feature     # branch, provision, open
homestead issue 21 22 23          # same, plus an agent in each pane
homestead close 21                # tear down, keep the branch, issue → review
homestead complete 21             # mark issue completed on GitHub, remove branch
homestead kill my-feature         # tear down everything
```

Add two lines after the `issue` line:

```
homestead worktree my-feature     # branch, provision, open
homestead issue 21 22 23          # same, plus an agent in each pane
homestead review 87               # open PR #87 in a worktree; Claude reviews it
homestead pr 87                   # open PR #87 in a worktree; Claude continues it
homestead close 21                # tear down, keep the branch, issue → review
homestead complete 21             # mark issue completed on GitHub, remove branch
homestead kill my-feature         # tear down everything
```

- [ ] **Step 2: Add an example `pr` block to the config example**

In `homestead.config.example.ts`, add this block after the `agent: { ... }` block (before the closing `});`):

```ts
  // `homestead review <pr>` / `homestead pr <pr>` pull a PR into a worktree and
  // seed Claude with a kickoff prompt (review = summarize + run checks + flag
  // risks; pr = continue the work). All optional — defaults ship.
  pr: {
    checks: "bun run check", // named in the kickoff prompt; omit to let Claude infer
    // reviewPrompt: ({ pr, checks }) => `Review PR #${pr.number} (${pr.url}).`,
    // workPrompt: ({ pr }) => `Continue PR #${pr.number} (${pr.url}).`,
  },
```

- [ ] **Step 3: Verify the example config still typechecks**

Run: `bun run typecheck`
Expected: exit 0 (the example file is part of the project — `pr.checks` and the prompt signatures must match the new types).

- [ ] **Step 4: Commit**

```bash
git add README.md homestead.config.example.ts
git commit -m "$(printf 'docs(pr): document review/pr commands + example pr config\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Final verification

- [ ] **Run the full suite:** `bun run check` → typecheck exit 0, all tests pass.
- [ ] **Help smoke test:** `bun ./src/cli.ts --help` shows `review` and `pr`.
- [ ] **(Optional, needs a real repo + gh auth) end-to-end:** from a repo with an open same-repo PR, `bun ./src/cli.ts review <n>` opens a worktree on the PR head and launches Claude; `bun ./src/cli.ts pr <n>` against a fork PR prints the cross-repo refusal pointing to `review`.

---

## Self-Review notes (already applied)

- **Spec coverage:** every spec section maps to a task — parser (T1), resolver (T2), checkout decision + branch (T3), config block (T4), prompts (T5), orchestration + fork refusal (T6), CLI + teardown messaging (T7), docs (T8).
- **No force-reset:** T3 creates the same-repo branch only when missing (spec self-review fix preserved).
- **Type consistency:** `PrView`, `PrRef`, `PrCheckout`, `PrPromptContext`, `PrConfig`, `LaunchPrInput`, and `buildPrPrompt(mode, pr, config)` use identical names/signatures across tasks.
- **Teardown:** no new code — T7's launch message tells the user the exact `kill`/`close` command with the branch name.
