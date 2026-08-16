#!/usr/bin/env bun
import { BunRuntime } from "@effect/platform-bun"
import { Console, Effect, Fiber, Option, Stream } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import * as crypto from "node:crypto"
import pkg from "../package.json" with { type: "json" }
import { initRepo } from "./init.ts"
import { makeClient } from "./rpc/client.ts"
import { getDefaultSocketPath } from "./rpc/shared.ts"
import { makeServer } from "./rpc/server.ts"
import { resolveRepo } from "./worktree/repo.ts"
import { WorkspaceManager } from "./workspace/manager.ts"
import { AppLayer } from "./runtime.ts"
import type { HomesteadClient } from "./rpc/shared.ts"
import type * as Scope from "effect/Scope"

const socketFlag = Flag.optional(Flag.string("socket")).pipe(
  Flag.withDescription("custom socket path (default: ~/.homestead/run/daemon.sock)"),
)

const withClient = <A>(
  socketPath: string,
  use: (client: HomesteadClient) => Effect.Effect<A, unknown, Scope.Scope>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const client = yield* makeClient(socketPath)
      return yield* use(client)
    }),
  )

const workspaceClient = (client: HomesteadClient, projectRoot: string, name: string) =>
  client.getWorkspace({ projectRoot, name })

const printCommandEvent = (event: { readonly data?: string | undefined }) =>
  Effect.sync(() => {
    if (event.data !== undefined) process.stdout.write(event.data)
  })

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
      const res = yield* client.ping
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
      yield* client.shutdown
      yield* Console.log("✓ Daemon shut down successfully")
    }),
).pipe(Command.withDescription("stop the running Homestead daemon"))

const execCommand = Command.make(
  "exec",
  {
    workspace: Argument.string("workspace"),
    command: Argument.string("command").pipe(Argument.variadic({ min: 1 })),
    detach: Flag.boolean("detach").pipe(
      Flag.withDescription("start the command and return without following its output"),
    ),
    repo: Flag.optional(Flag.string("repo")).pipe(
      Flag.withDescription("repository root (default: current working directory repo)"),
    ),
    socket: socketFlag,
  },
  ({ workspace, command, detach, repo, socket }) => {
    const socketPath = Option.getOrElse(socket, getDefaultSocketPath)
    const projectRoot = Option.getOrElse(repo, () => process.cwd())
    return withClient(socketPath, (client) =>
      Effect.gen(function* () {
        const info = yield* workspaceClient(client, projectRoot, workspace)
        const run = yield* client.startCommand({
          workspaceId: info.id,
          command: command[0],
          args: command.slice(1),
        })
        if (detach) {
          yield* Console.log(run.id)
          return
        }
        yield* Stream.runForEach(
          client.streamCommandEvents({
            workspaceId: info.id,
            runId: run.id,
            follow: true,
          }),
          printCommandEvent,
        )
        const completed = yield* client.getCommandRun({
          workspaceId: info.id,
          runId: run.id,
        })
        if (completed.exitCode !== undefined && completed.exitCode !== 0) {
          yield* Console.error(`Command exited with status ${completed.exitCode}`)
        }
      }),
    )
  },
).pipe(Command.withDescription("run a command inside a Workspace"))

const shellCommand = Command.make(
  "shell",
  {
    workspace: Argument.string("workspace"),
    repo: Flag.optional(Flag.string("repo")).pipe(
      Flag.withDescription("repository root (default: current working directory repo)"),
    ),
    socket: socketFlag,
  },
  ({ workspace, repo, socket }) => {
    const socketPath = Option.getOrElse(socket, getDefaultSocketPath)
    const projectRoot = Option.getOrElse(repo, () => process.cwd())
    return withClient(socketPath, (client) =>
      Effect.gen(function* () {
        const info = yield* workspaceClient(client, projectRoot, workspace)
        const run = yield* client.startCommand({
          workspaceId: info.id,
          command: process.env.SHELL ?? "sh",
          args: [],
        })
        yield* Console.log(`Command Run ${run.id} started. Use Ctrl-D to close the shell.`)
        const context = yield* Effect.context<Scope.Scope>()
        const inputFiber = yield* Effect.forkChild(
          Effect.callback<void>((resume) => {
            const onData = (data: string | Buffer) => {
              Effect.runForkWith(context)(
                Effect.provideContext(
                  client
                    .writeCommandInput({
                      workspaceId: info.id,
                      runId: run.id,
                      data: data.toString(),
                    })
                    .pipe(Effect.ignore),
                  context,
                ),
              )
            }
            const onEnd = () => {
              Effect.runForkWith(context)(
                Effect.provideContext(
                  client
                    .writeCommandInput({
                      workspaceId: info.id,
                      runId: run.id,
                      data: "\u0004",
                    })
                    .pipe(Effect.ignore),
                  context,
                ),
              )
              resume(Effect.void)
            }
            process.stdin.setEncoding("utf8")
            process.stdin.on("data", onData)
            process.stdin.once("end", onEnd)
            return Effect.sync(() => {
              process.stdin.off("data", onData)
              process.stdin.off("end", onEnd)
            })
          }),
        )
        yield* Stream.runForEach(
          client.streamCommandEvents({
            workspaceId: info.id,
            runId: run.id,
            follow: true,
          }),
          printCommandEvent,
        )
        yield* Fiber.interrupt(inputFiber)
      }),
    )
  },
).pipe(Command.withDescription("start a shell inside a Workspace"))

