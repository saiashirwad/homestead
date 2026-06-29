import { Context, Effect, Layer, Ref } from "effect";
import { HerdrError } from "./errors.ts";
import { makePolling } from "./poll.ts";
import { Herdr } from "./service.ts";
import type { HerdrRuntimeEnv, SurfaceKind, WorkspaceEntry, WorktreeEntry } from "./types.ts";

export interface HerdrTestJournal {
  readonly runs: ReadonlyArray<{ readonly paneId: string; readonly command: string; readonly args: ReadonlyArray<string> }>;
  readonly sendText: ReadonlyArray<{ readonly paneId: string; readonly text: string }>;
  readonly sendKeys: ReadonlyArray<{ readonly paneId: string; readonly keys: ReadonlyArray<string> }>;
  readonly removedWorkspaces: ReadonlyArray<string>;
  /** Every `createSurface` call, capturing the routing parent (runtime workspace id). */
  readonly surfaces: ReadonlyArray<{
    readonly kind: SurfaceKind;
    readonly label: string;
    readonly workspaceId: string | undefined;
  }>;
  /** Labels passed to `findOrCreateWorkspace` that triggered a fresh workspace. */
  readonly createdWorkspaces: ReadonlyArray<string>;
}

export interface HerdrTestApi {
  readonly script: (paneId: string, transcripts: ReadonlyArray<string>) => Effect.Effect<void>;
  /** Queue the agent_status sequence `pane get` returns for this pane (last value sticks). */
  readonly setAgentStatus: (paneId: string, statuses: ReadonlyArray<string>) => Effect.Effect<void>;
  readonly setWorktrees: (cwd: string, worktrees: ReadonlyArray<WorktreeEntry>) => Effect.Effect<void>;
  /** Seed existing herdr workspaces so `findOrCreateWorkspace` finds them by label. */
  readonly setWorkspaces: (workspaces: ReadonlyArray<WorkspaceEntry>) => Effect.Effect<void>;
  readonly journal: () => Effect.Effect<HerdrTestJournal>;
  /** Make the next (and subsequent) `worktree.remove` calls fail with this error; pass undefined to clear. */
  readonly failRemove: (error: HerdrError | undefined) => Effect.Effect<void>;
  /** Make `pane.read` for this pane fail with the given error; pass undefined to clear. */
  readonly failRead: (paneId: string, error: HerdrError | undefined) => Effect.Effect<void>;
  /** Make `pane.send-text` for this pane fail with the given error; pass undefined to clear. */
  readonly failSendText: (paneId: string, error: HerdrError | undefined) => Effect.Effect<void>;
}

export class HerdrTestHandle extends Context.Service<HerdrTestHandle, HerdrTestApi>()("HerdrTestHandle") {}

const emptyJournal = (): HerdrTestJournal => ({
  runs: [],
  sendText: [],
  sendKeys: [],
  removedWorkspaces: [],
  surfaces: [],
  createdWorkspaces: [],
});

