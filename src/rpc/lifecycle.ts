import { Console, Effect, Scope } from "effect"
import * as net from "node:net"
import * as fs from "node:fs"
import * as path from "node:path"
import { SocketInUseError, SocketStartupError } from "../errors.ts"

export type SocketProbeResult = "live" | "dead" | "absent" | "not_a_socket" | "timeout" | "error"

export interface SocketOwnership {
  readonly socketPath: string
  readonly lockPath: string
  readonly releaseLock: () => void
}

const inProcessLocks = new Set<string>()

export const probeSocket = (socketPath: string): Effect.Effect<SocketProbeResult, never> =>
  Effect.callback((resume) => {
    let stat: fs.Stats | undefined
    try {
      stat = fs.lstatSync(socketPath)
    } catch {
      resume(Effect.succeed("absent"))
      return
    }

    if (!stat.isSocket()) {
      resume(Effect.succeed("not_a_socket"))
      return
    }

    const client = net.createConnection({ path: socketPath })
    let settled = false

    const finish = (result: SocketProbeResult) => {
      if (!settled) {
        settled = true
        client.removeAllListeners()
        client.destroy()
        resume(Effect.succeed(result))
      }
    }

    client.setTimeout(350, () => {
      finish("timeout")
    })

    client.on("connect", () => {
      finish("live")
    })

    client.on("error", (err: unknown) => {
      const code = (err as { readonly code?: unknown })?.code
      if (code === "ECONNREFUSED" || code === "ENOENT") {
        finish("dead")
      } else {
        finish("error")
      }
    })
  })

const acquireStartupLock = (
  socketPath: string,
): Effect.Effect<SocketOwnership, SocketInUseError | SocketStartupError> =>
  Effect.gen(function* () {
    const lockPath = `${socketPath}.lock`

    if (inProcessLocks.has(socketPath)) {
      return yield* SocketInUseError.make({
        socketPath,
        message: `Homestead daemon socket lock is already held in the current process: ${socketPath}`,
      })
    }

    let acquired = false
    try {
      const fd = fs.openSync(
        lockPath,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR,
      )
      fs.writeSync(fd, `${process.pid}\n`)
      fs.closeSync(fd)
      acquired = true
    } catch (err: unknown) {
      const code = (err as { readonly code?: unknown })?.code
      if (code === "EEXIST") {
        let lockPid: number | undefined
        try {
          const content = fs.readFileSync(lockPath, "utf-8").trim()
          lockPid = parseInt(content, 10)
        } catch {}

        let isAlive = false
        if (lockPid && !isNaN(lockPid)) {
          if (lockPid === process.pid) {
            return yield* SocketInUseError.make({
              socketPath,
              message: `Homestead daemon socket lock is already held by PID ${lockPid}`,
            })
          }
          try {
            process.kill(lockPid, 0)
            isAlive = true
          } catch (e: unknown) {
            const errCode = (e as { readonly code?: unknown })?.code
            isAlive = errCode !== "ESRCH"
          }
        }

        if (isAlive) {
          return yield* SocketInUseError.make({
            socketPath,
            message: `Homestead daemon socket is already locked by active process PID ${lockPid}: ${socketPath}`,
          })
        }

        try {
          fs.unlinkSync(lockPath)
          const fd = fs.openSync(
            lockPath,
            fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR,
          )
          fs.writeSync(fd, `${process.pid}\n`)
          fs.closeSync(fd)
          acquired = true
        } catch {
          return yield* SocketInUseError.make({
            socketPath,
            message: `Homestead daemon socket lock contention at ${lockPath}`,
          })
        }
      } else {
        return yield* SocketStartupError.make({
          socketPath,
          reason: "LockAcquisitionFailed",
          message: `Failed to acquire lock for ${socketPath}: ${err instanceof Error ? err.message : String(err)}`,
        })
      }
    }

    if (acquired) {
      inProcessLocks.add(socketPath)
    }

    const releaseLock = () => {
      inProcessLocks.delete(socketPath)
      try {
        if (fs.existsSync(lockPath)) {
          const content = fs.readFileSync(lockPath, "utf-8").trim()
          const pid = parseInt(content, 10)
          if (pid === process.pid) {
            fs.unlinkSync(lockPath)
          }
        }
      } catch {}
    }

    return { socketPath, lockPath, releaseLock }
  })

export const prepareSocket = (
  socketPath: string,
): Effect.Effect<SocketOwnership, SocketInUseError | SocketStartupError, Scope.Scope> =>
  Effect.gen(function* () {
    const socketDir = path.dirname(socketPath)

    yield* Effect.try({
      try: () => {
        if (!fs.existsSync(socketDir)) {
          fs.mkdirSync(socketDir, { recursive: true, mode: 0o700 })
        }
        fs.chmodSync(socketDir, 0o700)
      },
      catch: (err) =>
        SocketStartupError.make({
          socketPath,
          reason: "DirectoryCreationFailed",
          message: `Failed to create or set permissions (0700) on runtime directory ${socketDir}: ${err instanceof Error ? err.message : String(err)}`,
        }),
    })

    const ownership = yield* acquireStartupLock(socketPath)

    yield* Effect.addFinalizer(() => Effect.sync(ownership.releaseLock))

    let stat: fs.Stats | undefined
    try {
      stat = fs.lstatSync(socketPath)
    } catch {}

    if (stat) {
      if (!stat.isSocket()) {
        return yield* SocketStartupError.make({
          socketPath,
          reason: "NonSocketPath",
          message: `File at configured socket path ${socketPath} is not a Unix domain socket (refusing to unlink)`,
        })
      }

      const probeStatus = yield* probeSocket(socketPath)

      if (probeStatus === "live") {
        return yield* SocketInUseError.make({
          socketPath,
          message: `Homestead daemon socket is already in use by a running process: ${socketPath}`,
        })
      }

      if (probeStatus === "dead") {
        yield* Console.log(
          `[lifecycle] Detected stale socket at ${socketPath}; cleaning up before bind.`,
        )
        try {
          fs.unlinkSync(socketPath)
        } catch (err) {
          return yield* SocketStartupError.make({
            socketPath,
            reason: "StaleSocketUnlinkFailed",
            message: `Failed to unlink stale socket file at ${socketPath}: ${err instanceof Error ? err.message : String(err)}`,
          })
        }
      } else {
        return yield* SocketInUseError.make({
          socketPath,
          message: `Could not verify socket state at ${socketPath} (probe status: ${probeStatus})`,
        })
      }
    }

    return ownership
  })

export const registerScopedSocketCleanup = (
  socketPath: string,
  ownership?: SocketOwnership,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    let boundDev: number | undefined
    let boundIno: number | undefined
    try {
      const stat = fs.lstatSync(socketPath)
      if (stat.isSocket()) {
        boundDev = stat.dev
        boundIno = stat.ino
      }
    } catch {}

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        try {
          if (fs.existsSync(socketPath)) {
            const stat = fs.lstatSync(socketPath)
            if (stat.isSocket()) {
              if (
                boundDev === undefined ||
                boundIno === undefined ||
                (stat.dev === boundDev && stat.ino === boundIno)
              ) {
                fs.unlinkSync(socketPath)
              }
            }
          }
        } catch {
        } finally {
          if (ownership) {
            ownership.releaseLock()
          }
        }
      }),
    )
  })
