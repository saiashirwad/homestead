import { Effect, Option } from "effect";
import { UsageError } from "../errors.ts";
import { seedPrompt } from "../herdr/launch.ts";
import { Herdr } from "../herdr/service.ts";
import { readAgentMarker } from "../tracking.ts";
import type { HomesteadConfig } from "../types.ts";
import { AGENT_STATUS_RELPATH, clearAgentStatus } from "./status.ts";
import { resolveWorktreeDir } from "./wait.ts";

export interface PromptAgentInput {
  readonly repoName: string;
  readonly slug: string;
  readonly text: string;
  readonly config: HomesteadConfig | undefined;
}

// Send a follow-up turn to an already-running spawned agent. The agent must be
// idle at its prompt (we don't interrupt mid-turn). Resolves slug → paneId via
// the same provenance marker `agent result` reads, confirms the pane is still
// alive, invalidates the prior turn's status, then types + submits the text.
//
// Order is deliberate — probe → clear → send:
//   - probe FIRST so a dead pane fails cleanly and leaves the old status intact
//     (nothing is going to run, so don't wipe the record).
//   - clear BEFORE send so a follow-up `agent wait` blocks on THIS turn rather
//     than returning instantly on turn 1's stale `done`.
export const promptAgent = Effect.fn("homestead/agent-prompt")(function* (input: PromptAgentInput) {
  const { repoName, slug, text, config } = input;
  const herdr = yield* Herdr;

  // The provenance marker is the only slug → paneId index (spawn writes no
  // tracking state), so resolve the worktree the same way `agent result` does.
  const worktreeDir = yield* resolveWorktreeDir(repoName, slug, config);
  const marker = yield* readAgentMarker(worktreeDir);
  if (Option.isNone(marker)) {
    return yield* new UsageError({
      message: `[homestead] no spawned agent named '${slug}' (no '.homestead-agent.json' marker — was it spawned with 'agent spawn'?)`,
    });
  }
  const paneId = marker.value.paneId;
  if (paneId === undefined) {
    return yield* new UsageError({
      message: `[homestead] agent '${slug}' has no recorded pane to prompt (marker is missing a paneId).`,
    });
  }

  // Liveness proxy: herdr has no "does pane X exist" query, so a successful
  // read stands in for one. If the read fails the pane is gone — fail clearly
  // instead of letting a send-text no-op into a dead pane.
  yield* herdr.pane.read(paneId, { lines: 1 }).pipe(
    Effect.mapError(
      () =>
        new UsageError({
          message: `[homestead] agent '${slug}' is no longer running (pane ${paneId} is gone).`,
        }),
    ),
  );

  yield* clearAgentStatus(worktreeDir, marker.value.statusFile ?? AGENT_STATUS_RELPATH);
  yield* seedPrompt(paneId, text);
});
