import { Context, Effect, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { HerdrError, HerdrNotAvailable } from "./errors.ts";
import { makePolling } from "./poll.ts";
import {
  openWorkspaceIdForBranch,
  SurfaceCreatedSchema,
  type HerdrRuntimeEnv,
  type ReadSource,
  type SurfaceKind,
  WorktreeListSchema,
} from "./types.ts";

const requireHerdrPane = Effect.fn("herdr/require-pane")(function* () {
  if (process.env["HERDR_ENV"] !== "1") {
    return yield* new HerdrNotAvailable({
      reason: "[homestead] not inside a herdr pane (HERDR_ENV != 1) — run this from a herdr terminal.",
    });
  }
});

export class Herdr extends Context.Service<Herdr>()("Herdr", {
  make: Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const exec = (op: string, args: ReadonlyArray<string>) =>
      spawner
        .string(ChildProcess.make("herdr", args))
        .pipe(
          Effect.map((out) => out.trim()),
          Effect.mapError((cause) => new HerdrError({ op, cause })),
        );

    const decodeHerdr = <S extends Schema.Top>(op: string, schema: S, json: string) =>
      Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(json).pipe(
        Effect.mapError((cause) => new HerdrError({ op, cause })),
      );

    const paneRead = Effect.fn("herdr/pane-read")(function* (
      paneId: string,
      options?: { readonly source?: ReadSource; readonly lines?: number },
    ) {
      return yield* exec("pane.read", [
        "pane",
        "read",
        paneId,
        "--source",
        options?.source ?? "visible",
        ...(options?.lines ? ["--lines", String(options.lines)] : []),
      ]);
    });

    const polling = makePolling((paneId, options) => paneRead(paneId, options));

    const listWorktrees = Effect.fn("herdr/worktree-list")(function* (cwd: string) {
      const json = yield* exec("worktree.list", ["worktree", "list", "--cwd", cwd, "--json"]);
      const res = yield* decodeHerdr("worktree.list", WorktreeListSchema, json);
      return res.result.worktrees;
    });

    return {
      createSurface: Effect.fn("herdr/create-surface")(function* (
        kind: SurfaceKind,
        dir: string,
        label: string,
        runtime: HerdrRuntimeEnv = {
          workspaceId: process.env["HERDR_WORKSPACE_ID"],
          cwd: process.cwd(),
        },
      ) {
        yield* requireHerdrPane();
        const parent = runtime.workspaceId;
        const parentArg = parent === undefined ? ["--cwd", runtime.cwd] : ["--workspace", parent];
        let args: ReadonlyArray<string>;
        switch (kind) {
          case "tab":
            args = ["tab", "create", ...parentArg, "--cwd", dir, "--label", label, "--no-focus", "--json"];
            break;
          case "workspace":
            args = ["workspace", "create", "--cwd", dir, "--label", label, "--no-focus", "--json"];
            break;
          case "worktree":
            args = ["worktree", "open", ...parentArg, "--path", dir, "--label", label, "--no-focus", "--json"];
            break;
          default: {
            const _exhaustive: never = kind;
            return _exhaustive;
          }
        }
        const json = yield* exec("create-surface", args);
        const res = yield* decodeHerdr("create-surface", SurfaceCreatedSchema, json);
        return res.result.root_pane.pane_id;
      }),

      pane: {
        run: (paneId: string, command: string, ...args: ReadonlyArray<string>) =>
          exec("pane.run", ["pane", "run", paneId, command, ...args]).pipe(Effect.asVoid),

        sendText: (paneId: string, text: string) =>
          exec("pane.send-text", ["pane", "send-text", paneId, text]).pipe(Effect.asVoid),

        sendKeys: (paneId: string, ...keys: ReadonlyArray<string>) =>
          exec("pane.send-keys", ["pane", "send-keys", paneId, ...keys]).pipe(Effect.asVoid),

        read: paneRead,
      },

      worktree: {
        list: listWorktrees,
        remove: (workspaceId: string) =>
          exec("worktree.remove", ["worktree", "remove", "--workspace", workspaceId, "--force", "--json"]).pipe(
            Effect.asVoid,
          ),
        findOpenWorkspaceId: Effect.fn("herdr/worktree-find-open-workspace")(function* (cwd: string, branch: string) {
          const worktrees = yield* listWorktrees(cwd);
          return openWorkspaceIdForBranch(worktrees, branch);
        }),
      },

      waitForMarker: polling.waitForMarker,
      waitUntilGone: polling.waitUntilGone,
    };
  }),
}) {}
