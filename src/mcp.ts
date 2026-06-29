import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Console, Effect, ManagedRuntime } from "effect";
import { z } from "zod";
import { spawnAgent } from "./agent/spawn.ts";
import {
  exitCodeFor,
  parseCompactDuration,
  resolveWorktreeDir,
  waitForAgent,
  type WaitOutcome,
} from "./agent/wait.ts";
import { PENDING_JSON, resultForSlug, type AgentResult } from "./agent/result.ts";
import { loadConfig, loadConfigOrUndefined } from "./config.ts";
import { collectDashboard } from "./dashboard.ts";
import { UsageError } from "./errors.ts";
import { requireAgentConfig } from "./issue/provision.ts";
import { parseIssueArg, validateIssueRefs, type IssueRef } from "./issues.ts";
import { runLand } from "./land.ts";
import { AppLayer, type AppServices } from "./runtime.ts";
import { loadIssuesForPlan } from "./waves-cmd.ts";
import { planWaves, renderJson, type WavePlanError } from "./waves.ts";
import { resolveRepo } from "./worktree/index.ts";

// ─────────────────────────────────────────────────────────────────────────────
// homestead mcp — the orchestration surface as a stdio MCP server.
//
// Each tool WRAPS an existing function — no orchestration logic is reimplemented
// here. A tool handler builds a small Effect program (the same resolveRepo →
// loadConfig → call-the-function chain cli.ts uses), runs it against the shared
// runtime, and shapes the result into an MCP payload. The semantics each tool
// exposes (exit 0/1/2/3 from `wait`, pending/unknown from `result`, the
// touches/depends-on block `plan` consumes) are defined by docs/ORCHESTRATION.md;
// the descriptions below must stay in sync with that contract.
// ─────────────────────────────────────────────────────────────────────────────

// Runs a tool program against the server's single shared runtime. Injected into
// buildTools so tests can stub it with a fixture (no real runtime needed).
export type Runner = <A, E>(effect: Effect.Effect<A, E, AppServices>) => Promise<A>;

// A registered MCP tool: its name, human/agent-facing description, zod input
// schema (mirroring the CLI flags), and the async handler the SDK calls.
export interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodRawShape;
  readonly handler: (args: any) => Promise<CallToolResult>;
}

// ── result shaping ────────────────────────────────────────────────────────────

const ok = (data: unknown): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data) }],
});

const errorResult = (message: string): CallToolResult => ({
  content: [{ type: "text", text: message }],
  isError: true,
});

const messageOf = (e: unknown): string =>
  e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e);

// ── pure mappers (handler-mapping unit-tested directly) ───────────────────────

// `wait` returns the structured outcome AND the numeric exit code. The exit-code
// contract (done→0, failed→1, blocked→2, no-signal→3) is the whole point, so it
// must survive as a field — a process exit code has no meaning inside MCP.
export const waitPayload = (
  outcome: WaitOutcome,
): { readonly outcome: WaitOutcome; readonly exitCode: 0 | 1 | 2 | 3 } => ({
  outcome,
  exitCode: exitCodeFor(outcome),
});

// `result` returns the `_tag` plus the verbatim sentinel body; `pending` returns
// the canonical PENDING_JSON; `unknown` carries no body.
export const resultPayload = (
  result: AgentResult,
):
  | { readonly _tag: "status"; readonly body: string }
  | { readonly _tag: "pending"; readonly body: string }
  | { readonly _tag: "unknown" } => {
  switch (result._tag) {
    case "status":
      return { _tag: "status", body: result.body };
    case "pending":
      return { _tag: "pending", body: PENDING_JSON };
    case "unknown":
      return { _tag: "unknown" };
  }
};

// ── tool programs (each wraps an existing function, exactly like cli.ts) ───────

const spawnProgram = (slug: string, prompt: string) =>
  Effect.gen(function* () {
    const repo = yield* resolveRepo();
    const config = yield* loadConfig(repo.primaryRoot);
    const agent = yield* requireAgentConfig(config.agent);
    return yield* spawnAgent({
      config,
      repo,
      slug,
      prompt,
      agent,
      createdAt: new Date().toISOString(),
    });
  });

