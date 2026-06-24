import { Schema } from "effect";

export const WorkItemSchema = Schema.Struct({
  number: Schema.Number,
  url: Schema.String,
  title: Schema.String,
});
export type WorkItem = typeof WorkItemSchema.Type;