const buildHerdrTest = Effect.gen(function* () {
  const nextPaneId = yield* Ref.make(1);
  const labelToPane = yield* Ref.make(new Map<string, string>());
  const readQueues = yield* Ref.make(new Map<string, ReadonlyArray<string>>());
  const readIndex = yield* Ref.make(new Map<string, number>());
  const statusQueues = yield* Ref.make(new Map<string, ReadonlyArray<string>>());
  const statusIndex = yield* Ref.make(new Map<string, number>());
  const worktreesByCwd = yield* Ref.make(new Map<string, ReadonlyArray<WorktreeEntry>>());
  const workspacesByLabel = yield* Ref.make(new Map<string, string>());
  const nextWorkspaceId = yield* Ref.make(1);
  const journal = yield* Ref.make(emptyJournal());
  const removeFailure = yield* Ref.make<HerdrError | undefined>(undefined);
  const readFailures = yield* Ref.make(new Map<string, HerdrError>());
  const sendTextFailures = yield* Ref.make(new Map<string, HerdrError>());

  const paneRead = Effect.fn("herdr-test/pane-read")(function* (
    paneId: string,
    _options?: { readonly source?: string; readonly lines?: number },
  ) {
    const failure = (yield* Ref.get(readFailures)).get(paneId);
    if (failure !== undefined) return yield* failure;
    const queues = yield* Ref.get(readQueues);
    const indices = yield* Ref.get(readIndex);
    const queue = queues.get(paneId);
    if (queue === undefined || queue.length === 0) {
      return "";
    }
    const index = indices.get(paneId) ?? 0;
    const next = index < queue.length ? queue[index] : queue[queue.length - 1];
    if (index < queue.length) {
      yield* Ref.update(readIndex, (map) => new Map(map).set(paneId, index + 1));
    }
    return next ?? "";
  });

  const paneGet = Effect.fn("herdr-test/pane-get")(function* (paneId: string) {
    const queues = yield* Ref.get(statusQueues);
    const indices = yield* Ref.get(statusIndex);
    const queue = queues.get(paneId);
    if (queue === undefined || queue.length === 0) {
      return undefined;
    }
    const index = indices.get(paneId) ?? 0;
    const next = index < queue.length ? queue[index] : queue[queue.length - 1];
    if (index < queue.length) {
      yield* Ref.update(statusIndex, (map) => new Map(map).set(paneId, index + 1));
    }
    return next;
  });

  const polling = makePolling((paneId, options) => paneRead(paneId, options));

  const handle: HerdrTestApi = {
    script: (paneId, transcripts) =>
      Effect.gen(function* () {
        yield* Ref.update(readQueues, (map) => new Map(map).set(paneId, transcripts));
        yield* Ref.update(readIndex, (map) => new Map(map).set(paneId, 0));
      }),

    setAgentStatus: (paneId, statuses) =>
      Effect.gen(function* () {
        yield* Ref.update(statusQueues, (map) => new Map(map).set(paneId, statuses));
        yield* Ref.update(statusIndex, (map) => new Map(map).set(paneId, 0));
      }),

    setWorktrees: (cwd, worktrees) =>
      Ref.update(worktreesByCwd, (map) => new Map(map).set(cwd, worktrees)),

    setWorkspaces: (workspaces) =>
      Ref.update(workspacesByLabel, (map) => {
        const next = new Map(map);
        for (const ws of workspaces) {
          if (ws.label != null) next.set(ws.label, ws.workspace_id);
        }
        return next;
      }),

    journal: () => Ref.get(journal),

    failRemove: (error) => Ref.set(removeFailure, error),

    failRead: (paneId, error) =>
      Ref.update(readFailures, (map) => {
        const next = new Map(map);
        if (error === undefined) next.delete(paneId);
        else next.set(paneId, error);
        return next;
      }),

    failSendText: (paneId, error) =>
      Ref.update(sendTextFailures, (map) => {
        const next = new Map(map);
        if (error === undefined) next.delete(paneId);
        else next.set(paneId, error);
        return next;
      }),
  };

  const herdr: typeof Herdr.Service = {
    createSurface: Effect.fn("herdr-test/create-surface")(function* (
      kind: SurfaceKind,
      _dir: string,
      label: string,
      runtime?: HerdrRuntimeEnv,
    ) {
      yield* Ref.update(journal, (j) => ({
        ...j,
        surfaces: [...j.surfaces, { kind, label, workspaceId: runtime?.workspaceId }],
      }));
      const labels = yield* Ref.get(labelToPane);
      const existing = labels.get(label);
      if (existing !== undefined) {
        return existing;
      }
      const id = yield* Ref.getAndUpdate(nextPaneId, (n) => n + 1);
      const paneId = `pane-${id}`;
      yield* Ref.update(labelToPane, (map) => new Map(map).set(label, paneId));
      return paneId;
    }),

    findOrCreateWorkspace: Effect.fn("herdr-test/find-or-create-workspace")(function* (label: string) {
      const existing = (yield* Ref.get(workspacesByLabel)).get(label);
      if (existing !== undefined) return existing;
      const n = yield* Ref.getAndUpdate(nextWorkspaceId, (x) => x + 1);
      const id = `ws-${n}`;
      yield* Ref.update(workspacesByLabel, (map) => new Map(map).set(label, id));
      yield* Ref.update(journal, (j) => ({
        ...j,
        createdWorkspaces: [...j.createdWorkspaces, label],
      }));
      return id;
    }),

    pane: {
      run: (paneId: string, command: string, ...args: ReadonlyArray<string>) =>
        Ref.update(journal, (j) => ({
          ...j,
          runs: [...j.runs, { paneId, command, args }],
        })),

      sendText: (paneId: string, text: string) =>
        Effect.gen(function* () {
          const failure = (yield* Ref.get(sendTextFailures)).get(paneId);
          if (failure !== undefined) return yield* failure;
          yield* Ref.update(journal, (j) => ({
            ...j,
            sendText: [...j.sendText, { paneId, text }],
          }));
        }),

      sendKeys: (paneId: string, ...keys: ReadonlyArray<string>) =>
        Ref.update(journal, (j) => ({
          ...j,
          sendKeys: [...j.sendKeys, { paneId, keys }],
        })),

      read: paneRead,

      get: paneGet,
    },

    worktree: {
      list: (cwd: string) => Ref.get(worktreesByCwd).pipe(Effect.map((map) => map.get(cwd) ?? [])),

      remove: (workspaceId: string) =>
        Effect.gen(function* () {
          const failure = yield* Ref.get(removeFailure);
          if (failure !== undefined) return yield* failure;
          yield* Ref.update(journal, (j) => ({
            ...j,
            removedWorkspaces: [...j.removedWorkspaces, workspaceId],
          }));
        }),

      findOpenWorkspaceId: Effect.fn("herdr-test/worktree-find-open-workspace")(function* (cwd: string, branch: string) {
        const worktrees = yield* Ref.get(worktreesByCwd).pipe(Effect.map((map) => map.get(cwd) ?? []));
        return worktrees.find((wt) => wt.branch === branch)?.open_workspace_id ?? undefined;
      }),
    },

    waitForMarker: polling.waitForMarker,
    waitUntilGone: polling.waitUntilGone,
  };

  return { herdr, handle };
});

export const HerdrTest = Layer.effectContext(
  buildHerdrTest.pipe(
    Effect.map(({ herdr, handle }) => Context.make(Herdr, herdr).pipe(Context.add(HerdrTestHandle, handle))),
  ),
);
