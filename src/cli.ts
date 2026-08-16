#!/usr/bin/env bun
import { BunRuntime } from "@effect/platform-bun"
import { Console, Effect, Option } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import * as crypto from "node:crypto"
import pkg from "../package.json" with { type: "json" }
import { initRepo } from "./init.ts"
import { makeClient } from "./rpc/client.ts"
import { getDefaultSocketPath } from "./rpc/shared.ts"
import { makeServer } from "./rpc/server.ts"
import { resolveRepo } from "./worktree/repo.ts"
import { WorktreeManager } from "./worktree/manager.ts"
import { AppLayer } from "./runtime.ts"

const initCommand = Command.make("init", {}, () =>
  Effect.gen(function* () {
    const repo = yield* resolveRepo()
    yield* initRepo(repo.primaryRoot)
  }),
).pipe(Command.withDescription("one-time: scaffold a starter homestead.config.ts"))

const pingCommand = Command.make(
  "ping",
  {
    socket: Flag.optional(Flag.string("socket")).pipe(
      Flag.withDescription("custom socket path (default: ~/.homestead/run/daemon.sock)"),
    ),
  },
  ({ socket }) =>
    Effect.gen(function* () {
      const socketPath = Option.getOrElse(socket, getDefaultSocketPath)
      const client = yield* makeClient(socketPath)
      const res = yield* client.ping()
      yield* Console.log(`✓ Daemon is alive (timestamp: ${res.timestamp})`)
    }),
).pipe(Command.withDescription("check if the Homestead daemon is running"))

const shutdownCommand = Command.make(
  "shutdown",
  {
    socket: Flag.optional(Flag.string("socket")).pipe(
      Flag.withDescription("custom socket path (default: ~/.homestead/run/daemon.sock)"),
    ),
  },
  ({ socket }) =>
    Effect.gen(function* () {
      const socketPath = Option.getOrElse(socket, getDefaultSocketPath)
      const client = yield* makeClient(socketPath)
      yield* client.shutdown()
      yield* Console.log("✓ Daemon shut down successfully")
    }),
).pipe(Command.withDescription("stop the running Homestead daemon"))

const serverCommand = Command.make(
  "server",
  {
    socket: Flag.optional(Flag.string("socket")).pipe(
      Flag.withDescription("custom socket path (default: ~/.homestead/run/daemon.sock)"),
    ),
  },
  ({ socket }) =>
    Effect.gen(function* () {
      const socketPath = Option.getOrElse(socket, getDefaultSocketPath)
      yield* Effect.scoped(makeServer(socketPath))
    }),
).pipe(Command.withDescription("run the Homestead RPC daemon over Unix Domain Socket"))

const createCommand = Command.make(
  "create",
  {
    name: Argument.string("name").pipe(Argument.withDescription("worktree / branch name")),
    from: Flag.optional(Flag.string("from")).pipe(
      Flag.withDescription("base ref to branch from (default: repo default branch)"),
    ),
    repo: Flag.optional(Flag.string("repo")).pipe(
      Flag.withDescription("repository root (default: current working directory repo)"),
    ),
  },
  ({ name, from, repo }) =>
    Effect.gen(function* () {
      const repoRoot = Option.getOrElse(repo, () => process.cwd())
      const manager = yield* WorktreeManager
      const canonicalRepo = yield* manager.validateRepoRoot(repoRoot)

      const info = yield* manager.createWorktree({
        requestId: crypto.randomUUID(),
        repoRoot: canonicalRepo,
        name,
        from: Option.getOrUndefined(from),
      })

      const portKeys = Object.keys(info.ports)
      const portsStr =
        portKeys.length > 0
          ? ` (ports: ${portKeys.map((k) => `${k}=${info.ports[k]}`).join(", ")})`
          : ""
      yield* Console.log(`\n✅ Worktree "${info.name}" ready at ${info.path}${portsStr}`)
    }),
).pipe(
  Command.withDescription("provision an isolated worktree with allocated ports and derived .env"),
)

