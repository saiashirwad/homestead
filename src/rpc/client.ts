import { BunSocket } from "@effect/platform-bun"
import { RpcClient, RpcSerialization } from "effect/unstable/rpc"
import { Effect, Layer } from "effect"
import { getDefaultSocketPath, makeHomesteadClient } from "./shared.ts"

export const makeClient = (socketPath: string = getDefaultSocketPath()) =>
  Effect.scoped(
    makeHomesteadClient.pipe(
      Effect.provide(
        RpcClient.layerProtocolSocket().pipe(
          Layer.provide(
            Layer.merge(BunSocket.layerNet({ path: socketPath }), RpcSerialization.layerNdjson),
          ),
        ),
      ),
    ),
  )
