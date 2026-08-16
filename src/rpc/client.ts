import { BunSocket } from "@effect/platform-bun";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import { Effect } from "effect";
import {
  getDefaultSocketPath,
  makeHomesteadClient,
  type HomesteadClient,
} from "./shared.ts";

export const makeClient = (
  socketPath: string = getDefaultSocketPath(),
) =>
  Effect.scoped(
    makeHomesteadClient.pipe(
      Effect.provide(RpcClient.layerProtocolSocket()),
      Effect.provide(BunSocket.layerNet({ path: socketPath })),
      Effect.provide(RpcSerialization.layerNdjson),
    ),
  );
