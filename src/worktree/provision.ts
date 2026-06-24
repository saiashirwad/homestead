import { Console, Effect, FileSystem } from "effect";
import { ConfigInvalid, ServiceUnavailable } from "../errors.ts";
import { applyTemplate, setEnvVar } from "../text.ts";
import { pollSchedule, probeTcp, run, runExit } from "../process.ts";
import { DEFAULT_SERVICE_TIMEOUT_MS } from "../defaults.ts";
import {
  type HomesteadConfig,
  type Plan,
} from "../types.ts";
import type { Repo } from "./repo.ts";

// Write the worktree's .env: the source body with our owned keys overridden.
export const writeEnv = Effect.fn("homestead/write-env")(function* (plan: Plan) {
  const fs = yield* FileSystem.FileSystem;
  const lines = plan.envEdits.reduce(
    (acc, [key, value]) => setEnvVar(acc, key, value),
    plan.sourceContent.split("\n"),
  );
  yield* fs.writeFileString(plan.envPath, lines.join("\n"));
  yield* Console.log(`\n✓ wrote ${plan.envPath}`);
});

// Make sure each configured TCP service is reachable (starting it if a `start`
// command is given, then polling until it accepts connections).
export const ensureServices = Effect.fn("homestead/ensure-services")(function* (
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

// Run the config's ordered setup commands against the worktree.
export const runSetup = Effect.fn("homestead/run-setup")(function* (repo: Repo, plan: Plan, config: HomesteadConfig) {
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
    const injected = Object.fromEntries(
      (step.injectEnv ?? [])
        .map((key) => [key, envMap[key]] as const)
        .filter((entry): entry is readonly [string, string] => entry[1] !== undefined),
    );
    const runOptions = { cwd, ...(Object.keys(injected).length > 0 ? { env: injected } : {}) };

    if (step.fatal === false) {
      const code = yield* runExit(command, args, runOptions);
      if (code !== 0) {
        yield* Console.log(`\n⚠ ${step.label} failed (exit ${code}) — continuing (fatal: false)`);
      }
    } else {
      yield* run(step.label, command, args, runOptions);
    }
  }
});

export const printDone = Effect.fn("homestead/print-done")((plan: Plan) =>
  Console.log(`\n✅ Worktree ready: ${plan.targetDir}`),
);
