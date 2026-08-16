import { Cause, Context, Effect, Layer, Queue, Scope } from "effect"
import * as childProcess from "node:child_process"
import * as nodeFs from "node:fs"
import * as nodeOs from "node:os"
import * as nodePath from "node:path"
import { randomUUID } from "node:crypto"
import { CommandInputFailure, CommandNotFound, CommandStartFailure } from "../errors.ts"
import { CommandEvent, CommandRun } from "../types.ts"

export interface CommandRuntimeOptions {
  readonly filePath?: string | undefined
  readonly maxEvents?: number | undefined
  readonly maxOutputBytes?: number | undefined
}

export interface StartCommandRequest {
  readonly workspaceId: string
  readonly rootPath: string
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  readonly cwdPath: string
  readonly env?: Readonly<Record<string, string>> | undefined
}

export interface CommandEventsRequest {
  readonly workspaceId: string
  readonly runId: string
  readonly since?: number | undefined
  readonly follow?: boolean | undefined
}

export interface CommandRuntimeApi {
  readonly filePath: string
  readonly start: (request: StartCommandRequest) => Effect.Effect<CommandRun, CommandStartFailure>
  readonly get: (workspaceId: string, runId: string) => Effect.Effect<CommandRun, CommandNotFound>
  readonly list: (workspaceId: string) => Effect.Effect<ReadonlyArray<CommandRun>>
  readonly input: (
    workspaceId: string,
    runId: string,
    data: string,
  ) => Effect.Effect<void, CommandNotFound | CommandInputFailure>
  readonly cancel: (workspaceId: string, runId: string) => Effect.Effect<void, CommandNotFound>
  readonly cancelWorkspace: (workspaceId: string) => Effect.Effect<void>
  readonly events: (
    request: CommandEventsRequest,
  ) => Effect.Effect<Queue.Dequeue<CommandEvent, Cause.Done>, CommandNotFound, Scope.Scope>
  readonly reconcile: Effect.Effect<void>
}

export class CommandRuntime extends Context.Service<CommandRuntime, CommandRuntimeApi>()(
  "homestead/workspace/commands/CommandRuntime",
) {}

interface PersistedCommand {
  readonly run: CommandRun
  readonly events: ReadonlyArray<CommandEvent>
}

interface CommandStateFile {
  readonly version: 1
  readonly runs: ReadonlyArray<PersistedCommand>
}

interface RuntimeCommand {
  run: CommandRun
  events: Array<CommandEvent>
  readonly subscribers: Set<Queue.Queue<CommandEvent, Cause.Done>>
  readonly process?: childProcess.ChildProcessWithoutNullStreams | undefined
}

const DEFAULT_MAX_EVENTS = 4096
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024

export const getDefaultCommandRuntimePath = (): string => {
  const stateDirectory = process.env.HOMESTEAD_STATE_DIR
  return nodePath.join(
    stateDirectory ?? nodePath.join(nodeOs.homedir(), ".homestead", "state"),
    "commands.json",
  )
}

const terminal = (run: CommandRun): boolean => run.state !== "running"

const commandNotFound = (workspaceId: string, runId: string): CommandNotFound =>
  CommandNotFound.make({
    workspaceId,
    runId,
    message: `Command Run "${runId}" was not found in Workspace "${workspaceId}"`,
  })

const startFailure = (workspaceId: string, cause: unknown): CommandStartFailure =>
  CommandStartFailure.make({
    workspaceId,
    message: `Failed to start command: ${String(cause)}`,
  })

const inputFailure = (workspaceId: string, runId: string, cause: unknown): CommandInputFailure =>
  CommandInputFailure.make({
    workspaceId,
    runId,
    message: `Could not write input to Command Run "${runId}": ${String(cause)}`,
  })

const readState = (filePath: string): Array<PersistedCommand> => {
  if (!nodeFs.existsSync(filePath)) return []
  try {
    const raw = JSON.parse(nodeFs.readFileSync(filePath, "utf8")) as CommandStateFile
    if (raw.version !== 1 || !Array.isArray(raw.runs)) return []
    return raw.runs.filter(
      (entry): entry is PersistedCommand =>
        entry !== null && typeof entry === "object" && "run" in entry && "events" in entry,
    )
  } catch {
    return []
  }
}

const makeRun = (run: CommandRun, changes: Partial<CommandRun>): CommandRun =>
  CommandRun.make({
    ...run,
    ...changes,
  })

