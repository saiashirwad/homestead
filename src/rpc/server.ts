import { BunSocketServer, BunServices } from "@effect/platform-bun"
import { RpcSerialization, RpcServer } from "effect/unstable/rpc"
import { Console, Deferred, Effect, Layer } from "effect"
import { makeHomesteadHandlers } from "./handlers.ts"
import { prepareSocket, registerScopedSocketCleanup } from "./lifecycle.ts"
import { getDefaultSocketPath, HomesteadRpcs } from "./shared.ts"
import { makeAppLayer } from "../runtime.ts"

export interface MakeServerOptions {
  readonly onReady?: Deferred.Deferred<void>
  readonly registryFilePath?: string | undefined
  readonly commandFilePath?: string | undefined
}

export const makeServer = (
  socketPath: string = getDefaultSocketPath(),
  options?: MakeServerOptions,
) =>
  Effect.gen(function* () {
    const shutdownSignal = yield* Deferred.make<void>()

    const ownership = yield* prepareSocket(socketPath)

    const HandlersLive = makeHomesteadHandlers(
      Deferred.succeed(shutdownSignal, void 0).pipe(Effect.asVoid),
    ).pipe(
      Layer.provide(
        makeAppLayer({
          registry: { filePath: options?.registryFilePath },
          commands: { filePath: options?.commandFilePath },
        }),
      ),
      Layer.provide(BunServices.layer),
    )

    const ServerLive = RpcServer.layer(HomesteadRpcs).pipe(
      Layer.provideMerge(RpcServer.layerProtocolSocketServer),
      Layer.provideMerge(BunSocketServer.layer({ path: socketPath })),
      Layer.provide([HandlersLive, RpcSerialization.layerNdjson]),
    )

    yield* Layer.build(ServerLive)

    yield* registerScopedSocketCleanup(socketPath, ownership)

    if (options?.onReady) {
      yield* Deferred.succeed(options.onReady, void 0)
    }
    yield* Console.log(`Homestead RPC Server listening on Unix socket: ${socketPath}`)

    yield* Deferred.await(shutdownSignal)
    yield* Console.log("Homestead RPC Server shutting down cleanly")
  })

export const serverLayer = (socketPath: string = getDefaultSocketPath()) =>
  Layer.effectDiscard(Effect.scoped(makeServer(socketPath)))