const listCommand = Command.make(
  "list",
  {
    repo: Flag.optional(Flag.string("repo")).pipe(
      Flag.withDescription("repository root (default: current working directory repo)"),
    ),
  },
  ({ repo }) =>
    Effect.gen(function* () {
      const repoRoot = Option.getOrElse(repo, () => process.cwd())
      const manager = yield* WorktreeManager
      const canonicalRepo = yield* manager.validateRepoRoot(repoRoot)
      const worktrees = yield* manager.listWorktrees({ repoRoot: canonicalRepo })

      if (worktrees.length === 0) {
        yield* Console.log("No worktrees found.")
        return
      }

      yield* Console.log(
        "\nNAME                 BRANCH               PORTS                        PATH",
      )
      yield* Console.log(
        "-------------------- -------------------- ---------------------------- ----------------------------------------",
      )
      for (const wt of worktrees) {
        const portsStr =
          Object.entries(wt.ports)
            .map(([k, v]) => `${k}=${v}`)
            .join(" ") || "—"
        const namePad = wt.name.padEnd(20).slice(0, 20)
        const branchPad = wt.branch.padEnd(20).slice(0, 20)
        const portsPad = portsStr.padEnd(28).slice(0, 28)
        yield* Console.log(`${namePad} ${branchPad} ${portsPad} ${wt.path}`)
      }
      yield* Console.log("")
    }),
).pipe(Command.withDescription("list active worktrees in the repository"))

const lsCommand = Command.make(
  "ls",
  {
    repo: Flag.optional(Flag.string("repo")).pipe(
      Flag.withDescription("repository root (default: current working directory repo)"),
    ),
  },
  ({ repo }) =>
    Effect.gen(function* () {
      const repoRoot = Option.getOrElse(repo, () => process.cwd())
      const manager = yield* WorktreeManager
      const canonicalRepo = yield* manager.validateRepoRoot(repoRoot)
      const worktrees = yield* manager.listWorktrees({ repoRoot: canonicalRepo })

      if (worktrees.length === 0) {
        yield* Console.log("No worktrees found.")
        return
      }

      yield* Console.log(
        "\nNAME                 BRANCH               PORTS                        PATH",
      )
      yield* Console.log(
        "-------------------- -------------------- ---------------------------- ----------------------------------------",
      )
      for (const wt of worktrees) {
        const portsStr =
          Object.entries(wt.ports)
            .map(([k, v]) => `${k}=${v}`)
            .join(" ") || "—"
        const namePad = wt.name.padEnd(20).slice(0, 20)
        const branchPad = wt.branch.padEnd(20).slice(0, 20)
        const portsPad = portsStr.padEnd(28).slice(0, 28)
        yield* Console.log(`${namePad} ${branchPad} ${portsPad} ${wt.path}`)
      }
      yield* Console.log("")
    }),
).pipe(Command.withDescription("alias for `list`"))

const rmCommand = Command.make(
  "rm",
  {
    name: Argument.string("name").pipe(Argument.withDescription("worktree name to remove")),
    repo: Flag.optional(Flag.string("repo")).pipe(
      Flag.withDescription("repository root (default: current working directory repo)"),
    ),
    force: Flag.boolean("force").pipe(
      Flag.withDescription("force removal even for protected branches (main/master)"),
    ),
  },
  ({ name, repo, force }) =>
    Effect.gen(function* () {
      const repoRoot = Option.getOrElse(repo, () => process.cwd())
      const manager = yield* WorktreeManager
      const canonicalRepo = yield* manager.validateRepoRoot(repoRoot)

      yield* manager.removeWorktree({
        requestId: crypto.randomUUID(),
        repoRoot: canonicalRepo,
        name,
        force,
      })

      yield* Console.log(`\n✅ Worktree "${name}" removed successfully`)
    }),
).pipe(Command.withDescription("remove a worktree and clean up its resources"))

const homestead = Command.make("homestead", {}).pipe(
  Command.withDescription("deterministic git-worktree isolation with port allocation & RPC daemon"),
  Command.withSubcommands([
    initCommand,
    createCommand,
    listCommand,
    lsCommand,
    rmCommand,
    serverCommand,
    pingCommand,
    shutdownCommand,
  ]),
)

const program = Command.run(homestead, { version: pkg.version }).pipe(Effect.provide(AppLayer))

BunRuntime.runMain(program)
