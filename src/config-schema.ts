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
  // Env keys that `derive` produces (e.g. ["DATABASE_URL"]). Purely a
  // read-only display hint for `homestead ls`'s DB column: the dashboard reads
  // these keys' values from each worktree's own .env and never executes
  // `derive`. Declaring them keeps `ls` strictly observational.
  derivedKeys: Schema.optional(Schema.Array(Schema.String)),
});
export type EnvConfigData = typeof EnvConfigDataSchema.Type;
export const ENV_DATA_FIELDS = ["source", "fallback", "derivedKeys"] as const satisfies ReadonlyArray<
  keyof EnvConfigData
>;

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
  // Opt out of the auto-appended "write .homestead/agent-status.json when you
  // finish" instruction (default: on). `homestead agent wait` blocks on that
  // sentinel, so disabling it makes a launched agent un-awaitable.
  statusFile: Schema.optional(Schema.Boolean),
  // Unattended fan-out: swap the plan-gate kickoff ("show me your plan") for a
  // "build to completion, don't pause for approval, then exit" prompt, AND wrap
  // the pane command so the harness writes the sentinel deterministically on
  // agent exit (instead of trusting the model to). Pairs with `agent wait`.
  autonomous: Schema.optional(Schema.Boolean),
  // The verification command the harness runs on autonomous-agent exit to decide
  // the sentinel's status (exit 0 → done, non-zero → failed), e.g.
  // ["bun", "run", "check"]. Only consulted when `autonomous` is on; if unset,
  // the agent's own exit code is the fallback signal.
  check: Schema.optional(Schema.Array(Schema.String).check(Schema.isMinLength(1))),
});
export type AgentConfigData = typeof AgentConfigDataSchema.Type;
export const AGENT_DATA_FIELDS = [
  "command",
  "surface",
  "readyMarker",
  "readyRegex",
  "readyTimeoutMs",
  "trustPrompt",
  "statusFile",
  "autonomous",
  "check",
] as const satisfies ReadonlyArray<keyof AgentConfigData>;

export const IssuesConfigDataSchema = Schema.Struct({
  label: Schema.optional(Schema.String),
  assign: Schema.optional(Schema.Union([Schema.Boolean, Schema.String])),
  comment: Schema.optional(Schema.Boolean),
  reviewLabel: Schema.optional(Schema.String),
  labelColor: Schema.optional(Schema.String),
  // Persistent base ref every `homestead issue` wave forks from (e.g. an
  // integration branch), so stacked waves see each other's code without
  // merging to the default branch first. `--from` overrides it per-run.
  base: Schema.optional(Schema.String),
  // How many issues `homestead issue a b c` provisions in parallel. Port picks
  // are race-safe, so this just bounds concurrent worktree setup (default 4).
  concurrency: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))),
});
export type IssuesConfigData = typeof IssuesConfigDataSchema.Type;
export const ISSUES_SCALAR_FIELDS = ["label", "reviewLabel", "labelColor", "base"] as const satisfies ReadonlyArray<
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
