import { expect, test } from "bun:test";
import { resolveSetup } from "./provision.ts";

const ctx = { branch: "docs-fix", plan: {} } as any;

test("resolveSetup passes array through", () => {
  const steps = [{ label: "install", run: ["bun", "install"] }];
  expect(resolveSetup(steps, ctx)).toBe(steps);
});
test("resolveSetup calls function and can branch", () => {
  const fn = (c: any) => (c.branch.startsWith("docs") ? [] : [{ label: "seed", run: ["bun", "seed"] }]);
  expect(resolveSetup(fn, ctx)).toEqual([]);
});
test("resolveSetup undefined → []", () => {
  expect(resolveSetup(undefined, ctx)).toEqual([]);
});