const psCommand = Command.make(
  "ps",
  {
    workspace: Argument.string("workspace"),
    repo: Flag.optional(Flag.string("repo")).pipe(
      Flag.withDescription("repository root (default: current working directory repo)"),
    ),
    socket: socketFlag,
  },
  ({ workspace, repo, socket }) => {
    const socketPath = Option.getOrElse(socket, getDefaultSocketPath)
    const projectRoot = Option.getOrElse(repo, () => process.cwd())
    return withClient(socketPath, (client) =>
      Effect.gen(function* () {
        const info = yield* workspaceClient(client, projectRoot, workspace)
        const runs = yield* client.listCommandRuns({ workspaceId: info.id })
        if (runs.length === 0) {
          yield* Console.log("No Command Runs.")
          return
        }
        yield* Console.log("RUN ID                                 STATE       COMMAND")
        for (const run of runs) {
          yield* Console.log(
            `${run.id.padEnd(38)} ${run.state.padEnd(11)} ${[run.command, ...run.args].join(" ")}`,
          )
        }
      }),
    )
  },
).pipe(Command.withDescription("list Command Runs in a Workspace"))

const logsCommand = Command.make(
  "logs",
  {
    workspace: Argument.string("workspace"),
    runId: Argument.string("run"),
    follow: Flag.boolean("follow").pipe(Flag.withDescription("continue until the run exits")),
    since: Flag.optional(Flag.integer("since")).pipe(
      Flag.withDescription("replay events after this sequence number"),
    ),
    repo: Flag.optional(Flag.string("repo")).pipe(
      Flag.withDescription("repository root (default: current working directory repo)"),
    ),
    socket: socketFlag,
  },
  ({ workspace, runId, follow, since, repo, socket }) => {
    const socketPath = Option.getOrElse(socket, getDefaultSocketPath)
    const projectRoot = Option.getOrElse(repo, () => process.cwd())
    return withClient(socketPath, (client) =>
      Effect.gen(function* () {
        const info = yield* workspaceClient(client, projectRoot, workspace)
        yield* Stream.runForEach(
          client.streamCommandEvents({
            workspaceId: info.id,
            runId,
            since: Option.getOrUndefined(since),
            follow,
          }),
          printCommandEvent,
        )
      }),
    )
  },
).pipe(Command.withDescription("replay Command Run output"))

