import { Effect, FileSystem, Option, Path } from "effect";
import { readAgentMarker } from "../tracking.ts";
import type { HomesteadConfig } from "../types.ts";
import { AGENT_STATUS_RELPATH } from "./status.ts";
import { resolveWorktreeDir } from "./wait.ts";

// One-shot read of a spawned agent's outcome, keyed by slug:
//   - "status"  → the sentinel exists; `body` is its verbatim JSON text.
//   - "pending" → the worktree exists (marker present) but no sentinel yet.
//   - "unknown" → no spawned worktree for this slug (no marker / no worktree).
export type AgentResult =
  | { readonly _tag: "status"; readonly body: string }
  | { readonly _tag: "pending" }
  | { readonly _tag: "unknown" };

// The literal payload `result` prints for a not-done-yet agent. Kept as a
// constant so the orchestrator-facing contract is asserted in one place.
export const PENDING_JSON = `{"status":"pending"}`;

export const resultForSlug = Effect.fn("homestead/agent-result")(function* (
  repoName: string,
  slug: string,
  config: HomesteadConfig | undefined,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  // Spawn writes no tracking state, so this resolves through the
  // ~/worktrees/<repo>/<slug> convention (or config.worktreeDir).
  const worktreeDir = yield* resolveWorktreeDir(repoName, slug, config);

  // The marker is the index: present ⇔ this slug was spawned here. Absent ⇒
  // there's no spawned worktree to report on.
  const marker = yield* readAgentMarker(worktreeDir);
  if (Option.isNone(marker)) return { _tag: "unknown" } satisfies AgentResult;

  const statusPath = path.join(worktreeDir, AGENT_STATUS_RELPATH);
  const exists = yield* fs.exists(statusPath).pipe(Effect.orElseSucceed(() => false));
  if (!exists) return { _tag: "pending" } satisfies AgentResult;

  const body = yield* fs.readFileString(statusPath).pipe(Effect.orElseSucceed(() => ""));
  if (body.trim() === "") return { _tag: "pending" } satisfies AgentResult;
  return { _tag: "status", body: body.trim() } satisfies AgentResult;
});
