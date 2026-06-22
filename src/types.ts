import type { Effect, FileSystem, Path } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";

// The ambient platform services every githog effect runs against. BunServices.layer
// satisfies this in full, so config authors writing an `afterSetup` hook never have
// to provide anything — they just `yield*` FileSystem / Path / a subprocess.
export type GithogServices =
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner;

// A unit of work fanned out by `implement-issues`. Today these come from GitHub
// (gh issue view); the shape is deliberately small so other sources could feed it.
export interface WorkItem {
  readonly number: number;
  readonly url: string;
  readonly title: string;
}

// Read-only view of the worktree being provisioned, handed to config functions
// (`env.derive`, `afterSetup`). `env(key)` reads the SOURCE .env body (the primary
// checkout's .env we copied from), which is what derive rules key off of.
export interface WorktreeContext {
  readonly slug: string;
  readonly branch: string;
  readonly targetDir: string;
  readonly primaryRoot: string;
  readonly repoName: string;
  readonly env: (key: string) => string | undefined;
}

// One env key that must be unique per worktree, allocated by scanning every
// sibling worktree's .env and taking the lowest free value >= base. Generalizes
// worktree-setup.ts's hardcoded PORT (3000) / CLIENT_PORT (5173).
export interface PortSpec {
  readonly key: string;
  readonly base: number;
}

// A TCP dependency (e.g. the shared docker Postgres) that must accept connections
// before setup commands run. `start` is the command to bring it up if it's down.
export interface ServiceSpec {
  readonly name: string;
  readonly host: string;
  readonly port: number;
  readonly start?: ReadonlyArray<string> | undefined;
  readonly timeoutMs?: number | undefined;
}

// An ordered provisioning command (install, migrate, seed…). Tokens {{slug}},
// {{branch}}, {{targetDir}}, {{primaryRoot}}, {{repoName}} and {{env:KEY}} (a value
// from the computed worktree env) are substituted into each argv element.
// `injectEnv` lists computed-env keys to set in the child's environment so they
// beat any baked-in --env-file (the DATABASE_URL trick from worktree-setup.ts).
// `fatal: false` warns-and-continues on a non-zero exit (db:seed today).
export interface SetupStep {
  readonly label: string;
  readonly run: ReadonlyArray<string>;
  readonly cwd?: string | undefined;
  readonly injectEnv?: ReadonlyArray<string> | undefined;
  readonly fatal?: boolean | undefined;
}

export interface EnvConfig {
  readonly source?: string | undefined; // body to copy from primary checkout (default ".env")
  readonly fallback?: string | undefined; // used only if source is missing (default ".env.example")
  readonly derive?: ((ctx: WorktreeContext) => Record<string, string>) | undefined;
}

// `githog listen` — poll the repo and auto-implement issues that carry the
// trigger label. The label is the queue: githog claims an issue by swapping it
// from `label` to the issues.label ("agent:wip") so it isn't picked up twice.
export interface ListenConfig {
  readonly label?: string | undefined; // trigger label (default "agent:ready")
  readonly intervalSeconds?: number | undefined; // poll cadence (default 30)
  readonly maxConcurrent?: number | undefined; // max active agents, counted by agent:wip (default 3)
}

// Context handed to a `loop.planPrompt` / `loop.iterationPrompt` override so a
// repo can build its own prompt text while still seeing the runtime's resolved
// task-file name and sentinel tokens.
export interface LoopPromptContext {
  readonly item: WorkItem;
  readonly taskFile: string;
  readonly completionSentinel: string;
  readonly blockedTag: string;
  // The review pass's signals (ADR-0003), so a `reviewPrompt` override can tell the
  // reviewer which tokens to emit for a clean diff vs appended findings.
  readonly reviewCleanSentinel: string;
  readonly reviewFindingsSentinel: string;
}

// The agent loop's knobs (per ADR-0001). githog drives the agent headlessly: a
// one-shot plan pass decomposes the issue into `taskFile`, then iterations pick
// the next task until the agent emits `completionSentinel` (→ PR + agent:review)
// or hits `maxIterations` / emits a `<blockedTag>` sentinel (→ agent:blocked).
export interface LoopConfig {
  readonly maxIterations?: number | undefined; // backstop cap on iterations (default 25)
  readonly completionSentinel?: string | undefined; // default "<promise>COMPLETE</promise>"
  readonly blockedTag?: string | undefined; // <tag>reason</tag> the agent emits (default "blocked")
  readonly planSkill?: string | undefined; // skill invoked for the plan pass (default "githog-plan")
  readonly implementSkill?: string | undefined; // skill invoked per iteration (default "githog-implement")
  readonly taskFile?: string | undefined; // durable cross-iteration task list (default "TASKS.md")
  // Continuity (ADR-0002), default false. false keeps ADR-0001 amnesia: every
  // iteration is a fresh claude context and `taskFile` is the only memory. true
  // resumes the prior claude session each iteration so context carries forward —
  // opt in per project to trade the clean-context quality floor for continuity.
  readonly resume?: boolean | undefined;
  // Review-converge (ADR-0003), all optional, all defaulting to today's behaviour.
  // The whole feature is off until `review` is set true.
  readonly review?: boolean | undefined; // master opt-in (default false => builder Complete opens the PR as now)
  readonly verifyCommand?: ReadonlyArray<string> | undefined; // deterministic machine gate (unset => review-only, no gate)
  readonly reviewSkill?: string | undefined; // fresh-context reviewer skill (default "githog-review")
  readonly maxReviewRounds?: number | undefined; // convergence cap before agent:blocked (default 3)
  readonly reviewCleanSentinel?: string | undefined; // default "<review>CLEAN</review>"
  readonly reviewFindingsSentinel?: string | undefined; // default "<review>FINDINGS</review>"
  // Override the built-in prompt text. When set, used verbatim instead of the
  // `/<skill>`-or-fallback prompt the runner builds.
  readonly planPrompt?: ((ctx: LoopPromptContext) => string) | undefined;
  readonly iterationPrompt?: ((ctx: LoopPromptContext) => string) | undefined;
  readonly reviewPrompt?: ((ctx: LoopPromptContext) => string) | undefined;
}

