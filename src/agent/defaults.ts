import { resolveCallable } from "../callable.ts";
import type { HomesteadContext } from "../context.ts";
import type { AgentConfig, AgentPromptContext } from "../types.ts";

export const DEFAULT_AGENT_COMMAND = ["claude"] as const;
export const DEFAULT_AGENT_READY_MARKER = "❯";
export const DEFAULT_CLAUDE_TRUST_PROMPT = {
  marker: "trust this folder",
  confirm: ["Enter"],
} as const;

export const STATUS_FILE_INSTRUCTION =
  `\n\n---\n` +
  `When you finish this task — whether you completed it, got blocked, or failed — your LAST action ` +
  `must be to write a file at \`.homestead/agent-status.json\` (relative to this worktree root) with ` +
  `exactly this shape:\n` +
  `{ "status": "done" | "blocked" | "failed", "summary": "<one short paragraph, plain English, ` +
  `what you did and the current state>" }\n` +
  `Use "done" only if the work is complete and you have verified it; "blocked" if you need a human ` +
  `decision or an external dependency; "failed" if you tried and could not finish. Write this file ` +
  `last, as the final thing you do.`;

const withStatusInstruction =
  (base: (ctx: AgentPromptContext) => string) =>
  (ctx: AgentPromptContext): string => base(ctx) + STATUS_FILE_INSTRUCTION;

export const defaultAgentPrompt = (ctx: AgentPromptContext): string => {
  const item = ctx.item;
  return (
    `This is the issue you need to implement:\n\n` +
    `#${item.number}: "${item.title}"\n${item.url}\n\n` +
    `Read the issue carefully and explore this worktree until you understand exactly what needs to be done. ` +
    `Then show me your plan before you start implementing.`
  );
};

export type CommandContext = HomesteadContext & { readonly args: ReadonlyArray<string> };

export const resolveCommand = (
  cfg:
    | ReadonlyArray<string>
    | ((ctx: CommandContext) => ReadonlyArray<string>)
    | undefined,
  ctx: CommandContext,
): ReadonlyArray<string> => resolveCallable(cfg, ctx, DEFAULT_AGENT_COMMAND);

export const resolveAgentDefaults = (agent: AgentConfig): AgentConfig & {
  readonly prompt: (ctx: AgentPromptContext) => string;
} => {
  const command = agent.command;
  const binary =
    typeof command === "function" ? "claude" : (command ?? DEFAULT_AGENT_COMMAND)[0] ?? "claude";
  const trustPrompt =
    agent.trustPrompt !== undefined
      ? agent.trustPrompt
      : binary === "claude"
        ? DEFAULT_CLAUDE_TRUST_PROMPT
        : undefined;

  const basePrompt = agent.prompt ?? defaultAgentPrompt;
  return {
    ...agent,
    command: typeof command === "function" ? command : (command ?? DEFAULT_AGENT_COMMAND),
    trustPrompt,
    prompt: agent.statusFile === false ? basePrompt : withStatusInstruction(basePrompt),
  };
};
