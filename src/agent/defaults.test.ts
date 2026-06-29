import { expect, test } from "bun:test";
import { resolveAgentDefaults, resolveCommand, STATUS_FILE_INSTRUCTION } from "./defaults.ts";

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
