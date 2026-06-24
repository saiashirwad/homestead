import { expect, test } from "bun:test";
import {
  collectUsedPorts,
  computePortEdits,
} from "./plan.ts";

test("collectUsedPorts gathers integer port values from sibling env files", () => {
  const ports = [
    { key: "PORT", base: 3000 },
    { key: "VITE_PORT", base: 5173 },
  ] as const;

  const siblingEnvs = [
    "PORT=3000\nVITE_PORT=5173\n",
    "PORT=3001\n# comment\nVITE_PORT=5174\n",
    "PORT=not-a-number\nVITE_PORT=5175\n",
  ];

  const used = collectUsedPorts(siblingEnvs, ports);

  expect(used.get("PORT")).toEqual(new Set([3000, 3001]));
  expect(used.get("VITE_PORT")).toEqual(new Set([5173, 5174, 5175]));
});

test("collectUsedPorts returns empty sets when no ports configured", () => {
  expect(collectUsedPorts(["PORT=3000\n"], [])).toEqual(new Map());
});

test("computePortEdits preserves existing target env values", () => {
  const ports = [{ key: "PORT", base: 3000 }] as const;
  const used = new Map([["PORT", new Set([3000, 3001])]]);

  const edits = computePortEdits("PORT=3099\nOTHER=1\n", ports, used);

  expect(edits).toEqual([["PORT", "3099"]]);
});

test("computePortEdits allocates next free port when target env lacks key", () => {
  const ports = [
    { key: "PORT", base: 3000 },
    { key: "VITE_PORT", base: 5173 },
  ] as const;
  const used = new Map([
    ["PORT", new Set([3000, 3001])],
    ["VITE_PORT", new Set([5173])],
  ]);

  const edits = computePortEdits("", ports, used);

  expect(edits).toEqual([
    ["PORT", "3002"],
    ["VITE_PORT", "5174"],
  ]);
});

test("computePortEdits integrates nextFreePort for partially used ranges", () => {
  const ports = [{ key: "PORT", base: 3000 }] as const;
  const used = new Map([["PORT", new Set([3000, 3002])]]);

  expect(computePortEdits("", ports, used)).toEqual([["PORT", "3001"]]);
});

test("sibling env scanning skips non-integer and missing keys", () => {
  const ports = [{ key: "PORT", base: 4000 }] as const;

  const used = collectUsedPorts(
    ["PORT=4000\nOTHER=1\n", "PORT=4000.5\n", "DATABASE_URL=postgres://x\n"],
    ports,
  );

  expect(used.get("PORT")).toEqual(new Set([4000]));
});
