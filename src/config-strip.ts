import {
  AGENT_DATA_FIELDS,
  ENV_DATA_FIELDS,
  ISSUES_SCALAR_FIELDS,
  type AgentConfigData,
  type ConfigData,
  type IssuesConfigData,
  type LandConfigData,
  type PrConfigData,
} from "./config-schema.ts";
import type { AgentConfig, HomesteadConfig, IssuesConfig, LandConfig, PrConfig } from "./types.ts";

const isFunction = (v: unknown): v is (...args: never[]) => unknown => typeof v === "function";

const pickDefined = <T extends object, K extends keyof T>(
  source: T,
  keys: readonly K[],
): Pick<T, K> => {
  const result = {} as Pick<T, K>;
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
};

/** Agent fields whose data shape is a plain scalar (everything except `command`). */
const AGENT_SCALAR_FIELDS = [
  "surface",
  "readyMarker",
  "readyRegex",
  "readyTimeoutMs",
  "trustPrompt",
] as const satisfies ReadonlyArray<Exclude<(typeof AGENT_DATA_FIELDS)[number], "command">>;

/** Scalar subset of agent config that passes Schema decode (callbacks stripped). */
export const stripAgentData = (agent: AgentConfig | undefined): AgentConfigData | undefined => {
  if (agent === undefined) return undefined;
  const out = pickDefined(agent, AGENT_SCALAR_FIELDS);
  if (Array.isArray(agent.command)) {
    return { ...out, command: [...agent.command] };
  }
  return out;
};

/** Scalar subset of issues config that passes Schema decode (callbacks stripped). */
export const stripIssuesData = (issues: IssuesConfig | undefined): IssuesConfigData | undefined => {
  if (issues === undefined) return undefined;
  const out: { -readonly [K in keyof IssuesConfigData]: IssuesConfigData[K] } = {};
  for (const key of ISSUES_SCALAR_FIELDS) {
    const v = issues[key];
    if (typeof v === "string") out[key] = v;
  }
  if (typeof issues.assign === "boolean" || typeof issues.assign === "string") out.assign = issues.assign;
  if (typeof issues.comment === "boolean") out.comment = issues.comment;
  if (typeof issues.concurrency === "number") out.concurrency = issues.concurrency;
  return out;
};

/** Scalar subset of pr config that passes Schema decode (callbacks stripped). */
export const stripPrData = (pr: PrConfig | undefined): PrConfigData | undefined => {
  if (pr === undefined) return undefined;
  return typeof pr.checks === "string" ? { checks: pr.checks } : {};
};

/** Land config is all string arrays (no callbacks) — pass through, defensively cloned. */
export const stripLandData = (land: LandConfig | undefined): LandConfigData | undefined => {
  if (land === undefined) return undefined;
  const out: { -readonly [K in keyof LandConfigData]: LandConfigData[K] } = {};
  if (Array.isArray(land.verify)) out.verify = [...land.verify];
  if (Array.isArray(land.regen)) out.regen = land.regen.map((cmd) => [...cmd]);
  if (Array.isArray(land.generated)) out.generated = [...land.generated];
  return out;
};

// Callable config values cannot pass Schema decode — strip them here so the
// schema can validate the scalar shape.
export const toConfigData = (config: HomesteadConfig): ConfigData => ({
  ports: config.ports?.map(({ key, base }) => ({
    key,
    base: isFunction(base) ? 0 : base,
  })),
  services: config.services,
  setup: isFunction(config.setup) ? [] : config.setup,
  env: config.env === undefined ? undefined : pickDefined(config.env, ENV_DATA_FIELDS),
  agent: stripAgentData(config.agent),
  issues: stripIssuesData(config.issues),
  pr: stripPrData(config.pr),
  land: stripLandData(config.land),
});
