import { Console, Effect, Schema } from "effect";
import { capture } from "./process.ts";
import type { AgentConfig, WorkItem } from "./types.ts";

// `herdr worktree open` / `workspace create` / `tab create` all nest the new
// pane at result.root_pane.pane_id.
const SurfaceCreated = Schema.Struct({
  result: Schema.Struct({ root_pane: Schema.Struct({ pane_id: Schema.String }) }),
});
const decodeSurfaceCreated = Schema.decodeUnknownEffect(Schema.fromJsonString(SurfaceCreated));

// Thin wrapper over the herdr CLI; returns trimmed stdout (JSON for create,
// empty for run/send-*). Talks to the running herdr over its unix socket.
const herdr = (...args: ReadonlyArray<string>) => capture("herdr", args);

const createSurface = Effect.fn("githog/create-surface")(function* (
  surface: "worktree" | "workspace" | "tab",
  dir: string,
  label: string,
) {
  // The parent repo workspace to nest under — the herdr workspace githog is
  // running in (the repo's main). HERDR_WORKSPACE_ID is set inside every pane.
  const parent = process.env.HERDR_WORKSPACE_ID;
  const parentArg = parent === undefined ? ["--cwd", process.cwd()] : ["--workspace", parent];

  // "worktree" (default): open the git worktree githog just created as a CHILD
  // of the repo's workspace, so it nests under it in herdr (rather than a flat
  // detached workspace, which is what `workspace create --cwd` produces).
  const args =
    surface === "tab"
      ? ["tab", "create", ...parentArg, "--cwd", dir, "--label", label, "--no-focus", "--json"]
      : surface === "workspace"
        ? ["workspace", "create", "--cwd", dir, "--label", label, "--no-focus"]
        : ["worktree", "open", ...parentArg, "--path", dir, "--label", label, "--no-focus", "--json"];

  const created = yield* decodeSurfaceCreated(yield* herdr(...args)).pipe(Effect.orDie);
  return created.result.root_pane.pane_id;
});

// For one work item: open a herdr surface at the worktree and run the githog
// agent loop INSIDE that pane (ADR-0001). The pane is a window, not a driver —
// the loop drives the agent by headless re-invocation, we just give it somewhere
// watchable to scroll. `pane run` re-invokes THIS githog (argv[0] = the bun
// runtime, argv[1] = the resolved cli entry) as `githog loop <issue-url>`, which
// loads the worktree's config and runs the loop. Returns immediately; the loop
// then lives independently in the pane.
export const launchAgent = Effect.fn("githog/launch-agent")(function* (
  item: WorkItem,
  dir: string,
  agent: AgentConfig,
) {
  const surface = agent.surface ?? "worktree";

  yield* Console.log(`\n▸ Launching agent loop for issue #${item.number} in ${dir}`);
  const pane = yield* createSurface(surface, dir, `issue-${item.number}`);

  const runtime = process.argv[0] ?? "bun";
  const entry = process.argv[1] ?? "githog";
  yield* herdr("pane", "run", pane, runtime, entry, "loop", item.url);

  yield* Console.log(`  ✓ #${item.number}: githog loop ${item.url}  (herdr pane ${pane})`);
});
