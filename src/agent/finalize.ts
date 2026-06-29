import { Effect, FileSystem, Option, Path, Schema } from "effect";
import { runExit } from "../process.ts";
import {
  AGENT_STATUS_RELPATH,
  AgentStatusFileSchema,
  type AgentStatusFile,
  type AgentStatusValue,
} from "./status.ts";

// The harness-written half of autonomous mode. On agent exit the wrapped pane
// command (see autonomous.ts) calls `homestead agent finalize`, which lands
// here: run the project's `check`, then write `.homestead/agent-status.json`
// deterministically — done if the check passes, failed if not. The model no
// longer has to remember to write the sentinel; its only contribution is an
// (optional) enriched `summary`.

export interface FinalizeInput {
  readonly worktreeDir: string;
  // The verification command (config `agent.check`). When set, its exit code is
  // the authoritative done/failed signal. When unset, `agentExit` is the signal.
  readonly check?: ReadonlyArray<string> | undefined;
  // The inner agent's own exit code, threaded from the wrapper's `$?`. Only used
  // as the fallback signal when no `check` is configured (an interactive `/exit`
  // is always 0, so the check is preferred whenever present).
  readonly agentExit?: number | undefined;
}

// Decide the authoritative status, or None to leave an existing sentinel alone.
// A model-written `blocked` is sacred: it means "a human must decide", which no
// check can adjudicate — so the harness never overrides it. Everything else
// (done / failed / no file) is the harness's call from the real check/exit.
export const decideAutonomousStatus = (input: {
  readonly existing: Option.Option<AgentStatusFile>;
  readonly checkCode: number | undefined;
  readonly agentExit: number | undefined;
}): Option.Option<AgentStatusValue> => {
  if (Option.isSome(input.existing) && input.existing.value.status === "blocked") {
    return Option.none();
  }
  const signal = input.checkCode ?? input.agentExit ?? 0;
  return Option.some(signal === 0 ? "done" : "failed");
};

// Keep the model's summary when it left one (the "enrich" path); otherwise state
// plainly what the harness observed so the sentinel is never empty.
export const finalSummary = (
  existing: Option.Option<AgentStatusFile>,
  status: AgentStatusValue,
  checkRan: boolean,
): string => {
  if (Option.isSome(existing) && existing.value.summary.trim() !== "") {
    return existing.value.summary;
  }
  const verdict = status === "done" ? "passed" : "failed";
  return checkRan
    ? `Harness-finalized: agent exited and the configured check ${verdict}.`
    : `Harness-finalized: agent exited (no check configured); recorded ${status} from the agent's exit code.`;
};

// Lenient read of any pre-existing sentinel — we only want its `summary`/`status`
// to inform the decision, so a missing/empty/malformed file is just None.
const readExisting = (statusPath: string): Effect.Effect<Option.Option<AgentStatusFile>, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(statusPath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) return Option.none<AgentStatusFile>();
    const content = yield* fs.readFileString(statusPath).pipe(Effect.orElseSucceed(() => ""));
    if (content.trim() === "") return Option.none<AgentStatusFile>();
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(AgentStatusFileSchema))(content).pipe(
      Effect.map(Option.some),
      Effect.orElseSucceed(() => Option.none<AgentStatusFile>()),
    );
  });

// Run the check (if any) and write the authoritative sentinel. Returns the
// status that was written, or None when an existing `blocked` was preserved.
export const finalizeAgentStatus = Effect.fn("homestead/agent-finalize")(function* (input: FinalizeInput) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const statusPath = path.join(input.worktreeDir, AGENT_STATUS_RELPATH);

  const existing = yield* readExisting(statusPath);

  const check = input.check;
  const checkRan = check !== undefined && check.length > 0;
  const checkCode = checkRan
    ? yield* runExit(check[0]!, check.slice(1), { cwd: input.worktreeDir })
    : undefined;

  const decided = decideAutonomousStatus({ existing, checkCode, agentExit: input.agentExit });
  if (Option.isNone(decided)) return Option.none<AgentStatusValue>();

  const status = decided.value;
  const file: AgentStatusFile = { status, summary: finalSummary(existing, status, checkRan) };

  yield* fs.makeDirectory(path.dirname(statusPath), { recursive: true }).pipe(
    Effect.orElseSucceed(() => undefined),
  );
  yield* fs.writeFileString(statusPath, `${JSON.stringify(file, null, 2)}\n`);
  return Option.some(status);
});
