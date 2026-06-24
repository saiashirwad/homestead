import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { TrackingStateSchema } from "./tracking.ts";

test("tracking state encode/decode round-trip", async () => {
  const state = {
    number: 42,
    url: "https://github.com/o/r/issues/42",
    label: "agent:working",
    assigned: true,
    commented: true,
  };
  const encoded = await Effect.runPromise(Schema.encodeUnknownEffect(TrackingStateSchema)(state));
  const json = JSON.stringify(encoded);
  const decoded = await Effect.runPromise(
    Schema.decodeUnknownEffect(Schema.fromJsonString(TrackingStateSchema))(json),
  );
  expect(decoded).toEqual(state);
});
