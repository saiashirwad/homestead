import { expect, test } from "bun:test";
import type { IssuesConfig } from "../types.ts";
import { resolveIssueBase } from "./provision.ts";

test("resolveIssueBase: --from flag wins over issues.base config", () => {
  const issues: IssuesConfig = { base: "integration" };
  expect(resolveIssueBase("wave-1", issues)).toBe("wave-1");
});

test("resolveIssueBase: falls back to issues.base when no flag", () => {
  const issues: IssuesConfig = { base: "integration" };
  expect(resolveIssueBase(undefined, issues)).toBe("integration");
});

test("resolveIssueBase: undefined when neither flag nor config is set", () => {
  expect(resolveIssueBase(undefined, undefined)).toBeUndefined();
  expect(resolveIssueBase(undefined, {})).toBeUndefined();
});
