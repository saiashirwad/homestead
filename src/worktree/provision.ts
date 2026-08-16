import { Console, Effect, FileSystem } from "effect";
import { ConfigInvalid, ServiceUnavailable } from "../errors.ts";
import { applyTemplate, setEnvVar } from "../text.ts";
import { pollSchedule, probeTcp, run, runExit } from "../process.ts";
import { DEFAULT_SERVICE_TIMEOUT_MS } from "../defaults.ts";
import type { HomesteadConfig, Plan, SetupStep, TeardownStep } from "../types.ts";
import type { Repo } from "./repo.ts";

export const writeEnv = Effect.fnUntraced(function* (plan: Plan) {
  const fs = yield* FileSystem.FileSystem;
  const lines = plan.envEdits.reduce(
    (acc, [key, value]) => setEnvVar(acc, key, value),
    plan.sourceContent.split("\n"),
  );
  yield* fs.writeFileString(plan.envPath, lines.join("\n"));
  yield* Console.log(`\n✓ wrote ${plan.envPath}`);
});

export const ensureServices = Effect.fnUntraced(function* (
  repo: Repo,
  config: HomesteadConfig,
) {
  for (const service of config.services ?? []) {
    const timeoutMs = service.timeoutMs ?? DEFAULT_SERVICE_TIMEOUT_MS;
    const pollRetries = Math.max(0, Math.ceil(timeoutMs / 1000) - 1);
    const reachable = yield* probeTcp(service.host, service.port, 1000);
    if (reachable) continue;
    const start = service.start;
    if (start === undefined || start.length === 0) {
      return yield* new ServiceUnavailable({
        name: service.name,
        host: service.host,
        port: service.port,
        detail: `unreachable and no \`start\` command configured`,
      });
    }
    yield* Console.log(
      `\n▸ ${service.name} unreachable on ${service.host}:${service.port} — starting it`,
    );
    const command = start[0];
    if (command === undefined || command === "") {
      return yield* new ServiceUnavailable({
        name: service.name,
        host: service.host,
        port: service.port,
        detail: "`start` command was empty",
      });
    }
    const args = start.slice(1);
    const code = yield* runExit(command, args, { cwd: repo.primaryRoot });
    if (code !== 0) {
      return yield* new ServiceUnavailable({
        name: service.name,
        host: service.host,
        port: service.port,
        detail: `start command exited ${code}`,
      });
    }
    const up = yield* probeTcp(service.host, service.port, 1000).pipe(
      Effect.repeat({ schedule: pollSchedule(pollRetries), until: (ok) => ok }),
    );
    if (!up) {
      return yield* new ServiceUnavailable({
        name: service.name,
        host: service.host,
        port: service.port,
        detail: `still unreachable ${timeoutMs}ms after running its start command`,
      });
    }
  }
});

export const runSetup = Effect.fnUntraced(function* (
  repo: Repo,
  plan: Plan,
  config: HomesteadConfig,
) {
  const vars: Record<string, string> = {
    slug: plan.slug,
    branch: plan.branch,
    targetDir: plan.targetDir,
    primaryRoot: repo.primaryRoot,
    repoName: repo.repoName,
  };
  const envMap = Object.fromEntries(plan.envEdits);

  for (const step of config.setup ?? []) {
    const argv = step.run.map((arg) => applyTemplate(arg, vars, envMap));
    const command = argv[0];
    if (command === undefined || command === "") {
      return yield* new ConfigInvalid({
        path: "setup",
        reason: `step "${step.label}" has an empty command`,
      });
    }
    const args = argv.slice(1);
    const cwd = step.cwd === undefined ? plan.targetDir : applyTemplate(step.cwd, vars, envMap);

    yield* Console.log(`\n▸ Setup: ${step.label} (${step.run.join(" ")})`);
    if (step.fatal === false) {
      const code = yield* runExit(command, args, { cwd, env: envMap });
      if (code !== 0) {
        yield* Console.log(`  ⚠ setup step "${step.label}" exited ${code} (ignored)`);
      }
    } else {
      yield* run(step.label, command, args, { cwd, env: envMap });
    }
  }
});

export const runTeardown = Effect.fnUntraced(function* (
  repo: Repo,
  worktreeDir: string,
  slug: string,
  branch: string,
  config: HomesteadConfig,
) {
  const vars: Record<string, string> = {
    slug,
    branch,
    targetDir: worktreeDir,
    primaryRoot: repo.primaryRoot,
    repoName: repo.repoName,
  };

  for (const step of config.teardown ?? []) {
    const argv = step.run.map((arg) => applyTemplate(arg, vars, {}));
    const command = argv[0];
    if (command === undefined || command === "") continue;
    const args = argv.slice(1);
    const cwd = step.cwd === undefined ? repo.primaryRoot : applyTemplate(step.cwd, vars, {});
    yield* Console.log(`\n▸ Teardown: ${step.label} (${step.run.join(" ")})`);
    yield* runExit(command, args, { cwd });
  }
});

export const printDone = Effect.fnUntraced(function* (plan: Plan) {
  yield* Console.log(`\n✅ Worktree ready: ${plan.targetDir}`);
});
