import { Data } from "effect";

export class HerdrError extends Data.TaggedError("HerdrError")<{
  readonly op: string;
  readonly cause: unknown;
}> {}

export class HerdrTimeout extends Data.TaggedError("HerdrTimeout")<{
  readonly pane: string;
  readonly marker: string;
  readonly waitedMs: number;
  /** The most recent pane output observed before timing out — helps diagnose a wrong readyMarker. */
  readonly recent: string;
}> {}

export class HerdrNotAvailable extends Data.TaggedError("HerdrNotAvailable")<{
  readonly reason: string;
}> {}

/**
 * Human-readable explanation of a ready-marker timeout: names the marker we
 * waited for and shows the last few lines the agent actually emitted, so a
 * wrong `readyMarker` is self-diagnosable.
 */
export const explainTimeout = (e: HerdrTimeout, prefix = ""): string => {
  const tail = e.recent
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line.length > 0)
    .slice(-8);
  const seen =
    tail.length > 0
      ? `\n  last output from the agent:\n${tail.map((line) => `    | ${line}`).join("\n")}`
      : "\n  (the agent produced no output)";
  return (
    `${prefix}agent never reached ready: waited ${Math.round(e.waitedMs / 1000)}s for ` +
    `readyMarker ${JSON.stringify(e.marker)} but never saw it.${seen}\n` +
    `  If the agent is actually running, its prompt glyph likely differs — ` +
    `set agent.readyMarker (or readyRegex: true) to match.`
  );
};