export interface AgentConfig {
  readonly command?: ReadonlyArray<string> | undefined; // default ["claude"]
  // herdr surface for each agent (default "worktree"): "worktree" nests the agent
  // under the repo's workspace, "workspace" makes a flat top-level one, "tab" adds
  // a tab to the parent workspace.
  readonly surface?: "worktree" | "workspace" | "tab" | undefined;
  // The agent loop config (ADR-0001). Omit for sensible defaults.
  readonly loop?: LoopConfig | undefined;
  // @deprecated Superseded by the agent loop (ADR-0001). The single-shot
  // interactive "launch claude, wait for ready, type one prompt" path is gone;
  // these fields are accepted for back-compat but no longer used.
  readonly readyMarker?: string | undefined;
  readonly readyTimeoutMs?: number | undefined;
  readonly prompt?: ((item: WorkItem) => string) | undefined;
}

// Context handed to a custom `issues.comment` function when an agent starts.
export interface TrackingContext {
  readonly number: number;
  readonly url: string;
  readonly title: string;
  readonly branch: string;
  readonly worktreeDir: string;
  readonly host: string;
}

export interface IssuesConfig {
  readonly branch?: ((item: WorkItem) => string) | undefined; // default String(item.number)
  // Opt-in: reflect agent activity back onto the GitHub issue. Applied on
  // implement-issues, reversed on kill. Omit all three to never touch issues.
  readonly label?: string | undefined; // add on start (auto-created), remove on kill — e.g. "agent:wip"
  readonly assign?: boolean | undefined; // assign the gh user (@me) on start, unassign on kill
  // post a comment on start (true = default message; a function = custom). A
  // matching "stopped" comment is posted on kill.
  readonly comment?: boolean | ((ctx: TrackingContext) => string) | undefined;
  // Terminal states the agent loop swaps `label` ("agent:wip") into when it ends:
  // a completed loop opens a PR and moves to `reviewLabel`, a stuck/blocked loop
  // pushes its partial branch and moves to `blockedLabel`. Both free a listen slot.
  readonly reviewLabel?: string | undefined; // default "agent:review"
  readonly blockedLabel?: string | undefined; // default "agent:blocked"
}

// The single per-project control surface, authored as githog.config.ts via
// defineConfig. Everything worktree-setup.ts / implement-issues.ts hardcoded for
// orderservice lives here as data (ports/services/setup) or typed functions
// (derive/prompt/branch/afterSetup).
export interface GithogConfig {
  readonly worktreeDir?:
    | ((ctx: { readonly repoName: string; readonly slug: string; readonly branch: string }) => string)
    | undefined;
  readonly ports?: ReadonlyArray<PortSpec> | undefined;
  readonly env?: EnvConfig | undefined;
  readonly services?: ReadonlyArray<ServiceSpec> | undefined;
  readonly setup?: ReadonlyArray<SetupStep> | undefined;
  readonly agent?: AgentConfig | undefined;
  readonly issues?: IssuesConfig | undefined;
  readonly listen?: ListenConfig | undefined;
  // Effect escape hatch: arbitrary provisioning after the declarative setup steps,
  // with the full platform at hand. Runs before the agent launches.
  readonly afterSetup?:
    | ((ctx: WorktreeContext & { readonly plan: Plan }) => Effect.Effect<void, unknown, GithogServices>)
    | undefined;
}

// Caller surface for setupWorktree — the CLI maps argv onto this 1:1, and
// implement-issues constructs it directly (mirrors worktree-setup.ts's WorktreeOptions).
export interface WorktreeOptions {
  readonly create?: string | undefined; // branch to `git worktree add` (omit = isolate current)
  readonly from?: string | undefined; // base ref for --create
  readonly dir?: string | undefined; // worktree path override
  readonly noSetup?: boolean | undefined; // skip the config's setup steps (schema only)
  readonly dryRun?: boolean | undefined; // resolve + print the plan, change nothing
}

// Everything the execution phase needs, decided up front so --dry-run can print
// the exact plan it would carry out. The generalized form of worktree-setup.ts's Plan.
export interface Plan {
  readonly targetDir: string;
  readonly branch: string;
  readonly slug: string;
  readonly envPath: string;
  readonly sourcePath: string;
  readonly sourceContent: string;
  readonly reusedExistingEnv: boolean;
  readonly fellBackToExample: boolean;
  // every owned key -> value written into the worktree .env (ports + derived)
  readonly envEdits: ReadonlyArray<readonly [string, string]>;
}
