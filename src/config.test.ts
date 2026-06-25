import { expect, test } from "bun:test";
import { Effect } from "effect";
import { Schema } from "effect";
import { validateConfigShape } from "./config.ts";
import { ConfigDataSchema } from "./config-schema.ts";
import { requireAgentConfig } from "./issue/provision.ts";
import type { HomesteadConfig } from "./types.ts";

const decodeConfigData = Schema.decodeUnknownSync(ConfigDataSchema);

test("ConfigDataSchema reports all validation errors", () => {
  const invalid = {
    ports: [{ key: "", base: -1 }],
    services: [{ name: "x", host: "localhost", port: 0 }],
  };
  try {
    decodeConfigData(invalid);
    expect.unreachable();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    expect(reason).toContain("ports");
    expect(reason).toContain("services");
  }
});

test("validateConfigShape preserves function fields", () => {
  const derive = () => ({ FOO: "bar" });
  const prompt = () => "hello";
  const branch = () => "branch";
  const comment = () => "comment";
  const config: HomesteadConfig = {
    env: { derive },
    agent: { prompt },
    issues: { branch, comment },
  };
  const merged = validateConfigShape(config);
  expect(merged.env?.derive).toBe(derive);
  expect(merged.agent?.prompt).toBe(prompt);
  expect(merged.issues?.branch).toBe(branch);
  expect(merged.issues?.comment).toBe(comment);
});

test("lifecycle hooks survive validateConfigShape untouched", () => {
  const afterLaunch = () => Effect.void;
  const beforeTeardown = () => Effect.void;
  const afterTeardown = () => Effect.void;
  const config: HomesteadConfig = { afterLaunch, beforeTeardown, afterTeardown };
  const merged = validateConfigShape(config);
  expect(merged.afterLaunch).toBe(afterLaunch);
  expect(merged.beforeTeardown).toBe(beforeTeardown);
  expect(merged.afterTeardown).toBe(afterTeardown);
});

test("validateConfigShape preserves pr block (checks + prompt overrides)", () => {
  const reviewPrompt = () => "review";
  const workPrompt = () => "work";
  const config: HomesteadConfig = {
    pr: { checks: "bun run check", reviewPrompt, workPrompt },
  };
  const merged = validateConfigShape(config);
  expect(merged.pr?.checks).toBe("bun run check");
  expect(merged.pr?.reviewPrompt).toBe(reviewPrompt);
  expect(merged.pr?.workPrompt).toBe(workPrompt);
});

test("requireAgentConfig applies default prompt when unset", async () => {
  const agent = await Effect.runPromise(requireAgentConfig({ command: ["claude"] }));
  expect(agent.prompt).toBeTypeOf("function");
  expect(agent.command).toEqual(["claude"]);
});

test("requireAgentConfig preserves explicit prompt", async () => {
  const prompt = () => "hello";
  const agent = await Effect.runPromise(requireAgentConfig({ command: ["claude"], prompt }));
  expect(agent.prompt).toBe(prompt);
});
