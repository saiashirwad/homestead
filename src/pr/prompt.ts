import type { HomesteadConfig, PrPromptContext } from "../types.ts";
import type { PrView } from "./resolve.ts";

const checkInstruction = (checks: string | undefined): string =>
  checks
    ? `Run the project's checks (\`${checks}\`)`
    : "Find and run the project's checks (e.g. a `check` or `test` script in package.json)";

const header = (verb: string, pr: PrView): string =>
  `You're ${verb} PR #${pr.number}: "${pr.title}"\n${pr.url}\n` +
  `branch \`${pr.headRefName}\` → \`${pr.baseRefName}\`.\n\n`;

export const defaultReviewPrompt = (ctx: PrPromptContext): string =>
  header("reviewing", ctx.pr) +
  `Read the diff and the surrounding code until you understand it, then:\n` +
  `1. Summarize what the PR does and why.\n` +
  `2. ${checkInstruction(ctx.checks)}.\n` +
  `3. Flag any bugs, risks, or gaps.\n\n` +
  `Do not edit code — this is a review.`;

export const defaultWorkPrompt = (ctx: PrPromptContext): string =>
  header("continuing", ctx.pr) +
  `Read the diff and the surrounding code to see what's done and what's left. ` +
  `${checkInstruction(ctx.checks)}, then keep working: fix failures, address review ` +
  `feedback, and commit. Show me your plan before large changes.`;

export const buildPrPrompt = (
  mode: "review" | "work",
  pr: PrView,
  config: HomesteadConfig,
): string => {
  const ctx: PrPromptContext = { pr, checks: config.pr?.checks };
  if (mode === "review") return (config.pr?.reviewPrompt ?? defaultReviewPrompt)(ctx);
  return (config.pr?.workPrompt ?? defaultWorkPrompt)(ctx);
};
