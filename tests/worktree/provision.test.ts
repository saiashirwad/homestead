import { expect, test } from "bun:test";
import type { SetupStep } from "../../src/types.ts";

test("setup steps structure validation", () => {
  const steps: ReadonlyArray<SetupStep> = [{ label: "install", run: ["bun", "install"] }];
  expect(steps).toHaveLength(1);
  expect(steps[0].label).toBe("install");
  expect(steps[0].run).toEqual(["bun", "install"]);
});
