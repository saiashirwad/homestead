import type { AgentConfig, AgentPromptContext } from "../types.ts";

export const DEFAULT_AGENT_COMMAND = ["claude"] as const;
export const DEFAULT_AGENT_READY_MARKER = "❯";
export const DEFAULT_CLAUDE_TRUST_PROMPT = {
  marker: "trust this folder",
  confirm: ["Enter"],
} as const;

export const defaultAgentPrompt = (ctx: AgentPromptContext): string =>
  `This is the issue you need to implement:\n\n` +
  `#${ctx.item.number}: "${ctx.item.title}"\n${ctx.item.url}\n\n` +
  `Read the issue carefully and explore this worktree until you understand exactly what needs to be done. ` +
  `Then show me your plan before you start implementing.`;

export const resolveAgentDefaults = (agent: AgentConfig): AgentConfig & {
  readonly command: ReadonlyArray<string>;
  readonly prompt: (ctx: AgentPromptContext) => string;
} => {
  const command = agent.command ?? DEFAULT_AGENT_COMMAND;
  const binary = command[0] ?? "claude";
  const trustPrompt =
    agent.trustPrompt !== undefined
      ? agent.trustPrompt
      : binary === "claude"
        ? DEFAULT_CLAUDE_TRUST_PROMPT
        : undefined;

  return {
    ...agent,
    command,
    trustPrompt,
    prompt: agent.prompt ?? defaultAgentPrompt,
  };
};