export const make = (options: CommandRuntimeOptions = {}) =>
  Effect.gen(function* () {
    const initialized = yield* Effect.sync(() => {
      const filePath = options.filePath ?? getDefaultCommandRuntimePath()
      const maxEvents = Math.max(1, options.maxEvents ?? DEFAULT_MAX_EVENTS)
      const maxOutputBytes = Math.max(1, options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES)
      const commands = new Map<string, RuntimeCommand>()

      const trimEvents = (events: Array<CommandEvent>): Array<CommandEvent> => {
        let outputBytes = events.reduce(
          (total, event) => total + (event.data === undefined ? 0 : Buffer.byteLength(event.data)),
          0,
        )
        while (events.length > maxEvents || outputBytes > maxOutputBytes) {
          const removed = events.shift()
          if (removed?.data !== undefined) outputBytes -= Buffer.byteLength(removed.data)
        }
        return events
      }

      const persistUnsafe = () => {
        try {
          nodeFs.mkdirSync(nodePath.dirname(filePath), { recursive: true })
          const tempPath = `${filePath}.${process.pid}.tmp`
          const state: CommandStateFile = {
            version: 1,
            runs: Array.from(commands.values()).map(({ run, events }) => ({ run, events })),
          }
          nodeFs.writeFileSync(tempPath, `${JSON.stringify(state)}\n`)
          nodeFs.renameSync(tempPath, filePath)
        } catch (cause) {
          console.error(`[homestead] Could not persist Command Runs: ${String(cause)}`)
        }
      }

      const appendEvent = (
        command: RuntimeCommand,
        type: CommandEvent["type"],
        fields: Pick<CommandEvent, "data" | "exitCode" | "signal"> = {},
      ) => {
        const previous = command.events.at(-1)
        const event = CommandEvent.make({
          runId: command.run.id,
          sequence: (previous?.sequence ?? 0) + 1,
          type,
          ...fields,
        })
        command.events = trimEvents([...command.events, event])
        persistUnsafe()
        for (const subscriber of command.subscribers) {
          Queue.offerUnsafe(subscriber, event)
        }
        if (terminal(command.run)) {
          for (const subscriber of command.subscribers) {
            Queue.endUnsafe(subscriber)
          }
          command.subscribers.clear()
        }
      }

      for (const persisted of readState(filePath)) {
        const run =
          persisted.run.state === "running"
            ? makeRun(persisted.run, { state: "interrupted", finishedAt: Date.now() })
            : persisted.run
        const command: RuntimeCommand = {
          run,
          events: trimEvents([...persisted.events]),
          subscribers: new Set(),
        }
        commands.set(run.id, command)
        if (persisted.run.state === "running") {
          appendEvent(command, "interrupted", {
            data: "Command Run was active when the daemon stopped",
          })
        }
      }
      persistUnsafe()

      const lookup = (workspaceId: string, runId: string): RuntimeCommand | undefined => {
        const command = commands.get(runId)
        return command?.run.workspaceId === workspaceId ? command : undefined
      }

      const start = (
        request: StartCommandRequest,
      ): Effect.Effect<CommandRun, CommandStartFailure> =>
        Effect.try({
          try: () => {
            let run = CommandRun.make({
              id: randomUUID(),
              workspaceId: request.workspaceId,
              command: request.command,
              args: [...request.args],
              cwd: request.cwd,
              state: "running",
              startedAt: Date.now(),
            })
            const spawned = childProcess.spawn(request.command, [...request.args], {
              cwd: request.cwdPath,
              env: { ...process.env, ...request.env },
              stdio: ["pipe", "pipe", "pipe"],
            })
            if (spawned.stdin === null || spawned.stdout === null || spawned.stderr === null) {
              throw new Error("child process streams were not available")
            }
            run = makeRun(run, { pid: spawned.pid ?? undefined })
            const command: RuntimeCommand = {
              run,
              events: [],
              subscribers: new Set(),
              process: spawned,
            }
            commands.set(run.id, command)
            persistUnsafe()
            spawned.stdout.on("data", (data: Buffer | string) => {
              appendEvent(command, "stdout", { data: data.toString() })
            })
            spawned.stderr.on("data", (data: Buffer | string) => {
              appendEvent(command, "stderr", { data: data.toString() })
            })
            spawned.on("error", (cause) => {
              if (command.run.state !== "running") return
              command.run = makeRun(command.run, {
                state: "failed",
                finishedAt: Date.now(),
              })
              appendEvent(command, "failed", { data: String(cause) })
            })
            spawned.on("close", (exitCode, signal) => {
              if (command.run.state !== "running") return
              const nextState = exitCode === 0 ? "exited" : "failed"
              command.run = makeRun(command.run, {
                state: nextState,
                finishedAt: Date.now(),
                exitCode: exitCode ?? undefined,
                signal: signal ?? undefined,
              })
              appendEvent(command, nextState === "exited" ? "exit" : "failed", {
                exitCode: exitCode ?? undefined,
                signal: signal ?? undefined,
              })
            })
            appendEvent(command, "started")
            return run
          },
          catch: (cause) => startFailure(request.workspaceId, cause),
        })

      const get: CommandRuntimeApi["get"] = (workspaceId, runId) =>
        Effect.sync(() => {
          const command = lookup(workspaceId, runId)
          return command === undefined ? undefined : command.run
        }).pipe(
          Effect.flatMap((run) =>
            run === undefined
              ? Effect.fail(commandNotFound(workspaceId, runId))
              : Effect.succeed(run),
          ),
        )

      const list: CommandRuntimeApi["list"] = (workspaceId) =>
        Effect.sync(() =>
          Array.from(commands.values())
            .filter((command) => command.run.workspaceId === workspaceId)
            .map((command) => command.run)
            .toSorted((left, right) => left.startedAt - right.startedAt),
        )

      const input: CommandRuntimeApi["input"] = (workspaceId, runId, data) =>
        Effect.sync(() => {
          const command = lookup(workspaceId, runId)
          if (command === undefined) return commandNotFound(workspaceId, runId)
          if (command.run.state !== "running" || command.process?.stdin === null) {
            return inputFailure(workspaceId, runId, "the Command Run is not accepting input")
          }
          try {
            if (data === "\u0004") {
              command.process?.stdin.end()
            } else {
              command.process?.stdin.write(data)
            }
            return undefined
          } catch (cause) {
            return inputFailure(workspaceId, runId, cause)
          }
        }).pipe(Effect.flatMap((error) => (error === undefined ? Effect.void : Effect.fail(error))))

      const cancel: CommandRuntimeApi["cancel"] = (workspaceId, runId) =>
        Effect.sync(() => {
          const command = lookup(workspaceId, runId)
          if (command === undefined) return commandNotFound(workspaceId, runId)
          if (command.run.state === "running") {
            command.run = makeRun(command.run, {
              state: "cancelled",
              finishedAt: Date.now(),
            })
            appendEvent(command, "cancelled", { data: "Command Run cancelled" })
            command.process?.kill("SIGTERM")
          }
          return undefined
        }).pipe(Effect.flatMap((error) => (error === undefined ? Effect.void : Effect.fail(error))))

      const cancelWorkspace: CommandRuntimeApi["cancelWorkspace"] = (workspaceId) =>
        Effect.forEach(
          Array.from(commands.values()).filter(
            (command) => command.run.workspaceId === workspaceId && command.run.state === "running",
          ),
          (command) => cancel(workspaceId, command.run.id).pipe(Effect.ignore),
          { concurrency: 1, discard: true },
        )

      const events: CommandRuntimeApi["events"] = (request) =>
        Effect.gen(function* () {
          const queue = yield* Queue.unbounded<CommandEvent, Cause.Done>()
          const scope = yield* Scope.Scope
          const command = lookup(request.workspaceId, request.runId)
          if (command === undefined)
            return yield* commandNotFound(request.workspaceId, request.runId)
          const since = request.since ?? 0
          const replay = command.events.filter((event) => event.sequence > since)
          const follow = request.follow === true
          yield* Effect.sync(() => {
            for (const event of replay) Queue.offerUnsafe(queue, event)
            if (follow && !terminal(command.run)) {
              command.subscribers.add(queue)
            } else {
              Queue.endUnsafe(queue)
            }
          })
          yield* Scope.addFinalizer(
            scope,
            Effect.sync(() => {
              command.subscribers.delete(queue)
              Queue.endUnsafe(queue)
            }),
          )
          return queue
        })

      const reconcile: Effect.Effect<void> = Effect.sync(() => {
        for (const command of commands.values()) {
          if (command.run.state !== "running") continue
          command.run = makeRun(command.run, { state: "interrupted", finishedAt: Date.now() })
          appendEvent(command, "interrupted", {
            data: "Command Run was active when the daemon reconciled its state",
          })
        }
        persistUnsafe()
      })

      const shutdown = () => {
        for (const command of commands.values()) {
          if (command.run.state !== "running") continue
          command.run = makeRun(command.run, { state: "interrupted", finishedAt: Date.now() })
          appendEvent(command, "interrupted", {
            data: "Command Run was interrupted because the daemon stopped",
          })
          command.process?.kill("SIGTERM")
        }
        persistUnsafe()
      }

      return {
        runtime: CommandRuntime.of({
          filePath,
          start,
          get,
          list,
          input,
          cancel,
          cancelWorkspace,
          events,
          reconcile,
        }),
        shutdown,
      }
    })
    const scope = yield* Scope.Scope
    yield* Scope.addFinalizer(scope, Effect.sync(initialized.shutdown))
    return initialized.runtime
  })

export const layerWithoutDependencies = (options: CommandRuntimeOptions = {}) =>
  Layer.effect(CommandRuntime, make(options))

export const layer = (options: CommandRuntimeOptions = {}) =>
  Layer.effect(CommandRuntime, make(options))
