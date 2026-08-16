import { Effect } from "effect"
import { UsageError } from "../errors.ts"
import { Git } from "../git/service.ts"

export const branchFromOriginHead = (symbolicRef: string): string =>
  symbolicRef.startsWith("origin/") ? symbolicRef.slice("origin/".length) : symbolicRef

export const resolveDefaultBaseRef = Effect.fn("homestead/resolve-default-base-ref")(function* (
  primaryRoot: string,
) {
  const git = yield* Git
  const origin = yield* git.symbolicRef(primaryRoot, "refs/remotes/origin/HEAD")
  if (origin !== undefined) return branchFromOriginHead(origin)

  for (const branch of ["main", "master"] as const) {
    if (yield* git.refExists(primaryRoot, `refs/heads/${branch}`)) return branch
  }

  return yield* UsageError.make({
    message:
      "[homestead] could not determine default branch (no origin/HEAD, main, or master) — pass --from explicitly",
  })
})
