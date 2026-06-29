import { Context, Effect, Layer, Ref } from "effect";
import { HerdrError } from "./errors.ts";
import { makePolling } from "./poll.ts";
import { Herdr } from "./service.ts";
import type { SurfaceKind, WorktreeEntry } from "./types.ts";

export interface HerdrTestJournal {
  readonly runs: ReadonlyArray<{ readonly paneId: string; readonly command: string; readonly args: ReadonlyArray<string> }>;
  readonly sendText: ReadonlyArray<{ readonly paneId: string; readonly text: string }>;
  readonly sendKeys: ReadonlyArray<{ readonly paneId: string; readonly keys: ReadonlyArray<string> }>;
  readonly removedWorkspaces: ReadonlyArray<string>;
}

export interface HerdrTestApi {
  readonly script: (paneId: string, transcripts: ReadonlyArray<string>) => Effect.Effect<void>;
  readonly setWorktrees: (cwd: string, worktrees: ReadonlyArray<WorktreeEntry>) => Effect.Effect<void>;
  readonly journal: () => Effect.Effect<HerdrTestJournal>;
  /** Make the next (and subsequent) `worktree.remove` calls fail with this error; pass undefined to clear. */
  readonly failRemove: (error: HerdrError | undefined) => Effect.Effect<void>;
}

export class HerdrTestHandle extends Context.Service<HerdrTestHandle, HerdrTestApi>()("HerdrTestHandle") {}

const emptyJournal = (): HerdrTestJournal => ({
  runs: [],
  sendText: [],
  sendKeys: [],
  removedWorkspaces: [],
});

const buildHerdrTest = Effect.gen(function* () {
  const nextPaneId = yield* Ref.make(1);
  const labelToPane = yield* Ref.make(new Map<string, string>());
  const readQueues = yield* Ref.make(new Map<string, ReadonlyArray<string>>());
  const readIndex = yield* Ref.make(new Map<string, number>());
  const worktreesByCwd = yield* Ref.make(new Map<string, ReadonlyArray<WorktreeEntry>>());
  const journal = yield* Ref.make(emptyJournal());
  const removeFailure = yield* Ref.make<HerdrError | undefined>(undefined);

  const paneRead = Effect.fn("herdr-test/pane-read")(function* (
    paneId: string,
    _options?: { readonly source?: string; readonly lines?: number },
  ) {
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

  const polling = makePolling((paneId, options) => paneRead(paneId, options));

  const handle: HerdrTestApi = {
    script: (paneId, transcripts) =>
      Effect.gen(function* () {
        yield* Ref.update(readQueues, (map) => new Map(map).set(paneId, transcripts));
        yield* Ref.update(readIndex, (map) => new Map(map).set(paneId, 0));
      }),

    setWorktrees: (cwd, worktrees) =>
      Ref.update(worktreesByCwd, (map) => new Map(map).set(cwd, worktrees)),

    journal: () => Ref.get(journal),

    failRemove: (error) => Ref.set(removeFailure, error),
  };

  const herdr: typeof Herdr.Service = {
    createSurface: Effect.fn("herdr-test/create-surface")(function* (_kind: SurfaceKind, _dir: string, label: string) {
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

    pane: {
      run: (paneId: string, command: string, ...args: ReadonlyArray<string>) =>
        Ref.update(journal, (j) => ({
          ...j,
          runs: [...j.runs, { paneId, command, args }],
        })),

      sendText: (paneId: string, text: string) =>
        Ref.update(journal, (j) => ({
          ...j,
          sendText: [...j.sendText, { paneId, text }],
        })),

      sendKeys: (paneId: string, ...keys: ReadonlyArray<string>) =>
        Ref.update(journal, (j) => ({
          ...j,
          sendKeys: [...j.sendKeys, { paneId, keys }],
        })),

      read: paneRead,
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
