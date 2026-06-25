import { expect, test } from "bun:test";
import { buildPrPrompt } from "./prompt.ts";
import type { PrView } from "./resolve.ts";
import type { HomesteadConfig } from "../types.ts";

const pr: PrView = {
  number: 87,
  title: "Add rate limiter",
  url: "https://github.com/o/r/pull/87",
  headRefName: "feat/rate-limit",
  baseRefName: "main",
  isCrossRepository: false,
};

test("review prompt summarizes, names the configured checks, and forbids editing", () => {
  const config: HomesteadConfig = { pr: { checks: "bun run check" } };
  const out = buildPrPrompt("review", pr, config);
  expect(out).toContain("reviewing PR #87");
  expect(out).toContain("bun run check");
  expect(out).toContain("Do not edit code");
});

test("review prompt without configured checks tells Claude to find them", () => {
  const out = buildPrPrompt("review", pr, {});
  expect(out).toContain("Find and run the project's checks");
});

test("work prompt is about continuing the PR", () => {
  const out = buildPrPrompt("work", pr, {});
  expect(out).toContain("continuing PR #87");
  expect(out).not.toContain("Do not edit code");
});

test("config reviewPrompt override wins", () => {
  const config: HomesteadConfig = { pr: { reviewPrompt: (ctx) => `CUSTOM ${ctx.pr.number}` } };
  expect(buildPrPrompt("review", pr, config)).toBe("CUSTOM 87");
});
