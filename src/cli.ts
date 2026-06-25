#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect, Layer, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import pkg from "../package.json" with { type: "json" };
import { loadConfig, loadConfigOrUndefined } from "./config.ts";
import {
  ConfigInvalid,
  ConfigNotFound,
  ExternalCommandError,
  ServiceUnavailable,
  UsageError,
} from "./errors.ts";
import { explainTimeout } from "./herdr/errors.ts";
import { Herdr } from "./herdr/service.ts";
import { initRepo } from "./init.ts";
import { parseIssueArg } from "./issues.ts";
import { launchIssues, requireAgentConfig } from "./issue/provision.ts";
import { parsePrArg, type PrRef } from "./pr/ref.ts";
import { launchPr } from "./pr/provision.ts";
import { closeBranch, completeBranch, killBranch } from "./teardown.ts";
import { resolveRepo, setupWorktree } from "./worktree/index.ts";
import { DEFAULT_REVIEW_LABEL } from "./defaults.ts";
import type { WorktreeOptions } from "./types.ts";

const fail = (message: string) =>
  Console.error(message).pipe(Effect.andThen(Effect.fail(new UsageError({ message }))));

const AppLayer = Layer.provideMerge(Layer.effect(Herdr, Herdr.make), BunServices.layer);

const issueRef = Argument.string("issue").pipe(
  Argument.filterMap(
    (token) => {
      const ref = parseIssueArg(token);
      return ref === undefined ? Option.none() : Option.some(ref);
    },
    (token) => `[homestead] '${token}' is not an issue number or GitHub issue URL.`,
  ),
);

const prRefArg = Argument.string("pr").pipe(
  Argument.filterMap(
    (token) => {
      const ref = parsePrArg(token);
      return ref === undefined ? Option.none() : Option.some(ref);
    },
    (token) => `[homestead] '${token}' is not a PR number or GitHub PR URL.`,
  ),
  Argument.withDescription("PR number or GitHub PR URL"),
);

const branchTarget = Argument.string("target").pipe(
  Argument.map((token) => {
    const ref = parseIssueArg(token);
    return ref === undefined ? token : String(ref.number);
  }),
);

const initCommand = Command.make("init", {}, () =>
  Effect.gen(function* () {
    const repo = yield* resolveRepo();
    yield* initRepo(repo.primaryRoot);
  }),
).pipe(Command.withDescription("one-time: scaffold a starter homestead.config.ts"));

const worktreeCommand = Command.make(
  "worktree",
  {
    name: Argument.string("name").pipe(Argument.withDescription("worktree / branch name")),
    from: Flag.optional(Flag.string("from")).pipe(
      Flag.withDescription("base ref to branch from (default: repo default branch)"),
    ),
    dir: Flag.optional(Flag.string("dir")).pipe(
      Flag.withDescription("target directory (default: ~/worktrees/<repo>/<slug>)"),
    ),
    noSetup: Flag.boolean("no-setup").pipe(Flag.withDescription("skip env/dependency setup")),
    dryRun: Flag.boolean("dry-run").pipe(Flag.withDescription("plan only; don't create anything")),
  },
  ({ name, from, dir, noSetup, dryRun }) =>
    Effect.gen(function* () {
      const repo = yield* resolveRepo();
      const config = yield* loadConfig(repo.primaryRoot);
      const options: WorktreeOptions = {
        create: name,
        from: Option.getOrUndefined(from),
        dir: Option.getOrUndefined(dir),
        noSetup,
        dryRun,
      };
      const plan = yield* setupWorktree(config, options, repo);
      if (dryRun) return;

      const herdr = yield* Herdr;
      const pane = yield* herdr.createSurface("worktree", plan.targetDir, name).pipe(
        Effect.catchTags({
          HerdrError: (e) => fail(`[homestead] couldn't open worktree in herdr (${e.op})`),
          HerdrNotAvailable: (e) => fail(e.reason),
        }),
      );
      yield* Console.log(`\n✅ worktree '${name}' opened in herdr pane ${pane} — switch in to drive it`);
    }),
).pipe(Command.withDescription("provision a worktree off the base ref + open it in herdr"));

const issueCommand = Command.make(
  "issue",
  {
    refs: issueRef.pipe(Argument.atLeast(1), Argument.withDescription("issue number or GitHub issue URL")),
  },
  ({ refs }) =>
    Effect.gen(function* () {
      const repo = yield* resolveRepo();
      const config = yield* loadConfig(repo.primaryRoot);
      const agent = yield* requireAgentConfig(config.agent).pipe(
        Effect.catchTag("UsageError", (e) => fail(e.message)),
      );

      yield* launchIssues({
        refs,
        config,
        repo,
        agent,
        issueConfig: config.issues,
      }).pipe(
        Effect.catchTag("IssueRepoMismatch", (e) =>
          fail(
            `[homestead] issue URL points at ${e.owner}/${e.repo}, but you're in ${e.here}. ` +
              `Run homestead from inside ${e.owner}/${e.repo}, or pass the bare issue number.`,
          ),
        ),
      );
    }),
).pipe(Command.withDescription("issue = number or GitHub issue URL; one worktree + agent each"));

