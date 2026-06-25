import { Effect, Schema } from "effect";

const nonEmptyEnvKey = Schema.makeFilter<string>((s) =>
  s.trim().length > 0 ? undefined : "must be a non-empty env key",
);

export const PortSpecSchema = Schema.Struct({
  key: Schema.String.check(nonEmptyEnvKey),
  base: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
});
export type PortSpec = typeof PortSpecSchema.Type;

export const ServiceSpecSchema = Schema.Struct({
  name: Schema.String,
  host: Schema.String,
  port: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  start: Schema.optional(Schema.Array(Schema.String).check(Schema.isMinLength(1))),
  timeoutMs: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))),
});
export type ServiceSpec = typeof ServiceSpecSchema.Type;

export const SetupStepSchema = Schema.Struct({
  label: Schema.String,
  run: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
  cwd: Schema.optional(Schema.String),
  injectEnv: Schema.optional(Schema.Array(Schema.String)),
  fatal: Schema.optional(Schema.Boolean),
});
export type SetupStep = typeof SetupStepSchema.Type;

export const EnvConfigDataSchema = Schema.Struct({
  source: Schema.optional(Schema.String),
  fallback: Schema.optional(Schema.String),
});
export type EnvConfigData = typeof EnvConfigDataSchema.Type;
export const ENV_DATA_FIELDS = ["source", "fallback"] as const satisfies ReadonlyArray<keyof EnvConfigData>;

const TrustPromptSchema = Schema.Struct({
  marker: Schema.String,
  confirm: Schema.Array(Schema.String),
});

export const AgentConfigDataSchema = Schema.Struct({
  command: Schema.optional(Schema.Array(Schema.String)),
  surface: Schema.optional(Schema.Literals(["worktree", "tab", "workspace"])),
  readyMarker: Schema.optional(Schema.String),
  readyRegex: Schema.optional(Schema.Boolean),
  readyTimeoutMs: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))),
  trustPrompt: Schema.optional(Schema.Union([Schema.Literal(false), TrustPromptSchema])),
});
export type AgentConfigData = typeof AgentConfigDataSchema.Type;
export const AGENT_DATA_FIELDS = [
  "command",
  "surface",
  "readyMarker",
  "readyRegex",
  "readyTimeoutMs",
  "trustPrompt",
] as const satisfies ReadonlyArray<keyof AgentConfigData>;

export const IssuesConfigDataSchema = Schema.Struct({
  label: Schema.optional(Schema.String),
  assign: Schema.optional(Schema.Union([Schema.Boolean, Schema.String])),
  comment: Schema.optional(Schema.Boolean),
  reviewLabel: Schema.optional(Schema.String),
  labelColor: Schema.optional(Schema.String),
});
export type IssuesConfigData = typeof IssuesConfigDataSchema.Type;
export const ISSUES_SCALAR_FIELDS = ["label", "reviewLabel", "labelColor"] as const satisfies ReadonlyArray<
  keyof IssuesConfigData
>;

export const PrConfigDataSchema = Schema.Struct({
  checks: Schema.optional(Schema.String),
});
export type PrConfigData = typeof PrConfigDataSchema.Type;
export const PR_DATA_FIELDS = ["checks"] as const satisfies ReadonlyArray<keyof PrConfigData>;

const emptyPorts = Schema.Array(PortSpecSchema).pipe(
  Schema.optional,
  Schema.withDecodingDefault(Effect.succeed([] as Array<PortSpec>)),
);
const emptyServices = Schema.Array(ServiceSpecSchema).pipe(
  Schema.optional,
  Schema.withDecodingDefault(Effect.succeed([] as Array<ServiceSpec>)),
);
const emptySetup = Schema.Array(SetupStepSchema).pipe(
  Schema.optional,
  Schema.withDecodingDefault(Effect.succeed([] as Array<SetupStep>)),
);

export const ConfigDataSchema = Schema.Struct({
  ports: emptyPorts,
  services: emptyServices,
  setup: emptySetup,
  env: Schema.optional(EnvConfigDataSchema),
  agent: Schema.optional(AgentConfigDataSchema),
  issues: Schema.optional(IssuesConfigDataSchema),
  pr: Schema.optional(PrConfigDataSchema),
}).pipe(Schema.annotate({ parseOptions: { errors: "all" } }));
export type ConfigData = typeof ConfigDataSchema.Type;
