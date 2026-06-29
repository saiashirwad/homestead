#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect, Layer, Option, Schedule } from "effect";
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
import { renderDashboard } from "./dashboard.ts";
import { runGc } from "./gc.ts";
import {
  exitCodeFor,
  parseCompactDuration,
  resolveWorktreeDir,
  waitForAgent,
} from "./agent/wait.ts";
import { resolveSpawnPrompt, spawnAgent } from "./agent/spawn.ts";
import { promptAgent } from "./agent/prompt.ts";
import { PENDING_JSON, resultForSlug } from "./agent/result.ts";
import { resolveRepo, setupWorktree } from "./worktree/index.ts";
import { PortAllocator } from "./worktree/ports.ts";
import { DEFAULT_REVIEW_LABEL } from "./defaults.ts";
import type { WorktreeOptions } from "./types.ts";

const fail = (message: string) =>
  Console.error(message).pipe(Effect.andThen(Effect.fail(new UsageError({ message }))));

const AppLayer = Layer.provideMerge(
  Layer.mergeAll(Layer.effect(Herdr, Herdr.make), PortAllocator.layer),
  BunServices.layer,
);

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
      const config = yield* loadConfigOrUndefined(repo.primaryRoot);
      yield* Effect.forEach(
        branches,
        (branch) => killBranch(repo.primaryRoot, repo.repoName, branch, keepRemote, config),
        {
          discard: true,
        },
      );
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
      const reviewLabel =
        typeof config?.issues?.reviewLabel === "string"
          ? config.issues.reviewLabel
          : DEFAULT_REVIEW_LABEL;
      yield* Effect.forEach(
        branches,
        (branch) => closeBranch(repo.primaryRoot, repo.repoName, branch, reviewLabel, config),
        {
          discard: true,
        },
      );
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
    allowSpawned: Flag.boolean("allow-spawned").pipe(
      Flag.withDescription("land machine-spawned (auto-work) branches (default: refuse)"),
    ),
  },
  ({ branches, keepRemote, allowSpawned }) =>
    Effect.gen(function* () {
      const repo = yield* resolveRepo();
      const config = yield* loadConfigOrUndefined(repo.primaryRoot);
      yield* Effect.forEach(
        branches,
        (branch) => completeBranch(repo.primaryRoot, repo.repoName, branch, keepRemote, config, allowSpawned),
        {
          discard: true,
        },
      );
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

const statusLabel = (status: "done" | "blocked" | "failed"): string =>
  status === "done" ? "✅ done —" : status === "blocked" ? "⏸ blocked —" : "❌ failed —";

const agentWaitCommand = Command.make(
  "wait",
  {
    target: branchTarget.pipe(
      Argument.withDescription("branch name, issue number, or issue URL"),
    ),
    timeout: Flag.string("timeout").pipe(
      Flag.withDefault("30m"),
      Flag.withDescription("backstop wait before giving up, e.g. 30m, 45m, 2h (default 30m)"),
    ),
    pane: Flag.optional(Flag.string("pane")).pipe(
      Flag.withDescription("paneId for the idle-prompt backstop (else file-or-timeout only)"),
    ),
    poll: Flag.string("poll").pipe(
      Flag.withDefault("2s"),
      Flag.withDescription("poll interval, e.g. 2s, 500ms (default 2s)"),
    ),
  },
  ({ target, timeout, pane, poll }) =>
    Effect.gen(function* () {
      const timeoutMs = parseCompactDuration(timeout);
      const pollMs = parseCompactDuration(poll);
      if (timeoutMs === undefined) {
        return yield* fail(`[homestead] invalid --timeout '${timeout}' (use e.g. 30m, 2s, 500ms)`);
      }
      if (pollMs === undefined) {
        return yield* fail(`[homestead] invalid --poll '${poll}' (use e.g. 30m, 2s, 500ms)`);
      }

      const repo = yield* resolveRepo();
      const config = yield* loadConfigOrUndefined(repo.primaryRoot);
      const worktreeDir = yield* resolveWorktreeDir(repo.repoName, target, config);

      const outcome = yield* waitForAgent({
        worktreeDir,
        paneId: Option.getOrUndefined(pane),
        timeoutMs,
        pollMs,
      });

      if (outcome._tag === "status") {
        yield* Console.log(`\n${statusLabel(outcome.file.status)} ${outcome.file.summary}`);
      } else if (outcome.reason === "idle-pane") {
        yield* Console.log(
          `\n⚠ agent parked at the prompt without writing ${worktreeDir}/.homestead/agent-status.json — no trustworthy signal`,
        );
      } else {
        yield* Console.log(
          `\n⚠ no agent-status.json after ${timeout} — agent still running, wedged, or ignored the convention`,
        );
      }

      // Command.run only yields 0/1 on its own; set 2/3 (and 0/1) ourselves and
      // succeed, so defaultTeardown leaves process.exitCode untouched.
      const code = exitCodeFor(outcome);
      yield* Effect.sync(() => {
        process.exitCode = code;
      });
    }),
).pipe(
  Command.withDescription("block until the agent signals done/blocked/failed; exit 0/1/2/3"),
);

const agentSpawnCommand = Command.make(
  "spawn",
  {
    slug: Argument.string("slug").pipe(Argument.withDescription("worktree / branch name for the spawned agent")),
    promptWords: Argument.string("prompt").pipe(
      Argument.variadic(),
      Argument.withDescription("prompt to seed (positional words are joined)"),
    ),
    promptFlag: Flag.optional(Flag.string("prompt")).pipe(
      Flag.withDescription("prompt to seed (alternative to positional); '--prompt -' reads stdin"),
    ),
  },
  ({ slug, promptWords, promptFlag }) =>
    Effect.gen(function* () {
      const prompt = yield* resolveSpawnPrompt(
        promptWords,
        promptFlag,
        Effect.promise(() => Bun.stdin.text()),
      ).pipe(Effect.catchTag("UsageError", (e) => fail(e.message)));

      const repo = yield* resolveRepo();
      const config = yield* loadConfig(repo.primaryRoot);
      const agent = yield* requireAgentConfig(config.agent).pipe(
        Effect.catchTag("UsageError", (e) => fail(e.message)),
      );

      yield* spawnAgent({
        config,
        repo,
        slug,
        prompt,
        agent,
        createdAt: new Date().toISOString(),
      }).pipe(
        Effect.catchTags({
          HerdrError: (e) => fail(`[homestead] couldn't open the spawned agent in herdr (${e.op})`),
          HerdrNotAvailable: (e) => fail(e.reason),
          HerdrTimeout: (e) => fail(explainTimeout(e, "[homestead] ")),
        }),
      );
    }),
).pipe(
  Command.withDescription("provision an issue-less worktree + boot an agent on a free-form prompt"),
);

const agentPromptCommand = Command.make(
  "prompt",
  {
    slug: Argument.string("slug").pipe(Argument.withDescription("slug passed to `agent spawn`")),
    promptWords: Argument.string("prompt").pipe(
      Argument.variadic(),
      Argument.withDescription("follow-up text to send (positional words are joined)"),
    ),
    promptFlag: Flag.optional(Flag.string("prompt")).pipe(
      Flag.withDescription("follow-up text (alternative to positional); '--prompt -' reads stdin"),
    ),
  },
  ({ slug, promptWords, promptFlag }) =>
    Effect.gen(function* () {
      const text = yield* resolveSpawnPrompt(
        promptWords,
        promptFlag,
        Effect.promise(() => Bun.stdin.text()),
        "agent prompt",
      ).pipe(Effect.catchTag("UsageError", (e) => fail(e.message)));

      const repo = yield* resolveRepo();
      const config = yield* loadConfigOrUndefined(repo.primaryRoot);

      yield* promptAgent({ repoName: repo.repoName, slug, text, config }).pipe(
        Effect.catchTags({
          UsageError: (e) => fail(e.message),
          HerdrError: (e) => fail(`[homestead] couldn't send to the agent's pane (${e.op})`),
        }),
      );
    }),
).pipe(
  Command.withDescription("send a follow-up turn to a running spawned agent (resolved by slug)"),
);

const agentResultCommand = Command.make(
  "result",
  {
    slug: Argument.string("slug").pipe(Argument.withDescription("slug passed to `agent spawn`")),
  },
  ({ slug }) =>
    Effect.gen(function* () {
      const repo = yield* resolveRepo();
      const config = yield* loadConfigOrUndefined(repo.primaryRoot);
      const result = yield* resultForSlug(repo.repoName, slug, config);

      switch (result._tag) {
        case "status":
          return yield* Console.log(result.body);
        case "pending":
          return yield* Console.log(PENDING_JSON);
        case "unknown":
          return yield* fail(
            `[homestead] no spawned agent for slug '${slug}' (no worktree / marker — was it spawned with 'agent spawn'?)`,
          );
      }
    }),
).pipe(
  Command.withDescription("print a spawned agent's status sentinel as JSON (pending if not done yet)"),
);

// Terminal escape sequences for the flicker-free watch redraw. The alternate
// screen buffer (1049h/l) keeps the user's scrollback intact: we draw the live
// table on a throwaway screen and restore the original on exit (incl. Ctrl-C).
const ALT_SCREEN_ENTER = "\x1b[?1049h";
const ALT_SCREEN_EXIT = "\x1b[?1049l";
const CURSOR_HOME_CLEAR = "\x1b[H\x1b[2J";

const writeStdout = (s: string) => Effect.sync(() => void process.stdout.write(s));

// `ls --watch`: re-render the read-only dashboard in place every `intervalSeconds`.
// acquireUseRelease guarantees the alt-screen is restored even on interrupt
// (Ctrl-C), so the user's pre-watch scrollback survives. The loop body is exactly
// the one-shot render — strictly read-only, no tracking/teardown/herdr mutations.
const watchDashboard = (
  repo: Parameters<typeof renderDashboard>[0],
  config: Parameters<typeof renderDashboard>[1],
  intervalSeconds: number,
) =>
  Effect.acquireUseRelease(
    writeStdout(ALT_SCREEN_ENTER),
    () =>
      renderDashboard(repo, config).pipe(
        Effect.flatMap((frame) => writeStdout(`${CURSOR_HOME_CLEAR}${frame}\n`)),
        Effect.repeat({ schedule: Schedule.spaced(`${intervalSeconds} seconds`) }),
      ),
    () => writeStdout(ALT_SCREEN_EXIT),
  );

const lsCommand = Command.make(
  "ls",
  {
    watch: Flag.boolean("watch").pipe(
      Flag.withAlias("w"),
      Flag.withDescription("auto-refresh the table in place until Ctrl-C (read-only)"),
    ),
    interval: Flag.integer("interval").pipe(
      Flag.withAlias("n"),
      Flag.withDefault(2),
      Flag.withDescription("watch refresh interval in seconds (default 2)"),
    ),
  },
  ({ watch, interval }) =>
    Effect.gen(function* () {
      const repo = yield* resolveRepo();
      const config = yield* loadConfigOrUndefined(repo.primaryRoot);
      if (!watch) {
        yield* Console.log(yield* renderDashboard(repo, config));
        return;
      }
      yield* watchDashboard(repo, config, interval);
    }),
).pipe(Command.withDescription("read-only dashboard: one row per worktree (ports, DB, agent, pane, origin)"));

const gcCommand = Command.make(
  "gc",
  {
    prune: Flag.boolean("prune").pipe(
      Flag.withDescription("actually reclaim (default: dry-run — change nothing)"),
    ),
    yes: Flag.boolean("yes").pipe(
      Flag.withAlias("y"),
      Flag.withDescription("skip the confirmation prompt when pruning"),
    ),
    branches: Flag.boolean("branches").pipe(
      Flag.withDescription("also delete orphaned homestead-owned branches"),
    ),
    keepRemote: Flag.boolean("keep-remote").pipe(
      Flag.withDescription("never delete remote branches (mirrors kill/complete)"),
    ),
    json: Flag.boolean("json").pipe(Flag.withDescription("emit the machine-readable plan")),
  },
  ({ prune, yes, branches, keepRemote, json }) =>
    Effect.gen(function* () {
      const repo = yield* resolveRepo();
      const config = yield* loadConfigOrUndefined(repo.primaryRoot);
      yield* runGc(repo, config, { prune, yes, branches, keepRemote, json });
    }),
).pipe(
  Command.withDescription("reconcile + reclaim orphaned worktrees, state, GitHub signals, and branches"),
);

const agentCommand = Command.make("agent", {}).pipe(
  Command.withDescription("agent lifecycle commands"),
  Command.withSubcommands([agentSpawnCommand, agentPromptCommand, agentResultCommand, agentWaitCommand]),
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
    agentCommand,
    lsCommand,
    gcCommand,
  ]),
);

const program = Command.run(homestead, { version: pkg.version });

program.pipe(
  Effect.catchTags({
    ConfigNotFound: (error: ConfigNotFound) =>
      fail(`[homestead] ${error.detail}\n  Add a homestead.config.ts at your repo root: export default { ... } satisfies HomesteadConfig`),
    ConfigInvalid: (error: ConfigInvalid) => fail(`[homestead] invalid config at ${error.path}: ${error.reason}`),
    ExternalCommandError: (error: ExternalCommandError) =>
      fail(`[homestead] ${error.command} failed: ${error.detail}`),
    ServiceUnavailable: (error: ServiceUnavailable) =>
      fail(`[homestead] service '${error.name}' (${error.host}:${error.port}) ${error.detail}`),
  }),
  Effect.provide(AppLayer),
  BunRuntime.runMain,
);
