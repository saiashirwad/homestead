import { expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { launchAgent, launchFreeAgent, resolveSurfaceLabel } from "./agent.ts";
import { Herdr } from "./service.ts";
import { HerdrTest, HerdrTestHandle } from "./test.ts";
import { runAfterLaunch } from "../hooks.ts";
import { makeContext } from "../context.ts";
import { resolveAgentDefaults } from "../agent/defaults.ts";
import type { Plan } from "../types.ts";

const TestLayer = Layer.provideMerge(HerdrTest, BunServices.layer);

const fakePlan = (slug: string): Plan =>
  ({
    targetDir: "/tmp/wt",
    branch: slug,
    slug,
    envPath: "/tmp/wt/.env",
    sourcePath: "/tmp/wt/.env",
    sourceContent: "",
    reusedExistingEnv: false,
    fellBackToExample: false,
    envEdits: [],
  }) satisfies Plan;

test("runAfterLaunch calls hook with paneId when present", async () => {
  const seen: string[] = [];
  const hook = (c: { paneId: string }) => Effect.sync(() => {
    seen.push(c.paneId);
  });
  const ctx = makeContext({ repoName: "r", slug: "s", branch: "b", worktreeDir: "/w" });
  await Effect.runPromise(runAfterLaunch(hook, ctx, "pane-1").pipe(Effect.provide(TestLayer)));
  expect(seen).toEqual(["pane-1"]);
});

test("surfaceLabel default issue/pr/agent", () => {
  const item = { number: 3, url: "u", title: "t" } as any;
  const issueCtx = { ...makeContext({ repoName: "r", slug: "s", branch: "b", worktreeDir: "/w", item }), kind: "issue" as const, item };
  expect(resolveSurfaceLabel(undefined, issueCtx)).toBe("issue-3");
  const pr = { number: 9 } as any;
  const prCtx = { ...makeContext({ repoName: "r", slug: "s", branch: "b", worktreeDir: "/w", pr }), kind: "pr" as const, pr };
  expect(resolveSurfaceLabel(undefined, prCtx)).toBe("pr-9");
  expect(resolveSurfaceLabel((c) => `x-${c.kind}`, prCtx)).toBe("x-pr");
  const agentCtx = { ...makeContext({ repoName: "r", slug: "my-slug", branch: "b", worktreeDir: "/w" }), kind: "agent" as const };
  expect(resolveSurfaceLabel(undefined, agentCtx)).toBe("agent-my-slug");
});

const fastAgent = (overrides: Record<string, unknown> = {}) =>
  resolveAgentDefaults({ trustPrompt: false, readyTimeoutMs: 200, ...overrides });

// The spawn path seeds whatever string it's handed — never the issue template.
test("launchFreeAgent seeds the literal prompt verbatim", async () => {
  const sendText = await Effect.runPromise(
    Effect.gen(function* () {
      const handle = yield* HerdrTestHandle;
      yield* handle.script("pane-1", ["❯ "]);
      yield* launchFreeAgent({
        config: {},
        plan: fakePlan("my-slug"),
        slug: "my-slug",
        branch: "my-slug",
        repoName: "r",
        agent: fastAgent(),
        prompt: "do the thing",
      });
      return (yield* handle.journal()).sendText;
    }).pipe(Effect.provide(TestLayer)),
  );
  expect(sendText).toEqual([{ paneId: "pane-1", text: "do the thing" }]);
}, 20000);

// Refactor guard: the issue path still builds the issue-templated prompt.
test("launchAgent still seeds the issue-templated prompt", async () => {
  const item = { number: 7, url: "https://x/7", title: "Fix the thing" };
  const sendText = await Effect.runPromise(
    Effect.gen(function* () {
      const handle = yield* HerdrTestHandle;
      yield* handle.script("pane-1", ["❯ "]);
      yield* launchAgent({
        config: {},
        plan: fakePlan("7"),
        item,
        branch: "7",
        repoName: "r",
        agent: fastAgent(),
      });
      return (yield* handle.journal()).sendText;
    }).pipe(Effect.provide(TestLayer)),
  );
  expect(sendText.length).toBe(1);
  expect(sendText[0]!.text).toContain('#7: "Fix the thing"');
}, 20000);

// --- autonomous mode: wrapped pane command ----------------------------------

test("non-autonomous launch runs the agent binary directly", async () => {
  const runs = await Effect.runPromise(
    Effect.gen(function* () {
      const handle = yield* HerdrTestHandle;
      yield* handle.script("pane-1", ["❯ "]);
      yield* launchFreeAgent({
        config: {},
        plan: fakePlan("my-slug"),
        slug: "my-slug",
        branch: "my-slug",
        repoName: "r",
        agent: fastAgent(),
        prompt: "do the thing",
      });
      return (yield* handle.journal()).runs;
    }).pipe(Effect.provide(TestLayer)),
  );
  expect(runs.length).toBe(1);
  expect(runs[0]!.command).toBe("claude");
}, 20000);

test("autonomous launch wraps the pane command in sh -c with a finalize tail", async () => {
  const runs = await Effect.runPromise(
    Effect.gen(function* () {
      const handle = yield* HerdrTestHandle;
      yield* handle.script("pane-1", ["❯ "]);
      yield* launchFreeAgent({
        config: {},
        plan: fakePlan("my-slug"),
        slug: "my-slug",
        branch: "my-slug",
        repoName: "r",
        agent: fastAgent({ autonomous: true }),
        prompt: "do the thing",
      });
      return (yield* handle.journal()).runs;
    }).pipe(Effect.provide(TestLayer)),
  );
  expect(runs.length).toBe(1);
  expect(runs[0]!.command).toBe("sh");
  expect(runs[0]!.args[0]).toBe("-c");
  const script = runs[0]!.args[1]!;
  expect(script).toContain("'claude'");
  expect(script).toContain("agent finalize --agent-exit");
}, 20000);

// --- [dispatched] / [auto] routing for spawned (auto) agents ----------------

test("findOrCreateWorkspace reuses an existing workspace with the label", async () => {
  const { id, created } = await Effect.runPromise(
    Effect.gen(function* () {
      const handle = yield* HerdrTestHandle;
      yield* handle.setWorkspaces([{ label: "[dispatched]", workspace_id: "ws-existing" }]);
      const herdr = yield* Herdr;
      const id = yield* herdr.findOrCreateWorkspace("[dispatched]");
      return { id, created: (yield* handle.journal()).createdWorkspaces };
    }).pipe(Effect.provide(TestLayer)),
  );
  expect(id).toBe("ws-existing");
  expect(created).toEqual([]);
});

test("findOrCreateWorkspace creates a workspace when the label is absent, then reuses it", async () => {
  const { first, second, created } = await Effect.runPromise(
    Effect.gen(function* () {
      const handle = yield* HerdrTestHandle;
      const herdr = yield* Herdr;
      const first = yield* herdr.findOrCreateWorkspace("[dispatched]");
      const second = yield* herdr.findOrCreateWorkspace("[dispatched]");
      return { first, second, created: (yield* handle.journal()).createdWorkspaces };
    }).pipe(Effect.provide(TestLayer)),
  );
  expect(first).toBe(second);
  expect(created).toEqual(["[dispatched]"]);
});

test("launchFreeAgent with spawnedBy opens under [dispatched] with an [auto] label", async () => {
  const { surfaces, created } = await Effect.runPromise(
    Effect.gen(function* () {
      const handle = yield* HerdrTestHandle;
      yield* handle.script("pane-1", ["❯ "]);
      yield* launchFreeAgent({
        config: {},
        plan: fakePlan("my-slug"),
        slug: "my-slug",
        branch: "my-slug",
        repoName: "r",
        agent: fastAgent(),
        prompt: "do the thing",
        spawnedBy: "agent spawn",
      });
      const j = yield* handle.journal();
      return { surfaces: j.surfaces, created: j.createdWorkspaces };
    }).pipe(Effect.provide(TestLayer)),
  );
  expect(created).toEqual(["[dispatched]"]);
  expect(surfaces.length).toBe(1);
  expect(surfaces[0]!.kind).toBe("worktree");
  expect(surfaces[0]!.label).toBe("[auto] my-slug");
  // The surface is routed under the freshly-created [dispatched] workspace.
  expect(surfaces[0]!.workspaceId).toBe("ws-1");
}, 20000);

test("launchFreeAgent without spawnedBy stays in the current workspace, no [auto]", async () => {
  const surfaces = await Effect.runPromise(
    Effect.gen(function* () {
      const handle = yield* HerdrTestHandle;
      yield* handle.script("pane-1", ["❯ "]);
      yield* launchFreeAgent({
        config: {},
        plan: fakePlan("my-slug"),
        slug: "my-slug",
        branch: "my-slug",
        repoName: "r",
        agent: fastAgent(),
        prompt: "do the thing",
      });
      return (yield* handle.journal()).surfaces;
    }).pipe(Effect.provide(TestLayer)),
  );
  expect(surfaces.length).toBe(1);
  expect(surfaces[0]!.label).toBe("agent-my-slug");
  expect(surfaces[0]!.label.startsWith("[auto]")).toBe(false);
  expect(surfaces[0]!.workspaceId).toBeUndefined();
}, 20000);

test("auto launch prefixes a user surfaceLabel override with [auto] ", async () => {
  const surfaces = await Effect.runPromise(
    Effect.gen(function* () {
      const handle = yield* HerdrTestHandle;
      yield* handle.script("pane-1", ["❯ "]);
      yield* launchFreeAgent({
        config: {},
        plan: fakePlan("my-slug"),
        slug: "my-slug",
        branch: "my-slug",
        repoName: "r",
        agent: fastAgent({ surfaceLabel: () => "custom" }),
        prompt: "do the thing",
        spawnedBy: "agent spawn",
      });
      return (yield* handle.journal()).surfaces;
    }).pipe(Effect.provide(TestLayer)),
  );
  expect(surfaces[0]!.label).toBe("[auto] custom");
}, 20000);

test("runAfterLaunch is a no-op when hook undefined", async () => {
  const ctx = makeContext({ repoName: "r", slug: "s", branch: "b", worktreeDir: "/w" });
  await Effect.runPromise(runAfterLaunch(undefined, ctx, "pane-1").pipe(Effect.provide(TestLayer)));
  expect(true).toBe(true);
});
