import { Duration, Effect, Ref, Schedule } from "effect";
import { HerdrError, HerdrTimeout } from "./errors.ts";
import { matcher, type PollOptions, type ReadSource } from "./types.ts";

type PaneRead = (
  paneId: string,
  options?: { readonly source?: ReadSource; readonly lines?: number },
) => Effect.Effect<string, HerdrError>;

export const pollUntil = Effect.fn("herdr/poll-until")(function* (
  read: PaneRead,
  paneId: string,
  marker: string,
  predicate: (rendered: string) => boolean,
  options: PollOptions | undefined,
) {
  const timeoutMs = options?.timeoutMs ?? 20_000;
  const pollMs = options?.pollMs ?? 500;
  const source = options?.source ?? "visible";
  const lastSeen = yield* Ref.make("");
  const matched = yield* read(paneId, { source }).pipe(
    Effect.tap((rendered) => Ref.set(lastSeen, rendered)),
    Effect.map(predicate),
    Effect.repeat({ schedule: Schedule.spaced(`${pollMs} millis`), until: (done) => done }),
    Effect.timeoutOrElse({
      duration: `${timeoutMs} millis`,
      orElse: () => Effect.succeed(false),
    }),
    Effect.timed,
    Effect.map(([duration, ok]) => ({ ok, waitedMs: Duration.toMillis(duration) })),
  );
  if (!matched.ok) {
    const recent = yield* Ref.get(lastSeen);
    return yield* new HerdrTimeout({ pane: paneId, marker, waitedMs: matched.waitedMs, recent });
  }
});

export const makePolling = (read: PaneRead) => ({
  waitForMarker: Effect.fn("herdr/wait-for-marker")(function* (
    paneId: string,
    marker: string,
    options?: PollOptions,
  ) {
    const test = matcher(marker, options?.regex);
    yield* pollUntil(read, paneId, marker, test, options);
  }),

  waitUntilGone: Effect.fn("herdr/wait-until-gone")(function* (
    paneId: string,
    marker: string,
    options?: PollOptions,
  ) {
    const test = matcher(marker, options?.regex);
    yield* pollUntil(read, paneId, marker, (text) => !test(text), options);
  }),
});