const killCommand = Command.make(
  "kill",
  {
    branches: branchTarget.pipe(
      Argument.atLeast(1),
      Argument.withDescription("branch name, issue number, or issue URL"),
    ),
    keepRemote: Flag.boolean("keep-remote").pipe(
      Flag.withDescription("keep the remote branch (default: delete branches you own)"),
    ),
  },
  ({ branches, keepRemote }) =>
    Effect.gen(function* () {
      const repo = yield* resolveRepo();
      yield* Effect.forEach(branches, (branch) => killBranch(repo.primaryRoot, repo.repoName, branch, keepRemote), {
        discard: true,
      });
      yield* Console.log(`\n✅ killed ${branches.length}: ${branches.join(", ")}`);
    }),
).pipe(Command.withDescription("remove worktree + branch + herdr surface, reverse issue signals"));

const closeCommand = Command.make(
  "close",
  {
    branches: branchTarget.pipe(
      Argument.atLeast(1),
      Argument.withDescription("issue number, issue URL, or branch name"),
    ),
  },
  ({ branches }) =>
    Effect.gen(function* () {
      const repo = yield* resolveRepo();
      const config = yield* loadConfigOrUndefined(repo.primaryRoot);
      const reviewLabel = config?.issues?.reviewLabel ?? DEFAULT_REVIEW_LABEL;
      yield* Effect.forEach(branches, (branch) => closeBranch(repo.primaryRoot, repo.repoName, branch, reviewLabel), {
        discard: true,
      });
      yield* Console.log(`\n✅ closed ${branches.length}: ${branches.join(", ")}`);
    }),
).pipe(Command.withDescription("finalize: remove worktree + herdr surface, keep the branch, issue → review"));

const completeCommand = Command.make(
  "complete",
  {
    branches: branchTarget.pipe(
      Argument.atLeast(1),
      Argument.withDescription("issue number, issue URL, or branch name"),
    ),
    keepRemote: Flag.boolean("keep-remote").pipe(
      Flag.withDescription("keep the remote branch (default: delete branches you own)"),
    ),
  },
  ({ branches, keepRemote }) =>
    Effect.gen(function* () {
      const repo = yield* resolveRepo();
      yield* Effect.forEach(branches, (branch) => completeBranch(repo.primaryRoot, repo.repoName, branch, keepRemote), {
        discard: true,
      });
      yield* Console.log(`\n✅ completed ${branches.length}: ${branches.join(", ")}`);
    }),
).pipe(Command.withDescription("mark issue completed on GitHub + remove worktree & branch (local + remote)"));

const runPr = (mode: "review" | "work", ref: PrRef) =>
  Effect.gen(function* () {
    const repo = yield* resolveRepo();
    const config = yield* loadConfig(repo.primaryRoot);
    const agent = yield* requireAgentConfig(config.agent).pipe(
      Effect.catchTag("UsageError", (e) => fail(e.message)),
    );
    yield* launchPr({ mode, ref, config, repo, agent }).pipe(
      Effect.catchTags({
        IssueRepoMismatch: (e) =>
          fail(
            `[homestead] PR URL points at ${e.owner}/${e.repo}, but you're in ${e.here}. ` +
              `Run homestead from inside ${e.owner}/${e.repo}, or pass the bare PR number.`,
          ),
        UsageError: (e) => fail(e.message),
        HerdrError: (e) => fail(`[homestead] couldn't open the PR in herdr (${e.op})`),
        HerdrNotAvailable: (e) => fail(e.reason),
        HerdrTimeout: (e) => fail(explainTimeout(e, "[homestead] ")),
      }),
    );
  });

const reviewCommand = Command.make("review", { ref: prRefArg }, ({ ref }) => runPr("review", ref)).pipe(
  Command.withDescription("pull a PR into a worktree; Claude summarizes + runs checks (read-only)"),
);

const prCommand = Command.make("pr", { ref: prRefArg }, ({ ref }) => runPr("work", ref)).pipe(
  Command.withDescription("pull a PR into a worktree; Claude continues the work (same-repo only)"),
);

const homestead = Command.make("homestead", {}).pipe(
  Command.withDescription("config-driven worktree + interactive-agent provisioning"),
  Command.withSubcommands([
    initCommand,
    worktreeCommand,
    issueCommand,
    killCommand,
    closeCommand,
    completeCommand,
    reviewCommand,
    prCommand,
  ]),
);

const program = Command.run(homestead, { version: pkg.version });

program.pipe(
  Effect.catchTags({
    ConfigNotFound: (error: ConfigNotFound) =>
      fail(`[homestead] ${error.detail}\n  Add a homestead.config.ts at your repo root: export default defineConfig({ ... })`),
    ConfigInvalid: (error: ConfigInvalid) => fail(`[homestead] invalid config at ${error.path}: ${error.reason}`),
    ExternalCommandError: (error: ExternalCommandError) =>
      fail(`[homestead] ${error.command} failed: ${error.detail}`),
    ServiceUnavailable: (error: ServiceUnavailable) =>
      fail(`[homestead] service '${error.name}' (${error.host}:${error.port}) ${error.detail}`),
  }),
  Effect.provide(AppLayer),
  BunRuntime.runMain,
);