const waitProgram = (
  target: string,
  timeout: string,
  pane: string | undefined,
  poll: string,
) =>
  Effect.gen(function* () {
    const timeoutMs = parseCompactDuration(timeout);
    const pollMs = parseCompactDuration(poll);
    if (timeoutMs === undefined) {
      return yield* new UsageError({ message: `invalid timeout '${timeout}' (use e.g. 30m, 2s, 500ms)` });
    }
    if (pollMs === undefined) {
      return yield* new UsageError({ message: `invalid poll '${poll}' (use e.g. 30m, 2s, 500ms)` });
    }
    const repo = yield* resolveRepo();
    const config = yield* loadConfigOrUndefined(repo.primaryRoot);
    const worktreeDir = yield* resolveWorktreeDir(repo.repoName, target, config);
    return yield* waitForAgent({ worktreeDir, paneId: pane, timeoutMs, pollMs });
  });

const resultProgram = (slug: string) =>
  Effect.gen(function* () {
    const repo = yield* resolveRepo();
    const config = yield* loadConfigOrUndefined(repo.primaryRoot);
    return yield* resultForSlug(repo.repoName, slug, config);
  });

const lsProgram = Effect.gen(function* () {
  const repo = yield* resolveRepo();
  const config = yield* loadConfigOrUndefined(repo.primaryRoot);
  return yield* collectDashboard(repo, config);
});

const landProgram = (
  branches: ReadonlyArray<string>,
  complete: boolean,
  keepRemote: boolean,
  allowSpawned: boolean,
) =>
  Effect.gen(function* () {
    const repo = yield* resolveRepo();
    const config = yield* loadConfigOrUndefined(repo.primaryRoot);
    return yield* runLand(repo.primaryRoot, repo.repoName, branches, config, {
      complete,
      keepRemote,
      allowSpawned,
    });
  });

const planProgram = (refs: ReadonlyArray<IssueRef>) =>
  Effect.gen(function* () {
    yield* validateIssueRefs(refs);
    const issues = yield* loadIssuesForPlan(refs);
    // planWaves throws WavePlanError (pure code) on a dangling depends-on or a
    // cycle; surface it through the typed channel so the handler reports it.
    const schedule = yield* Effect.try({
      try: () => planWaves(issues),
      catch: (e) => e as WavePlanError,
    });
    // Reuse the canonical JSON serializer (the documented { waves, integrate,
    // warnings } shape) so the MCP contract matches `homestead plan --json`.
    return JSON.parse(renderJson(schedule)) as unknown;
  });

// ── tool registry ─────────────────────────────────────────────────────────────

