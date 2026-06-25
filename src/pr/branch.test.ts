import { expect, test } from "bun:test";
import { planPrCheckout } from "./branch.ts";
import type { PrView } from "./resolve.ts";

const base: PrView = {
  number: 87,
  title: "Add rate limiter",
  url: "https://github.com/o/r/pull/87",
  headRefName: "feat/rate-limit",
  baseRefName: "main",
  isCrossRepository: false,
};

test("planPrCheckout uses the head branch for same-repo PRs", () => {
  expect(planPrCheckout(base)).toEqual({ kind: "same-repo", branch: "feat/rate-limit" });
});

test("planPrCheckout uses pr-<n> for cross-repo PRs", () => {
  expect(planPrCheckout({ ...base, isCrossRepository: true })).toEqual({ kind: "fork", branch: "pr-87" });
});
