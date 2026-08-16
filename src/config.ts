import { Cause, Effect, Exit, FileSystem, Option, Path } from "effect"
import { pathToFileURL } from "node:url"
import { ConfigInvalid, ConfigNotFound } from "./errors.ts"
import type { HomesteadConfig } from "./types.ts"

const CONFIG_BASENAMES = [
  "homestead.config.ts",
  "homestead.config.js",
  "homestead.config.mjs",
] as const

interface ConfigModule {
  readonly default?: HomesteadConfig | undefined
}

const isConfigModule = (cause: unknown): cause is ConfigModule => cause instanceof Object

export const applyDefaults = (config: HomesteadConfig): HomesteadConfig => ({
  ...config,
  ports: config.ports ?? [],
  services: config.services ?? [],
  setup: config.setup ?? [],
  teardown: config.teardown ?? [],
})

export const loadConfigOrUndefined = Effect.fnUntraced(function* (startDir: string) {
  const exit = yield* Effect.exit(loadConfig(startDir))
  if (Exit.isSuccess(exit)) return exit.value
  const error = Cause.findErrorOption(exit.cause)
  if (Option.isSome(error) && error.value._tag === "ConfigNotFound") return undefined
  return yield* Effect.failCause(exit.cause)
})

export const loadConfig = Effect.fnUntraced(function* (startDir: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  let dir = path.resolve(startDir)
  for (;;) {
    for (const base of CONFIG_BASENAMES) {
      const candidate = path.join(dir, base)
      if (yield* fs.exists(candidate)) {
        // SAFETY: Dynamic import resolves to an ES module object.
        const raw = yield* Effect.tryPromise({
          // SAFETY: Dynamic import returns a promise of an unknown module namespace.
          try: () => import(pathToFileURL(candidate).href) as Promise<unknown>,
          catch: (cause) =>
            ConfigInvalid.make({ path: candidate, reason: `failed to import: ${String(cause)}` }),
        })
        if (!isConfigModule(raw) || raw.default === undefined) {
          return yield* ConfigInvalid.make({
            path: candidate,
            reason: "exported no config — use `export default { ... } satisfies HomesteadConfig`",
          })
        }
        return applyDefaults(raw.default)
      }
    }
    const parent = path.dirname(dir)
    if (parent === dir) {
      return yield* ConfigNotFound.make({
        searchedFrom: startDir,
        detail: `no ${CONFIG_BASENAMES.join(" / ")} found from ${startDir} up to the filesystem root`,
      })
    }
    dir = parent
  }
})
