// The autonomous-agent pane wrapper. In autonomous mode homestead doesn't run
// bare `claude` in the pane — it wraps the launch in a tiny `sh -c` script so
// that *after the agent process exits* the harness re-invokes itself
// (`agent finalize`) to write `.homestead/agent-status.json` deterministically,
// instead of trusting the model to. The interactive handshake (trust → ready
// marker → typed prompt) is untouched: the finalize tail only fires once the
// inner agent quits.

// Single-quote a shell word: wrap in '...' and escape any embedded single quote
// as the canonical '\'' sequence. Safe for arbitrary argv (paths with spaces,
// flags, etc.) because nothing inside single quotes is special to the shell.
export const shQuote = (word: string): string => `'${word.replace(/'/g, "'\\''")}'`;

const quoteAll = (argv: ReadonlyArray<string>): string => argv.map(shQuote).join(" ");

// Wrap the resolved agent argv so the pane becomes:
//   <agent argv>; __hs_ec=$?; <self> agent finalize --agent-exit "$__hs_ec"
// `;` (not `&&`) so finalize runs whether the agent exits clean or crashes — a
// non-zero agent exit is exactly the signal finalize needs when no `check` is
// configured. `self` is how to re-invoke homestead (e.g. ["bun", "/abs/cli.ts"]
// or ["homestead"]), captured from process.argv at launch.
export const buildAutonomousCommand = (
  agentArgv: ReadonlyArray<string>,
  self: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const script = `${quoteAll(agentArgv)}; __hs_ec=$?; ${quoteAll(self)} agent finalize --agent-exit "$__hs_ec"`;
  return ["sh", "-c", script];
};

// How to re-invoke this homestead process from inside the pane. process.argv[0]
// is the runtime (bun) and [1] is the cli entry — re-running `<argv0> <argv1>`
// works in dev (bun src/cli.ts) and from an installed bin alike. Resolved once
// at launch so the wrapped command bakes in absolute paths.
export const selfInvocation = (): ReadonlyArray<string> => {
  const [runtime, entry] = process.argv;
  if (runtime === undefined || entry === undefined) return ["homestead"];
  return [runtime, entry];
};
