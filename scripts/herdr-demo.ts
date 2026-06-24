// Runnable spike for the herdr Effect library — recreates the hello-world test:
// fresh workspace → launch Claude → seed a prompt → read the reply → tear down.
//
//   bun scripts/herdr-demo.ts
//
// Must be run from inside a herdr pane (HERDR_ENV=1). Uses --no-focus throughout,
// so it never steals your cursor or touches existing workspaces.

import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect, Layer } from "effect";
import { launchAndSeed, toSpec } from "../src/herdr/launch.ts";
import { Herdr } from "../src/herdr/service.ts";
import { resolveAgentDefaults } from "../src/agent/defaults.ts";

const AppLayer = Layer.provideMerge(Layer.effect(Herdr, Herdr.make), BunServices.layer);

const demo = Effect.gen(function* () {
  const herdr = yield* Herdr;
  const paneId = yield* herdr.createSurface("workspace", process.cwd(), "herdr-fx-demo");
  yield* Console.log(`pane ${paneId}`);

  yield* Effect.gen(function* () {
    const agent = resolveAgentDefaults({ command: ["claude"] });
    yield* launchAndSeed(paneId, toSpec(agent), "Say hello world and nothing else.");
    yield* Effect.sleep("8 seconds");
    const rendered = yield* herdr.pane.read(paneId, { lines: 30 });
    yield* Console.log(rendered);
  });
});

BunRuntime.runMain(demo.pipe(Effect.provide(AppLayer)));
