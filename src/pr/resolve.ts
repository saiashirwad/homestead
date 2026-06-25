import { Effect, Schema } from "effect";
import { ExternalCommandError } from "../errors.ts";
import { capture } from "../process.ts";
import type { PrRef } from "./ref.ts";

export const PrViewSchema = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  url: Schema.String,
  headRefName: Schema.String,
  baseRefName: Schema.String,
  isCrossRepository: Schema.Boolean,
});
export type PrView = typeof PrViewSchema.Type;

export const resolvePr = Effect.fn("homestead/resolve-pr")(function* (ref: PrRef) {
  const json = yield* capture("gh", [
    "pr",
    "view",
    ref.ghArg,
    "--json",
    "number,title,url,headRefName,baseRefName,isCrossRepository",
  ]);
  const view: PrView = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PrViewSchema))(json).pipe(
    Effect.catchTag(
      "SchemaError",
      (error) => new ExternalCommandError({ command: "gh pr view", detail: error.message }),
    ),
  );
  return view;
});
