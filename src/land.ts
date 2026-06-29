import { Console, Effect } from "effect";
import {
  DEFAULT_LAND_GENERATED,
  DEFAULT_LAND_REGEN,
  DEFAULT_LAND_VERIFY,
} from "./defaults.ts";
import { Git } from "./git/service.ts";
import { runExit } from "./process.ts"; // kept ONLY for verify/regen (non-git) commands
import { completeBranch } from "./teardown.ts";
import type { HomesteadConfig, LandConfig } from "./types.ts";
import { resolveDefaultBaseRef } from "./worktree/base-ref.ts";

// `homestead land <branch...>` — merge a finished branch into the default branch
// in the PRIMARY checkout, regenerate generated artifacts (a text 3-way merge of
// generated files is wrong), run the verify gate, and keep the merge ONLY on
// green. Nothing is committed until verify passes: we merge with --no-commit, so
// a red gate is rolled back with `git merge --abort`.

const GLOB_META = /[.+?^${}()|[\]\\]/g;

// Translate a `*`/`**` glob into an anchored RegExp. `*` matches within a single
// path segment; `**` matches across segments. Everything else is literal.
export const globToRegExp = (pattern: string): RegExp => {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        out += ".*";
        i++;
      } else {
        out += "[^/]*";
      }
    } else {
      out += c.replace(GLOB_META, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
};

// Is `file` (a repo-relative path) covered by the configured generated patterns?
// A pattern with no `*` matches the path exactly OR as a directory prefix
// (`src/generated` covers `src/generated/x.d.ts`); a glob pattern matches by RegExp.
export const isGenerated = (file: string, patterns: ReadonlyArray<string>): boolean =>
  patterns.some((p) =>
    p.includes("*") ? globToRegExp(p).test(file) : file === p || file.startsWith(`${p}/`),
  );

// Split conflicted files into the ones we regenerate (so their conflict doesn't
// fail the merge) and the genuine conflicts that must abort the land.
export const partitionConflicts = (
  conflicted: ReadonlyArray<string>,
  patterns: ReadonlyArray<string>,
): { readonly generated: ReadonlyArray<string>; readonly real: ReadonlyArray<string> } => ({
  generated: conflicted.filter((f) => isGenerated(f, patterns)),
  real: conflicted.filter((f) => !isGenerated(f, patterns)),
});

export interface LandSettings {
  readonly verify: ReadonlyArray<string>;
  readonly regen: ReadonlyArray<ReadonlyArray<string>>;
  readonly generated: ReadonlyArray<string>;
}

// Resolve effective land settings: config wins, else opinionated bun defaults.
// `?? default` (not `|| default`) so an explicit `[]` opts a section out.
export const resolveLandSettings = (land: LandConfig | undefined): LandSettings => ({
  verify: land?.verify ?? DEFAULT_LAND_VERIFY,
  regen: land?.regen ?? DEFAULT_LAND_REGEN,
  generated: land?.generated ?? DEFAULT_LAND_GENERATED,
});

export type LandOutcome =
  | { readonly _tag: "landed"; readonly branch: string }
  | { readonly _tag: "already" }
  | { readonly _tag: "missing" }
  | { readonly _tag: "conflict"; readonly files: ReadonlyArray<string> }
  | { readonly _tag: "regen-failed"; readonly command: ReadonlyArray<string> }
  | { readonly _tag: "red" };

// Merge one branch into the (already-checked-out) default branch and gate on green.
// Returns a LandOutcome; never fails the Effect for a red/conflict (those are
// reported and reflected in the outcome so the batch can continue).
export const landBranch = Effect.fn("homestead/land-branch")(function* (
  primaryRoot: string,
  branch: string,
  settings: LandSettings,
) {
  const git = yield* Git;

  if (!(yield* git.refExists(primaryRoot, `refs/heads/${branch}`))) {
    yield* Console.log(`  ⚠ no local branch '${branch}'`);
    return { _tag: "missing" };
  }

  if (yield* git.mergeBaseIsAncestor(primaryRoot, branch, "HEAD")) {
    yield* Console.log(`  (already merged '${branch}')`);
    return { _tag: "already" };
  }

  const merge = yield* git.merge(primaryRoot, branch);
  if (merge._tag === "Conflict") {
    const { real } = partitionConflicts(merge.files, settings.generated);
    if (real.length > 0) {
      yield* Console.log(`  ⚠ merge conflicts in: ${real.join(", ")} — aborting`);
      yield* git.abortMerge(primaryRoot);
      return { _tag: "conflict", files: real };
    }
    yield* Console.log(`  (regenerating generated files that conflicted: ${merge.files.join(", ")})`);
  }

  // Regenerate generated artifacts (overwrites any conflicted/merged versions).
  for (const cmd of settings.regen) {
    const [command, ...args] = cmd;
    const code = yield* runExit(command!, args, { cwd: primaryRoot });
    if (code !== 0) {
      yield* Console.log(`  ⚠ regen '${cmd.join(" ")}' failed (exit ${code}) — aborting`);
      yield* git.abortMerge(primaryRoot);
      return { _tag: "regen-failed", command: cmd };
    }
  }

  yield* git.addAll(primaryRoot);

  const [vCmd, ...vArgs] = settings.verify;
  const verifyCode = vCmd === undefined ? 0 : yield* runExit(vCmd, vArgs, { cwd: primaryRoot });
  if (verifyCode !== 0) {
    yield* Console.log(`  ⚠ verify failed (exit ${verifyCode}) — rolling back merge of '${branch}'`);
    yield* git.abortMerge(primaryRoot);
    return { _tag: "red" };
  }

  yield* git.commitNoEdit(primaryRoot);
  yield* Console.log(`  ✓ landed '${branch}'`);
  return { _tag: "landed", branch };
});

// Stash the primary checkout's dirty WIP (tracked + untracked) before the batch
// so the merge starts clean, and pop it afterwards. Returns whether a stash was
// pushed so the caller can restore exactly once.
const stashIfDirty = Effect.fn("homestead/land-stash")(function* (primaryRoot: string) {
  const git = yield* Git;
  const status = yield* git.status(primaryRoot);
  if (status.trim().length === 0) return false;
  yield* Console.log(`  (stashing primary-checkout WIP)`);
  return yield* git.stash.push(primaryRoot, "homestead land autostash");
});

const popStash = Effect.fn("homestead/land-unstash")(function* (primaryRoot: string) {
  const git = yield* Git;
  yield* Console.log(`  (restoring primary-checkout WIP)`);
  const ok = yield* git.stash.pop(primaryRoot);
  if (!ok) {
    yield* Console.log(
      `  ⚠ couldn't restore stashed WIP automatically — run 'git stash pop' in ${primaryRoot}`,
    );
  }
});

export interface RunLandOptions {
  readonly complete: boolean;
  readonly keepRemote: boolean;
  readonly allowSpawned: boolean;
}

// Orchestrate `homestead land`: verify the primary checkout is on the default
// branch, auto-stash WIP, land each branch sequentially, restore WIP, then
// optionally chain `homestead complete` for the branches that landed green.
// Returns `false` if anything went wrong (wrong branch, or any branch failed to
// land) so the caller can set a non-zero exit code.
export const runLand = Effect.fn("homestead/run-land")(function* (
  primaryRoot: string,
  repoName: string,
  branches: ReadonlyArray<string>,
  config: HomesteadConfig | undefined,
  options: RunLandOptions,
) {
  const defaultBranch = yield* resolveDefaultBaseRef(primaryRoot);
  const git = yield* Git;
  const current = yield* git.currentBranch(primaryRoot);
  if (current !== defaultBranch) {
    yield* Console.error(
      `[homestead] the primary checkout (${primaryRoot}) is on '${current}', not the default branch '${defaultBranch}'.\n` +
        `  land merges into '${defaultBranch}' there — switch to it first: git -C ${primaryRoot} switch ${defaultBranch}`,
    );
    return false;
  }

  const settings = resolveLandSettings(config?.land);
  const stashed = yield* stashIfDirty(primaryRoot);

  const landed: Array<string> = [];
  let failures = 0;
  yield* Effect.ensuring(
    Effect.gen(function* () {
      for (const branch of branches) {
        yield* Console.log(`\n▸ Landing '${branch}' → ${defaultBranch}`);
        const outcome = yield* landBranch(primaryRoot, branch, settings);
        if (outcome._tag === "landed" || outcome._tag === "already") {
          landed.push(branch);
        } else {
          failures += 1;
        }
      }
    }),
    stashed ? popStash(primaryRoot) : Effect.void,
  );

  if (options.complete && landed.length > 0) {
    for (const branch of landed) {
      yield* completeBranch(
        primaryRoot,
        repoName,
        branch,
        options.keepRemote,
        config,
        options.allowSpawned,
      );
    }
  }

  yield* Console.log(
    `\n✅ landed ${landed.length}/${branches.length}${failures > 0 ? ` (${failures} failed)` : ""}`,
  );
  return failures === 0;
});
