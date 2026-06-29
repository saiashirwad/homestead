import { expect, test } from "bun:test";
import { buildAutonomousCommand, shQuote } from "./autonomous.ts";

test("shQuote wraps a plain word in single quotes", () => {
  expect(shQuote("claude")).toBe("'claude'");
});

test("shQuote escapes embedded single quotes", () => {
  // foo'bar  ->  'foo'\''bar'
  expect(shQuote("foo'bar")).toBe("'foo'\\''bar'");
});

test("shQuote keeps spaces and flags intact inside the quotes", () => {
  expect(shQuote("--model opus")).toBe("'--model opus'");
});

test("buildAutonomousCommand wraps the agent argv in sh -c and appends finalize", () => {
  const cmd = buildAutonomousCommand(["claude", "--model", "opus"], ["bun", "/abs/cli.ts"]);
  expect(cmd[0]).toBe("sh");
  expect(cmd[1]).toBe("-c");
  const script = cmd[2]!;
  // The agent runs first, then we capture its exit code, then finalize.
  expect(script).toBe(
    "'claude' '--model' 'opus'; __hs_ec=$?; 'bun' '/abs/cli.ts' agent finalize --agent-exit \"$__hs_ec\"",
  );
});

test("buildAutonomousCommand runs finalize regardless of the agent's exit (uses ';')", () => {
  const script = buildAutonomousCommand(["claude"], ["homestead"])[2]!;
  expect(script).toContain("; __hs_ec=$?;");
  expect(script).toContain("agent finalize --agent-exit");
});

test("buildAutonomousCommand shell-quotes a self path with spaces", () => {
  const script = buildAutonomousCommand(["claude"], ["bun", "/Users/a b/cli.ts"])[2]!;
  expect(script).toContain("'bun' '/Users/a b/cli.ts' agent finalize");
});
