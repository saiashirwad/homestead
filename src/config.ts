import { Cause, Effect, Exit, FileSystem, Option, Path, Schema } from "effect";
import { pathToFileURL } from "node:url";
import { ConfigDataSchema } from "./config-schema.ts";
import { mergeValidatedConfig, toConfigData } from "./config-strip.ts";
import { ConfigInvalid, ConfigNotFound } from "./errors.ts";
import type { HomesteadConfig } from "./types.ts";

const CONFIG_BASENAMES = ["homestead.config.ts", "homestead.config.js", "homestead.config.mjs"] as const;

const isConfigObject = (value: unknown): value is HomesteadConfig =>
  typeof value === "object" && value !== null;

const defaultExport = (mod: unknown): HomesteadConfig | undefined => {
  if (typeof mod !== "object" || mod === null || !("default" in mod)) return undefined;
  return isConfigObject(mod.default) ? mod.default : undefined;
};

export const validateConfigShape = (config: HomesteadConfig): HomesteadConfig => {
  const data = Schema.decodeUnknownSync(ConfigDataSchema)(toConfigData(config));
  return mergeValidatedConfig(config, data);
};

const decodeConfigData = Schema.decodeUnknownEffect(ConfigDataSchema);

const validateConfigData = Effect.fn("homestead/validate-config")(function* (config: HomesteadConfig) {
  const data = yield* decodeConfigData(toConfigData(config)).pipe(
    Effect.catchTag(
      "SchemaError",
      (error) => new ConfigInvalid({ path: "homestead.config", reason: error.message }),
    ),
  );
  return mergeValidatedConfig(config, data);
});

export const loadConfigOrUndefined = Effect.fn("homestead/load-config-or-undefined")(function* (startDir: string) {
  const exit = yield* Effect.exit(loadConfig(startDir));
  if (Exit.isSuccess(exit)) return exit.value;
  const error = Cause.findErrorOption(exit.cause);
  if (Option.isSome(error) && error.value._tag === "ConfigNotFound") return undefined;
  return yield* Effect.failCause(exit.cause);
});

export const loadConfig = Effect.fn("homestead/load-config")(function* (startDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  let dir = path.resolve(startDir);
  for (;;) {
    for (const base of CONFIG_BASENAMES) {
      const candidate = path.join(dir, base);
      if (yield* fs.exists(candidate)) {
        const mod: unknown = yield* Effect.tryPromise({
          try: () => import(pathToFileURL(candidate).href),
          catch: (cause) =>
            new ConfigInvalid({ path: candidate, reason: `failed to import: ${String(cause)}` }),
        });
        const config = defaultExport(mod);
        if (config === undefined) {
          return yield* new ConfigInvalid({
            path: candidate,
            reason: "exported no config — use `export default { ... } satisfies HomesteadConfig`",
          });
        }
        return yield* validateConfigData(config);
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return yield* new ConfigNotFound({
        searchedFrom: startDir,
        detail: `no ${CONFIG_BASENAMES.join(" / ")} found from ${startDir} up to the filesystem root`,
      });
    }
    dir = parent;
  }
});
