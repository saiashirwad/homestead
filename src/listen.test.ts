import { expect, test } from "bun:test";
import { DEFAULT_READY_LABEL, resolveReadyLabel } from "./listen.ts";
import type { GithogConfig } from "./types.ts";

const config = (over: Partial<GithogConfig> = {}): GithogConfig => ({ ...over });

test("DEFAULT_READY_LABEL is the documented trigger label", () => {
  expect(DEFAULT_READY_LABEL).toBe("agent:ready");
});

test("resolveReadyLabel: no listen block -> default", () => {
  expect(resolveReadyLabel(config())).toBe("agent:ready");
});

test("resolveReadyLabel: explicit override wins", () => {
  expect(resolveReadyLabel(config({ listen: { label: "queue:go" } }))).toBe("queue:go");
});

test("resolveReadyLabel: empty/blank override falls back to the default", () => {
  expect(resolveReadyLabel(config({ listen: { label: "" } }))).toBe("agent:ready");
  expect(resolveReadyLabel(config({ listen: { label: "   " } }))).toBe("agent:ready");
});
