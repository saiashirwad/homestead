// homestead's own homestead.config.ts — homestead dogfooding itself.
//
// homestead is a Bun + Effect CLI, not a server: no ports, no .env, no services,
// no database. Provisioning a worktree is just `bun install` (whose `prepare`
// lifecycle hook runs scripts/prepare-effect.sh to vendor Effect's source).
//
// Run from the repo root, inside a herdr session:
//   homestead setup --create my-feature
//   homestead implement-issues 2          # provision a worktree + launch an agent on issue #2
//   homestead close 2                     # finalize: tear down, keep the branch, issue → review
//   homestead kill my-feature

import type { HomesteadConfig } from "./src/types.ts";

export default {
  // No ports / env / services — a CLI worktree needs none of them.

  // Vendor Effect's source (the `prepare` hook fires on install) and get deps.
  setup: [{ label: "install", run: ["bun", "install"] }],

  // Opt-in issue tracking: reflect agent activity onto the GitHub issue.
  // `agent:wip` on launch, reversed on `kill`, moved to `agent:review` on `close`.
  issues: {
    branch: (item) => String(item.number),
    label: "agent:wip",
    assign: true,
    comment: true,
  },

  // homestead boots an interactive Claude in a herdr pane per issue, waits for the
  // REPL, and types a kickoff prompt once — then steps away. Override `prompt` only
  // if you want a custom kickoff message.
  agent: {
    command: ["claude"],
    surface: "worktree", // nest each agent under homestead's workspace in herdr
  },
} satisfies HomesteadConfig;
