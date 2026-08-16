import { Effect, FileSystem, Option, Path, Schema } from "effect"

// The worktree-local "provisioning finished" record. homestead provisions a
// worktree as a multi-step side-effecting pipeline (writeEnv → ensureServices →
// runSetup → afterSetup) but nothing records whether that pipeline *finished*.
// This marker is that record: written at the very end of setupWorktree, it lets
// `homestead doctor` tell a healthy worktree from one a crash left half-built.
// Lives at <worktree>/.homestead/provision.json (gitignored via `.homestead/`)
// alongside the agent-status sentinel — runtime state, never committed.
export const ProvisionMarkerSchema = Schema.Struct({
  version: Schema.Literal(1),
  completedAt: Schema.String, // ISO-8601, written at completion
  ports: Schema.Array(Schema.String), // the config.ports keys this worktree owns
  setupSteps: Schema.Finite, // how many setup steps ran (0 with --no-setup)
})
export type ProvisionMarker = typeof ProvisionMarkerSchema.Type

export const PROVISION_MARKER_RELPATH = ".homestead/provision.json"

const markerPath = (path: Path.Path, worktreeDir: string) =>
  path.join(worktreeDir, PROVISION_MARKER_RELPATH)

// Write the marker, creating the `.homestead/` dir if needed. Called at the end
// of the provisioning pipeline, after afterSetup succeeds.
export const writeProvisionMarker = Effect.fn("homestead/write-provision-marker")(function* (
  worktreeDir: string,
  marker: ProvisionMarker,
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const file = markerPath(path, worktreeDir)
  const encoded = yield* Schema.encodeUnknownEffect(ProvisionMarkerSchema)(marker).pipe(
    Effect.orDie,
  )
  yield* fs.makeDirectory(path.dirname(file), { recursive: true }).pipe(Effect.orDie)
  yield* fs.writeFileString(file, `${JSON.stringify(encoded, null, 2)}\n`)
})

// Read the marker; `Option.none` when absent or unparseable (same forgiving
// pattern as readAgentMarker in tracking.ts).
export const readProvisionMarker = Effect.fn("homestead/read-provision-marker")(function* (
  worktreeDir: string,
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const file = markerPath(path, worktreeDir)

  const exists = yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false))
  if (!exists) return Option.none<ProvisionMarker>()

  const content = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""))
  if (content === "") return Option.none<ProvisionMarker>()

  const marker = yield* Schema.decodeEffect(Schema.fromJsonString(ProvisionMarkerSchema))(
    content,
  ).pipe(Effect.orElseSucceed(() => undefined))
  return marker === undefined ? Option.none<ProvisionMarker>() : Option.some(marker)
})
