import { describe, expect, it } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import * as net from "node:net"
import * as fs from "node:fs"
import { prepareSocket, probeSocket, registerScopedSocketCleanup } from "../../src/rpc/lifecycle.ts"
import { createStaleSocketFile, createTempSocket } from "../helpers.ts"

const runWithEnv = <A, E>(effect: Effect.Effect<A, E, any>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, BunServices.layer) as Effect.Effect<A, E, never>)

describe("Socket Lifecycle & Probing", () => {
  it("probes absent socket as 'absent'", async () => {
    const tempSock = createTempSocket()
    try {
      const status = await runWithEnv(probeSocket(tempSock.path))
      expect(status).toBe("absent")
    } finally {
      tempSock.cleanup()
    }
  })

  it("probes live server socket as 'live'", async () => {
    const tempSock = createTempSocket()
    const server = net.createServer()
    await new Promise<void>((resolve) => server.listen(tempSock.path, resolve))

    try {
      const status = await runWithEnv(probeSocket(tempSock.path))
      expect(status).toBe("live")
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      tempSock.cleanup()
    }
  })

  it("probes regular file as 'not_a_socket'", async () => {
    const tempSock = createTempSocket()
    fs.writeFileSync(tempSock.path, "some-regular-file-content")

    try {
      const status = await runWithEnv(probeSocket(tempSock.path))
      expect(status).toBe("not_a_socket")
    } finally {
      tempSock.cleanup()
    }
  })

  it("probes stale socket file as 'dead'", async () => {
    const tempSock = createTempSocket()
    await createStaleSocketFile(tempSock.path)

    expect(fs.existsSync(tempSock.path)).toBe(true)

    try {
      const status = await runWithEnv(probeSocket(tempSock.path))
      expect(status).toBe("dead")
    } finally {
      tempSock.cleanup()
    }
  })

  it("recovers from stale socket during prepareSocket", async () => {
    const tempSock = createTempSocket()
    await createStaleSocketFile(tempSock.path)

    expect(fs.existsSync(tempSock.path)).toBe(true)

    try {
      await runWithEnv(Effect.scoped(prepareSocket(tempSock.path)))

      expect(fs.existsSync(tempSock.path)).toBe(false)

      const newServer = net.createServer()
      await new Promise<void>((resolve) => newServer.listen(tempSock.path, resolve))
      expect(fs.existsSync(tempSock.path)).toBe(true)
      await new Promise<void>((resolve) => newServer.close(() => resolve()))
    } finally {
      tempSock.cleanup()
    }
  })

  it("refuses to unlink regular file and fails with SocketStartupError", async () => {
    const tempSock = createTempSocket()
    fs.writeFileSync(tempSock.path, "regular-important-data")
    expect(fs.existsSync(tempSock.path)).toBe(true)

    try {
      let failedReason = ""
      await runWithEnv(
        Effect.scoped(
          prepareSocket(tempSock.path).pipe(
            Effect.catchTag("SocketStartupError", (err) => {
              failedReason = err.reason
              return Effect.succeed("handled" as const)
            }),
          ),
        ),
      )

      expect(failedReason).toBe("NonSocketPath")
      expect(fs.existsSync(tempSock.path)).toBe(true)
      expect(fs.readFileSync(tempSock.path, "utf-8")).toBe("regular-important-data")
    } finally {
      tempSock.cleanup()
    }
  })

  it("refuses to steal live socket and preserves running server", async () => {
    const tempSock = createTempSocket()
    const server = net.createServer()
    await new Promise<void>((resolve) => server.listen(tempSock.path, resolve))

    try {
      let threwInUse = false
      await runWithEnv(
        Effect.scoped(
          prepareSocket(tempSock.path).pipe(
            Effect.catchTag("SocketInUseError", () => {
              threwInUse = true
              return Effect.succeed("handled" as const)
            }),
          ),
        ),
      )

      expect(threwInUse).toBe(true)
      expect(fs.existsSync(tempSock.path)).toBe(true)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      tempSock.cleanup()
    }
  })

  it("creates parent runtime directory with mode 0700", async () => {
    const tempSock = createTempSocket()
    try {
      await runWithEnv(Effect.scoped(prepareSocket(tempSock.path)))

      const stat = fs.statSync(tempSock.dir)
      const mode = stat.mode & 0o777
      expect(mode).toBe(0o700)
    } finally {
      tempSock.cleanup()
    }
  })

  it("cleans up owned socket on scoped finalization with inode verification", async () => {
    const tempSock = createTempSocket()
    try {
      await runWithEnv(
        Effect.scoped(
          Effect.gen(function* () {
            const ownership = yield* prepareSocket(tempSock.path)

            const server = net.createServer()
            yield* Effect.callback<void>((resume) => {
              server.listen(tempSock.path, () => resume(Effect.void))
              return Effect.void
            })

            yield* registerScopedSocketCleanup(tempSock.path, ownership)

            expect(fs.existsSync(tempSock.path)).toBe(true)
          }),
        ),
      )

      expect(fs.existsSync(tempSock.path)).toBe(false)
    } finally {
      tempSock.cleanup()
    }
  })
})
