import { Effect } from "effect";
import { DEFAULT_AGENT_COMMAND, DEFAULT_AGENT_READY_MARKER, type AgentConfig } from "../types.ts";
import { Herdr } from "./service.ts";

export const BOOT_SETTLE_MS = 1000;
export const DEFAULT_TRUST_TIMEOUT_MS = 8_000;
export const DEFAULT_SUBMIT_PAUSE_MS = 750;
export const DEFAULT_READY_TIMEOUT_MS = 30_000;

export interface AgentSpec {
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
  readonly trustPrompt?: { readonly marker: string; readonly confirm: ReadonlyArray<string> };
  readonly readyMarker: string;
  readonly readyRegex?: boolean;
}

export interface LaunchOptions {
  readonly readyTimeoutMs?: number;
  readonly submitPauseMs?: number;
  readonly trustTimeoutMs?: number;
  readonly bootSettleMs?: number;
  readonly pollMs?: number;
}

export const toSpec = (agent: AgentConfig): AgentSpec => {
  const command = agent.command ?? DEFAULT_AGENT_COMMAND;
  const binary = command[0] ?? "claude";
  const trustPrompt = agent.trustPrompt === false ? undefined : agent.trustPrompt;

  return {
    command: binary,
    args: command.slice(1),
    readyMarker: agent.readyMarker ?? DEFAULT_AGENT_READY_MARKER,
    readyRegex: agent.readyRegex,
    trustPrompt,
  };
};

export const launchAndSeed = Effect.fn("herdr/launch-and-seed")(function* (
  paneId: string,
  spec: AgentSpec,
  prompt: string,
  options?: LaunchOptions,
) {
  const herdr = yield* Herdr;
  yield* herdr.pane.run(paneId, spec.command, ...(spec.args ?? []));
  yield* Effect.sleep(`${options?.bootSettleMs ?? BOOT_SETTLE_MS} millis`);

  const trust = spec.trustPrompt;
  const trustTimeoutMs = options?.trustTimeoutMs ?? DEFAULT_TRUST_TIMEOUT_MS;
  const pollMs = options?.pollMs;
  if (trust) {
    const gateSeen = yield* herdr.waitForMarker(paneId, trust.marker, { timeoutMs: trustTimeoutMs, pollMs }).pipe(
      Effect.as(true),
      Effect.catchTag("HerdrTimeout", () => Effect.succeed(false)),
    );
    if (gateSeen) {
      yield* herdr.pane.sendKeys(paneId, ...trust.confirm);
      yield* herdr.waitUntilGone(paneId, trust.marker, { timeoutMs: trustTimeoutMs, pollMs });
    }
  }

  yield* herdr.waitForMarker(paneId, spec.readyMarker, {
    timeoutMs: options?.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
    regex: spec.readyRegex,
    pollMs,
  });

  yield* herdr.pane.sendText(paneId, prompt);
  yield* Effect.sleep(`${options?.submitPauseMs ?? DEFAULT_SUBMIT_PAUSE_MS} millis`);
  yield* herdr.pane.sendKeys(paneId, "Enter");
});
