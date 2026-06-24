import { expect, test } from "bun:test";
import { branchFromOriginHead } from "./base-ref.ts";

test("branchFromOriginHead strips origin/ prefix", () => {
  expect(branchFromOriginHead("origin/main")).toBe("main");
  expect(branchFromOriginHead("origin/master")).toBe("master");
});

test("branchFromOriginHead passes through refs without origin/ prefix", () => {
  expect(branchFromOriginHead("main")).toBe("main");
  expect(branchFromOriginHead("develop")).toBe("develop");
});
