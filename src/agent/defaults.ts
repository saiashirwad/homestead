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

// The autonomous-mode tail. Unlike STATUS_FILE_INSTRUCTION it (a) tells the
// agent to exit the session as its final act — that exit is what triggers the
// harness's deterministic `agent finalize` — and (b) explains that the harness
// owns the final status (so the model only needs a best-effort summary, and a
// genuine "blocked" is still honored).
export const AUTONOMOUS_STATUS_INSTRUCTION =
  `\n\n---\n` +
  `Work autonomously to completion — do NOT pause for plan approval or permission. ` +
  `When you believe you are done (or are genuinely blocked), your final actions, in order, must be:\n` +
  `1. Write \`.homestead/agent-status.json\` (relative to this worktree root) with exactly this shape: ` +
  `{ "status": "done" | "blocked" | "failed", "summary": "<one short paragraph, plain English, what you ` +
  `did and the current state>" } — set "blocked" only if a human decision or external dependency is ` +
  `genuinely required.\n` +
  `2. Exit the agent session (e.g. type \`/exit\`).\n` +
  `After you exit, the harness runs the project's check and writes the authoritative status from the ` +
  `result; your "summary" is preserved, and a "blocked" status is respected.`;

// The status-instruction tail to append to a kickoff: none when the agent opts
// out of the sentinel contract, the autonomous variant in autonomous mode, else
// the default best-effort instruction. Shared by the issue path
// (resolveAgentDefaults) and `agent spawn` (seedSpawnPrompt).
export const statusInstructionFor = (agent: AgentConfig): string => {
  if (agent.statusFile === false) return "";
  return agent.autonomous ? AUTONOMOUS_STATUS_INSTRUCTION : STATUS_FILE_INSTRUCTION;
};

// One-line pointer to the per-issue contract skill, woven into both kickoffs. A
// skill-capable agent (Claude) can load it for the full scope/verify/sentinel/
// commit-not-merge rules; non-skill agents ignore it and still get the inline
// status tail. Deliberately free of plan-gate wording so it suits both kickoffs.
export const AGENT_TASK_SKILL_HINT =
  `If your agent supports skills, load the \`homestead-agent-task\` skill first — it is the contract ` +
  `for working in this worktree: scope to this one issue, verify before claiming done, and commit but never merge.`;

export const defaultAgentPrompt = (ctx: AgentPromptContext): string => {
  const item = ctx.item;
  return (
    `This is the issue you need to implement:\n\n` +
    `#${item.number}: "${item.title}"\n${item.url}\n\n` +
    `Read the issue carefully and explore this worktree until you understand exactly what needs to be done. ` +
    `Then show me your plan before you start implementing.\n\n` +
    AGENT_TASK_SKILL_HINT
  );
};

// The no-plan-gate kickoff used in autonomous mode: same issue framing as
// `defaultAgentPrompt`, but it tells the agent to build to completion instead of
// parking at a plan for approval.
export const autonomousAgentPrompt = (ctx: AgentPromptContext): string => {
  const item = ctx.item;
  return (
    `This is the issue you need to implement:\n\n` +
    `#${item.number}: "${item.title}"\n${item.url}\n\n` +
    `Read the issue, explore this worktree, and implement it fully and autonomously. ` +
    `Do not stop to show a plan or ask for approval — build the change to completion and keep it ` +
    `consistent with the codebase's conventions.\n\n` +
    AGENT_TASK_SKILL_HINT
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

  const basePrompt = agent.prompt ?? (agent.autonomous ? autonomousAgentPrompt : defaultAgentPrompt);
  const tail = statusInstructionFor(agent);
  return {
    ...agent,
    command: typeof command === "function" ? command : (command ?? DEFAULT_AGENT_COMMAND),
    trustPrompt,
    // Keep the base function's identity when there's no tail (statusFile:false)
    // — callers assert on it; only allocate a wrapper when we actually append.
    prompt: tail === "" ? basePrompt : (ctx) => basePrompt(ctx) + tail,
  };
};