const cancelCommand = Command.make(
  "cancel",
  {
    workspace: Argument.string("workspace"),
    runId: Argument.string("run"),
    repo: Flag.optional(Flag.string("repo")).pipe(
      Flag.withDescription("repository root (default: current working directory repo)"),
    ),
    socket: socketFlag,
  },
  ({ workspace, runId, repo, socket }) => {
    const socketPath = Option.getOrElse(socket, getDefaultSocketPath)
    const projectRoot = Option.getOrElse(repo, () => process.cwd())
    return withClient(socketPath, (client) =>
      Effect.gen(function* () {
        const info = yield* workspaceClient(client, projectRoot, workspace)
        yield* client.cancelCommand({ workspaceId: info.id, runId })
        yield* Console.log(`✓ Command Run ${runId} cancelled`)
      }),
    )
  },
).pipe(Command.withDescription("cancel a running Command Run"))

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
    name: Argument.string("name").pipe(Argument.withDescription("Workspace / branch name")),
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
      const manager = yield* WorkspaceManager
      const canonicalRepo = yield* manager.validateProjectRoot(repoRoot)

      const info = yield* manager.createWorkspace({
        requestId: crypto.randomUUID(),
        projectRoot: canonicalRepo,
        name,
        from: Option.getOrUndefined(from),
      })

      const portKeys = Object.keys(info.ports)
      const portsStr =
        portKeys.length > 0
          ? ` (ports: ${portKeys.map((k) => `${k}=${info.ports[k]}`).join(", ")})`
          : ""
      yield* Console.log(
        `\n✅ Workspace "${info.name}" ready${info.rootPath === undefined ? "" : ` at ${info.rootPath}`}${portsStr}`,
      )
    }),
).pipe(
  Command.withDescription("provision an isolated Workspace with allocated ports and derived .env"),
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
      const manager = yield* WorkspaceManager
      const canonicalRepo = yield* manager.validateProjectRoot(repoRoot)
      const workspaces = yield* manager.listWorkspaces({ projectRoot: canonicalRepo })

      if (workspaces.length === 0) {
        yield* Console.log("No Workspaces found.")
        return
      }

      yield* Console.log(
        "\nNAME                 BRANCH               PORTS                        PATH",
      )
      yield* Console.log(
        "-------------------- -------------------- ---------------------------- ----------------------------------------",
      )
      for (const workspace of workspaces) {
        const portsStr =
          Object.entries(workspace.ports)
            .map(([k, v]) => `${k}=${v}`)
            .join(" ") || "—"
        const namePad = workspace.name.padEnd(20).slice(0, 20)
        const branchPad = workspace.branch.padEnd(20).slice(0, 20)
        const portsPad = portsStr.padEnd(28).slice(0, 28)
        yield* Console.log(`${namePad} ${branchPad} ${portsPad} ${workspace.rootPath ?? "—"}`)
      }
      yield* Console.log("")
    }),
).pipe(Command.withDescription("list active Workspaces in the Project"))

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
      const manager = yield* WorkspaceManager
      const canonicalRepo = yield* manager.validateProjectRoot(repoRoot)
      const workspaces = yield* manager.listWorkspaces({ projectRoot: canonicalRepo })

      if (workspaces.length === 0) {
        yield* Console.log("No Workspaces found.")
        return
      }

      yield* Console.log(
        "\nNAME                 BRANCH               PORTS                        PATH",
      )
      yield* Console.log(
        "-------------------- -------------------- ---------------------------- ----------------------------------------",
      )
      for (const workspace of workspaces) {
        const portsStr =
          Object.entries(workspace.ports)
            .map(([k, v]) => `${k}=${v}`)
            .join(" ") || "—"
        const namePad = workspace.name.padEnd(20).slice(0, 20)
        const branchPad = workspace.branch.padEnd(20).slice(0, 20)
        const portsPad = portsStr.padEnd(28).slice(0, 28)
        yield* Console.log(`${namePad} ${branchPad} ${portsPad} ${workspace.rootPath ?? "—"}`)
      }
      yield* Console.log("")
    }),
).pipe(Command.withDescription("alias for `list`"))

const rmCommand = Command.make(
  "rm",
  {
    name: Argument.string("name").pipe(Argument.withDescription("Workspace name to remove")),
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
      const manager = yield* WorkspaceManager
      const canonicalRepo = yield* manager.validateProjectRoot(repoRoot)

      yield* manager.removeWorkspace({
        requestId: crypto.randomUUID(),
        projectRoot: canonicalRepo,
        name,
        force,
      })

      yield* Console.log(`\n✅ Workspace "${name}" removed successfully`)
    }),
).pipe(Command.withDescription("remove a Workspace and clean up its resources"))

const inspectCommand = Command.make(
  "inspect",
  {
    name: Argument.string("name").pipe(Argument.withDescription("Workspace name")),
    repo: Flag.optional(Flag.string("repo")).pipe(
      Flag.withDescription("Project root (default: current working directory Project)"),
    ),
  },
  ({ name, repo }) =>
    Effect.gen(function* () {
      const projectRoot = Option.getOrElse(repo, () => process.cwd())
      const manager = yield* WorkspaceManager
      const workspace = yield* manager.getWorkspace({ projectRoot, name })
      yield* Console.log(`Workspace: ${workspace.name}`)
      yield* Console.log(`ID:        ${workspace.id}`)
      yield* Console.log(`State:     ${workspace.state}`)
      yield* Console.log(`Provider:  ${workspace.provider}`)
      yield* Console.log(
        `Isolation: ${workspace.providerCapabilities.filesystemIsolation} filesystem, ${workspace.providerCapabilities.networkIsolation} network`,
      )
      yield* Console.log(`Project:   ${workspace.projectRoot}`)
      yield* Console.log(`Branch:    ${workspace.branch}`)
      yield* Console.log(`Base:      ${workspace.baseRevision}`)
      yield* Console.log(`Root:      ${workspace.rootPath ?? "not exposed"}`)
    }),
).pipe(Command.withDescription("inspect one managed Workspace"))

const homestead = Command.make("homestead", {}).pipe(
  Command.withDescription("isolated, reproducible Workspaces with a typed control plane"),
  Command.withSubcommands([
    initCommand,
    createCommand,
    listCommand,
    lsCommand,
    inspectCommand,
    rmCommand,
    serverCommand,
    pingCommand,
    shutdownCommand,
    shellCommand,
    execCommand,
    psCommand,
    logsCommand,
    cancelCommand,
  ]),
)

const program = Command.run(homestead, { version: pkg.version }).pipe(Effect.provide(AppLayer))

BunRuntime.runMain(program)
