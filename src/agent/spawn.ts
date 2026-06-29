import { Effect, Option } from "effect";
import { UsageError } from "../errors.ts";
import { launchFreeAgent } from "../herdr/agent.ts";
import { writeAgentMarker, type AgentMarker } from "../tracking.ts";
import { setupWorktree, type Repo } from "../worktree/index.ts";
import type { AgentConfig, HomesteadConfig, Plan } from "../types.ts";
import { resolveAgentDefaults, STATUS_FILE_INSTRUCTION } from "./defaults.ts";
import { AGENT_STATUS_RELPATH } from "./status.ts";

// Default provenance text when the caller doesn't name who spawned the agent.
export const DEFAULT_SPAWNED_BY = "agent spawn";

// Append the status-file instruction so the spawned agent writes the sentinel
// `result`/`wait` read — same contract as the issue path. `statusFile: false`
// opts out (the agent then never reports and `result` can only ever say
// `pending`).
export const seedSpawnPrompt = (prompt: string, agent: AgentConfig): string =>
  agent.statusFile === false ? prompt : prompt + STATUS_FILE_INSTRUCTION;

// Resolve the prompt to seed from the CLI inputs:
//   --prompt -      → read the whole brief from stdin
//   --prompt <text> → that text
//   [prompt...]     → positional words joined with spaces
// No source at all is a usage error (we won't boot an agent with an empty brief).
export const resolveSpawnPrompt = (
  positional: ReadonlyArray<string>,
  flag: Option.Option<string>,
  readStdin: Effect.Effect<string>,
): Effect.Effect<string, UsageError> =>
  Effect.gen(function* () {
    if (Option.isSome(flag)) {
      if (flag.value === "-") {
        const stdin = (yield* readStdin).trim();
        if (stdin === "") {
          return yield* new UsageError({ message: "[homestead] agent spawn: --prompt - got empty stdin." });
        }
        return stdin;
      }
      return flag.value;
    }
    if (positional.length > 0) return positional.join(" ");
    return yield* new UsageError({
      message:
        "[homestead] agent spawn needs a prompt — pass it positionally, via --prompt <text>, or pipe it with --prompt -.",
    });
  });

export const buildSpawnMarker = (input: {
  readonly spawnedBy: string;
  readonly paneId?: string | undefined;
  readonly createdAt: string;
}): AgentMarker => ({
  kind: "spawn",
  spawnedBy: input.spawnedBy,
  ...(input.paneId !== undefined ? { paneId: input.paneId } : {}),
  statusFile: AGENT_STATUS_RELPATH,
  createdAt: input.createdAt,
});

export interface SpawnAgentInput {
  readonly config: HomesteadConfig;
  readonly repo: Repo;
  readonly slug: string;
  readonly prompt: string;
  readonly agent: AgentConfig;
  readonly spawnedBy?: string | undefined;
  // ISO-8601, injected so the flow stays deterministic for tests.
  readonly createdAt: string;
}

// Provision an issue-less worktree, boot the agent with the literal prompt, and
// drop the `.homestead-agent.json` provenance marker — the ONLY index from slug
// → worktree path. Deliberately makes NO GitHub calls and writes NO tracking
// state (no `markStarted`): spawned work has a clean identity of its own.
export const spawnAgent = Effect.fn("homestead/spawn-agent")(function* (input: SpawnAgentInput) {
  const { config, repo, slug, prompt, createdAt } = input;
  const agent = resolveAgentDefaults(input.agent);
  const seeded = seedSpawnPrompt(prompt, input.agent);

  const plan: Plan = yield* setupWorktree(config, { create: slug }, repo);

  const paneId = yield* launchFreeAgent({
    config,
    plan,
    slug: plan.slug,
    branch: plan.branch,
    repoName: repo.repoName,
    agent,
    prompt: seeded,
  });

  yield* writeAgentMarker(
    plan.targetDir,
    buildSpawnMarker({ spawnedBy: input.spawnedBy ?? DEFAULT_SPAWNED_BY, paneId, createdAt }),
  );

  return plan;
});
