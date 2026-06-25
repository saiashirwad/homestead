import { Effect } from "effect";
import type { HomesteadConfig, HomesteadContext, HomesteadServices } from "./types.ts";

export type TeardownVerb = "kill" | "close" | "complete";

export const runAfterLaunch = (
  hook: HomesteadConfig["afterLaunch"],
  ctx: HomesteadContext,
  paneId: string,
): Effect.Effect<void, never, HomesteadServices> =>
  hook === undefined ? Effect.void : hook({ ...ctx, paneId });

export const runBeforeTeardown = (
  hook: HomesteadConfig["beforeTeardown"],
  ctx: HomesteadContext,
  verb: TeardownVerb,
  tracked: boolean,
): Effect.Effect<void, never, HomesteadServices> =>
  hook === undefined ? Effect.void : hook({ ...ctx, verb, tracked });

export const runAfterTeardown = (
  hook: HomesteadConfig["afterTeardown"],
  ctx: HomesteadContext,
  verb: TeardownVerb,
  reviewLabel?: string,
): Effect.Effect<void, never, HomesteadServices> =>
  hook === undefined
    ? Effect.void
    : hook(reviewLabel === undefined ? { ...ctx, verb } : { ...ctx, verb, reviewLabel });
