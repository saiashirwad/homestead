import { expect, test } from "bun:test";
import {
  AUTONOMOUS_STATUS_INSTRUCTION,
  resolveAgentDefaults,
  resolveCommand,
  statusInstructionFor,
  STATUS_FILE_INSTRUCTION,
} from "./defaults.ts";

const ctx = { item: { number: 3, title: "t" }, args: ["--foo"] } as any;
const promptCtx = { item: { number: 3, title: "t", url: "u" }, args: [] } as any;

test("resolveCommand passes array through", () => {
  expect(resolveCommand(["claude"], ctx)).toEqual(["claude"]);
});
test("resolveCommand calls function with ctx", () => {
  expect(resolveCommand((c: any) => ["claude", "--model", c.item.number === 3 ? "opus" : "sonnet"], ctx))
    .toEqual(["claude", "--model", "opus"]);
});
test("resolveCommand defaults to ['claude']", () => {
  expect(resolveCommand(undefined, ctx)).toEqual(["claude"]);
});

test("appends the status-file instruction to the default prompt", () => {
  const prompt = resolveAgentDefaults({}).prompt(promptCtx);
  expect(prompt).toContain('#3: "t"');
  expect(prompt).toContain(STATUS_FILE_INSTRUCTION);
});

test("appends the status-file instruction to a custom prompt", () => {
  const prompt = resolveAgentDefaults({ prompt: () => "do the thing" }).prompt(promptCtx);
  expect(prompt).toBe("do the thing" + STATUS_FILE_INSTRUCTION);
});

test("statusFile: false suppresses the appended instruction", () => {
  const prompt = resolveAgentDefaults({ statusFile: false, prompt: () => "do the thing" }).prompt(
    promptCtx,
  );
  expect(prompt).toBe("do the thing");
});

test("statusFile defaults to enabled", () => {
  const prompt = resolveAgentDefaults({ prompt: () => "x" }).prompt(promptCtx);
  expect(prompt).toContain(STATUS_FILE_INSTRUCTION);
});

// --- autonomous mode ---------------------------------------------------------

test("statusInstructionFor: default vs autonomous vs opted-out", () => {
  expect(statusInstructionFor({})).toBe(STATUS_FILE_INSTRUCTION);
  expect(statusInstructionFor({ autonomous: true })).toBe(AUTONOMOUS_STATUS_INSTRUCTION);
  expect(statusInstructionFor({ statusFile: false })).toBe("");
  // statusFile:false wins over autonomous (no sentinel contract at all).
  expect(statusInstructionFor({ autonomous: true, statusFile: false })).toBe("");
});

test("autonomous mode swaps the plan-gate kickoff for build-to-completion", () => {
  const prompt = resolveAgentDefaults({ autonomous: true }).prompt(promptCtx);
  expect(prompt).toContain('#3: "t"');
  expect(prompt).not.toContain("show me your plan");
  expect(prompt).toContain("implement it fully and autonomously");
  expect(prompt).toContain(AUTONOMOUS_STATUS_INSTRUCTION);
});

test("autonomous mode keeps a custom prompt but appends the autonomous tail", () => {
  const prompt = resolveAgentDefaults({ autonomous: true, prompt: () => "do the thing" }).prompt(promptCtx);
  expect(prompt).toBe("do the thing" + AUTONOMOUS_STATUS_INSTRUCTION);
});

test("autonomous tail tells the agent to exit the session", () => {
  expect(AUTONOMOUS_STATUS_INSTRUCTION).toContain("/exit");
});
