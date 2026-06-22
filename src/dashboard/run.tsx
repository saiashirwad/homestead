import { BunServices } from "@effect/platform-bun";
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { Console, Effect } from "effect";
import { loadConfig } from "../config.ts";
import { DEFAULT_INTERVAL_SECONDS, listen } from "../listen.ts";
import { OutputCapture } from "../process.ts";
import { makeTuiConsole } from "./console.ts";
import { tuiReporter } from "./reporter.ts";
import { initialState, makeStore } from "./store.ts";
import { Dashboard } from "./ui.tsx";

// Bootstrap the listen dashboard: load config plainly (so config errors print
// before we take the screen), start OpenTUI, then run the Effect `listen` loop as
// a forked fiber whose Console + subprocess output route into the store instead
// of the terminal.
export const runListenTui = async (): Promise<void> => {
  if (process.env.HERDR_ENV !== "1") {
    console.error("[githog] not inside a herdr pane (HERDR_ENV != 1) — run listen from a herdr terminal.");
    process.exit(1);
  }

  const config = await Effect.runPromise(loadConfig(process.cwd()).pipe(Effect.provide(BunServices.layer))).catch(
    (error: unknown) => {
      console.error(`[githog] ${String(error)}`);
      process.exit(1);
    },
  );
  if (config.agent === undefined) {
    console.error("[githog] config has no `agent` block — listen needs one to launch claude.");
    process.exit(1);
  }

  const store = makeStore(
    initialState({
      repoName: "…",
      readyLabel: config.listen?.label ?? "agent:ready",
      intervalSeconds: config.listen?.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS,
      maxConcurrent: config.listen?.maxConcurrent ?? 3,
    }),
  );

  const renderer = await createCliRenderer();
  let quitting = false;
  const onQuit = () => {
    if (quitting) return;
    quitting = true;
    try {
      renderer.destroy();
    } catch {
      // ignore — we're exiting anyway
    }
    process.exit(0);
  };
  createRoot(renderer).render(<Dashboard store={store} onQuit={onQuit} />);

  const program = listen(config, tuiReporter(store)).pipe(
    Effect.provideService(Console.Console, makeTuiConsole(store)),
    Effect.provideService(OutputCapture, true),
    Effect.catchCause((cause) => Effect.sync(() => store.update((s) => ({ ...s, error: String(cause) })))),
    Effect.provide(BunServices.layer),
  );
  Effect.runFork(program);
};
