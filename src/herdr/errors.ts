import { Data } from "effect";

export class HerdrError extends Data.TaggedError("HerdrError")<{
  readonly op: string;
  readonly cause: unknown;
}> {}

export class HerdrTimeout extends Data.TaggedError("HerdrTimeout")<{
  readonly pane: string;
  readonly marker: string;
  readonly waitedMs: number;
}> {}

export class HerdrNotAvailable extends Data.TaggedError("HerdrNotAvailable")<{
  readonly reason: string;
}> {}