// Build the six tool defs against an injected runner. A handler delegates to its
// program via `run`, then maps the result into an MCP payload. Errors (typed
// failures from the wrapped functions, bad issue refs) become `isError` results
// instead of crashing the server.
export const buildTools = (run: Runner): ReadonlyArray<ToolDef> => {
  const guard = (build: () => Promise<unknown>): Promise<CallToolResult> =>
    build().then(ok, (e) => errorResult(messageOf(e)));

  return [
    {
      name: "spawn",
      description:
        "Provision an issue-less worktree and boot an agent on a free-form prompt (wraps `agent spawn`). Returns the worktree Plan (slug, branch, targetDir).",
      inputSchema: {
        slug: z.string().describe("worktree / branch name for the spawned agent"),
        prompt: z.string().describe("prompt to seed the agent with"),
      },
      handler: ({ slug, prompt }) => guard(() => run(spawnProgram(slug, prompt))),
    },
    {
      name: "wait",
      description:
        "Block until the agent signals done/blocked/failed (wraps `agent wait`). Returns the structured outcome plus exitCode: done=0, failed=1, blocked=2, no-signal=3 (no trustworthy signal — never treat as done).",
      inputSchema: {
        target: z.string().describe("branch name, issue number, or issue URL"),
        timeout: z.string().default("30m").describe("backstop wait before giving up, e.g. 30m, 2h"),
        pane: z.string().optional().describe("paneId for the idle-prompt backstop"),
        poll: z.string().default("2s").describe("poll interval, e.g. 2s, 500ms"),
      },
      handler: ({ target, timeout, pane, poll }) =>
        guard(() => run(waitProgram(target, timeout, pane, poll)).then(waitPayload)),
    },
    {
      name: "result",
      description:
        "Read a spawned agent's status sentinel by slug (wraps `agent result`). Returns _tag=status with the verbatim sentinel body, _tag=pending (body is the pending JSON) when not done yet, or _tag=unknown when no spawned worktree exists.",
      inputSchema: {
        slug: z.string().describe("slug passed to spawn"),
      },
      handler: ({ slug }) => guard(() => run(resultProgram(slug)).then(resultPayload)),
    },
    {
      name: "ls",
      description:
        "Read-only dashboard: one structured row per linked worktree (ports, DB, agent state, pane, origin/provenance). Returns DashboardRow[] as JSON (the structured form of `homestead ls`).",
      inputSchema: {},
      handler: () => guard(() => run(lsProgram)),
    },
    {
      name: "land",
      description:
        "Merge finished branch(es) into the default branch, regenerate, run the verify gate, and keep only on green (wraps `homestead land`). Returns { ok: boolean } — false if any branch failed to land.",
      inputSchema: {
        branches: z.array(z.string()).describe("branch names, issue numbers, or issue URLs"),
        complete: z.boolean().default(false).describe("on green, chain `complete` for each landed branch"),
        keepRemote: z.boolean().default(false).describe("with complete: keep the remote branch"),
        allowSpawned: z.boolean().default(false).describe("with complete: land machine-spawned branches"),
      },
      handler: ({ branches, complete, keepRemote, allowSpawned }) =>
        guard(() =>
          run(landProgram(branches, complete, keepRemote, allowSpawned)).then((value) => ({ ok: value })),
        ),
    },
    {
      name: "plan",
      description:
        "Compute collision-aware build waves + a serial integrate order for an issue set (wraps `homestead plan`). Parallelism is bounded by shared `touches:` files; order by `depends-on:`. Returns { waves, integrate, warnings } as JSON.",
      inputSchema: {
        issues: z.array(z.string()).describe("issue numbers or GitHub issue URLs"),
      },
      handler: ({ issues }) => {
        const refs: Array<IssueRef> = [];
        for (const token of issues as ReadonlyArray<string>) {
          const ref = parseIssueArg(token);
          if (ref === undefined) {
            return Promise.resolve(errorResult(`'${token}' is not an issue number or GitHub issue URL`));
          }
          refs.push(ref);
        }
        return guard(() => run(planProgram(refs)));
      },
    },
  ];
};

// ── server assembly + lifecycle ───────────────────────────────────────────────

// stdout is the JSON-RPC transport, so the wrapped functions' Console output
// (runLand and the spawn provisioning path log freely) must NOT reach it. Route
// every Console method to stderr; tool programs run with this provided.
const writeStderr = (...args: ReadonlyArray<unknown>): void => {
  process.stderr.write(args.map((a) => (typeof a === "string" ? a : String(a))).join(" ") + "\n");
};
const StderrConsole: Console.Console = {
  ...globalThis.console,
  log: writeStderr,
  info: writeStderr,
  debug: writeStderr,
  warn: writeStderr,
  error: writeStderr,
  trace: writeStderr,
};

export const buildServer = (run: Runner, version: string): McpServer => {
  const server = new McpServer({ name: "homestead", version });
  for (const tool of buildTools(run)) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      tool.handler as Parameters<McpServer["registerTool"]>[2],
    );
  }
  return server;
};

// Start the stdio MCP server. Builds the Effect runtime ONCE (single PortAllocator
// semaphore, one herdr surface) and runs every tool against it; the runtime's
// scope is disposed on transport shutdown (client disconnect or interrupt).
export const runMcpServer = (version: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    const runtime = ManagedRuntime.make(AppLayer);
    const run: Runner = (effect) =>
      runtime.runPromise(effect.pipe(Effect.provideService(Console.Console, StderrConsole)));

    const server = buildServer(run, version);
    const transport = new StdioServerTransport();
    yield* Effect.promise(() => server.connect(transport));

    // Stay alive until the transport closes (the client disconnects / stdin EOF).
    // connect() installs the SDK's own onclose; chain it so its cleanup still runs.
    yield* Effect.callback<void>((resume) => {
      const prior = transport.onclose;
      transport.onclose = () => {
        prior?.();
        resume(Effect.void);
      };
    }).pipe(Effect.ensuring(Effect.promise(() => runtime.dispose())));
  });
