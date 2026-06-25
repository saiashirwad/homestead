import {
  AGENT_DATA_FIELDS,
  ENV_DATA_FIELDS,
  ISSUES_SCALAR_FIELDS,
  type AgentConfigData,
  type ConfigData,
  type IssuesConfigData,
  type PrConfigData,
} from "./config-schema.ts";
import type { AgentConfig, HomesteadConfig, IssuesConfig, PrConfig } from "./types.ts";

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

const mergeOptionalSection = <T extends object>(
  original: T | undefined,
  data: Partial<T> | undefined,
  hooks: Partial<T>,
): T | undefined => {
  if (original === undefined && data === undefined) return undefined;
  return { ...data, ...hooks } as T;
};

/** Scalar subset of agent config that passes Schema decode (callbacks stripped). */
export const stripAgentData = (agent: AgentConfig | undefined): AgentConfigData | undefined => {
  if (agent === undefined) return undefined;
  const out = pickDefined(
    agent,
    AGENT_DATA_FIELDS.filter((key) => key !== "command") as ReadonlyArray<
      Exclude<(typeof AGENT_DATA_FIELDS)[number], "command">
    >,
  );
  if (Array.isArray(agent.command)) {
    return { ...out, command: [...agent.command] };
  }
  return out;
};

/** Scalar subset of issues config that passes Schema decode (callbacks stripped). */
export const stripIssuesData = (issues: IssuesConfig | undefined): IssuesConfigData | undefined => {
  if (issues === undefined) return undefined;
  const out: IssuesConfigData = {};
  for (const key of ISSUES_SCALAR_FIELDS) {
    const v = issues[key];
    if (typeof v === "string") out[key] = v;
  }
  if (typeof issues.assign === "boolean" || typeof issues.assign === "string") out.assign = issues.assign;
  if (typeof issues.comment === "boolean") out.comment = issues.comment;
  return out;
};

/** Scalar subset of pr config that passes Schema decode (callbacks stripped). */
export const stripPrData = (pr: PrConfig | undefined): PrConfigData | undefined => {
  if (pr === undefined) return undefined;
  return typeof pr.checks === "string" ? { checks: pr.checks } : {};
};

// Callable config values cannot pass Schema decode — strip them here and
// re-attach the originals in mergeValidatedConfig.
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
});

export const mergeValidatedConfig = (config: HomesteadConfig, data: ConfigData): HomesteadConfig => ({
  ...config,
  ports: config.ports ?? data.ports,
  services: data.services,
  setup: isFunction(config.setup) ? config.setup : data.setup,
  env: mergeOptionalSection(config.env, data.env, { derive: config.env?.derive }),
  agent: mergeOptionalSection(config.agent, data.agent, {
    prompt: config.agent?.prompt,
    surfaceLabel: config.agent?.surfaceLabel,
    command: config.agent?.command ?? data.agent?.command,
  }),
  issues: mergeOptionalSection(config.issues, data.issues, {
    branch: config.issues?.branch,
    comment: config.issues?.comment ?? data.issues?.comment,
    stopComment: config.issues?.stopComment,
    reviewComment: config.issues?.reviewComment,
    closeComment: config.issues?.closeComment,
    closeReason: config.issues?.closeReason,
    label: config.issues?.label ?? data.issues?.label,
    reviewLabel: config.issues?.reviewLabel ?? data.issues?.reviewLabel,
    assign: config.issues?.assign ?? data.issues?.assign,
    labelColor: config.issues?.labelColor ?? data.issues?.labelColor,
  }),
  pr: mergeOptionalSection(config.pr, data.pr, {
    reviewPrompt: config.pr?.reviewPrompt,
    workPrompt: config.pr?.workPrompt,
    prBranch: config.pr?.prBranch,
    checks: config.pr?.checks ?? data.pr?.checks,
  }),
});
