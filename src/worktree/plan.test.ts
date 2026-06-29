import { expect, test } from "bun:test";
import { Effect } from "effect";
import { makeContext } from "../context.ts";
import {
  collectUsedPorts,
  computePortEdits,
  pickFreePort,
  resolvePortBase,
  resolvePortEdits,
} from "./plan.ts";

const portCtx = makeContext({ repoName: "app", slug: "feat", branch: "feat/x", worktreeDir: "/wt" });

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

  const edits = computePortEdits("PORT=3099\nOTHER=1\n", ports, used, portCtx);

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

  const edits = computePortEdits("", ports, used, portCtx);

  expect(edits).toEqual([
    ["PORT", "3002"],
    ["VITE_PORT", "5174"],
  ]);
});

test("computePortEdits integrates nextFreePort for partially used ranges", () => {
  const ports = [{ key: "PORT", base: 3000 }] as const;
  const used = new Map([["PORT", new Set([3000, 3002])]]);

  expect(computePortEdits("", ports, used, portCtx)).toEqual([["PORT", "3001"]]);
});

test("sibling env scanning skips non-integer and missing keys", () => {
  const ports = [{ key: "PORT", base: 4000 }] as const;

  const used = collectUsedPorts(
    ["PORT=4000\nOTHER=1\n", "PORT=4000.5\n", "DATABASE_URL=postgres://x\n"],
    ports,
  );

  expect(used.get("PORT")).toEqual(new Set([4000]));
});

test("resolvePortBase passes number through and calls function", () => {
  expect(resolvePortBase(3000, portCtx)).toBe(3000);
  expect(resolvePortBase((c) => (c.branch.startsWith("feat") ? 4000 : 3000), portCtx)).toBe(4000);
});

test("computePortEdits resolves function base", () => {
  const ports = [{ key: "PORT", base: (c: typeof portCtx) => (c.branch.startsWith("feat") ? 4000 : 3000) }];
  const used = new Map([["PORT", new Set([4000])]]);

  expect(computePortEdits("", ports, used, portCtx)).toEqual([["PORT", "4001"]]);
});

// probe returns `true` when a live listener answers (the port is busy).
const liveOn = (...busy: ReadonlyArray<number>) => (port: number) => Effect.succeed(busy.includes(port));
const nothingLive = (_port: number) => Effect.succeed(false);

test("pickFreePort returns the base when nothing is listening", async () => {
  const picked = await Effect.runPromise(pickFreePort(3000, new Set(), nothingLive, 20));
  expect(picked).toBe(3000);
});

test("pickFreePort skips a port with a live listener and returns the next free one", async () => {
  const picked = await Effect.runPromise(pickFreePort(3000, new Set(), liveOn(3000), 20));
  expect(picked).toBe(3001);
});

test("pickFreePort skips ports already in the used set", async () => {
  const picked = await Effect.runPromise(pickFreePort(3000, new Set([3000, 3001]), nothingLive, 20));
  expect(picked).toBe(3002);
});

test("pickFreePort records skipped live ports in the used set so the pick is reproducible", async () => {
  const used = new Set<number>();
  const picked = await Effect.runPromise(pickFreePort(3000, used, liveOn(3000, 3001), 20));
  expect(picked).toBe(3002);
  // The two live ports were fed back; the picked port itself is left out so a
  // downstream nextFreePort(base, used) recomputes the same 3002.
  expect(used).toEqual(new Set([3000, 3001]));
});

test("pickFreePort fails after maxAttempts consecutive live ports", async () => {
  const everythingLive = (_port: number) => Effect.succeed(true);
  await expect(Effect.runPromise(pickFreePort(3000, new Set(), everythingLive, 5))).rejects.toThrow();
});

test("resolvePortEdits reuses an existing target .env port without probing", async () => {
  let probed = false;
  const probe = (port: number) => {
    probed = true;
    return Effect.succeed(false);
  };
  const ports = [{ key: "PORT", base: 3000 }];
  const used = new Map([["PORT", new Set<number>()]]);

  const edits = await Effect.runPromise(resolvePortEdits("PORT=3099\n", ports, used, portCtx, probe));

  expect(edits).toEqual([["PORT", "3099"]]);
  expect(probed).toBe(false);
});

test("resolvePortEdits skips a port with a live listener even when no sibling .env claims it", async () => {
  const ports = [{ key: "PORT", base: 3000 }];
  const used = new Map([["PORT", new Set<number>()]]);

  const edits = await Effect.runPromise(resolvePortEdits("", ports, used, portCtx, liveOn(3000)));

  expect(edits).toEqual([["PORT", "3001"]]);
});

test("resolvePortEdits keeps two specs from colliding when the first probed port is live", async () => {
  // Both specs start from 3000 and 3000 has a live listener. Spec A advances to
  // 3001; spec B must not also land on 3001 — the chosen port feeds back.
  const ports = [
    { key: "A", base: 3000 },
    { key: "B", base: 3000 },
  ];
  const used = new Map([
    ["A", new Set<number>()],
    ["B", new Set<number>()],
  ]);

  const edits = await Effect.runPromise(resolvePortEdits("", ports, used, portCtx, liveOn(3000)));

  expect(edits).toEqual([
    ["A", "3001"],
    ["B", "3002"],
  ]);
});
