// homestead's own homestead.config.ts — homestead dogfooding itself.
//
// homestead is a Bun + Effect CLI, not a server: no ports, no .env, no services,
// no database. Provisioning a worktree is just `bun install` (whose `prepare`
// lifecycle hook runs scripts/prepare-effect.sh to vendor Effect's source).
//
// Run from the repo root, inside a herdr session:
//   homestead setup --create my-feature
//   homestead implement-issues 2          # work issue #2 (the agent-loop PRD)
//   homestead listen                      # drain the agent:ready backlog
//   homestead kill my-feature

import { defineConfig } from "homestead";

export default defineConfig({
  // No ports / env / services — a CLI worktree needs none of them.

  // Vendor Effect's source (the `prepare` hook fires on install) and get deps.
  setup: [{ label: "install", run: ["bun", "install"] }],

  // Opt-in issue tracking: reflect agent activity onto the GitHub issue.
  // Added when an agent starts, reversed on `homestead kill`.
  issues: {
    branch: (item) => String(item.number),
    label: "agent:wip", // added on start (auto-created), removed on kill
    assign: true,
    comment: true,
  },

  // How each agent is launched (ADR-0001 agent loop). The loop spawns headless
  // `claude -p` per iteration; --dangerously-skip-permissions lets it run gh/git
  // and edit files unattended (no interactive prompt exists to approve tools in
  // headless mode). Blast radius is the worktree + host bash; the PR review is the
  // gate, a sandbox is the future mitigation.
  agent: {
    command: ["claude", "--dangerously-skip-permissions"],
    surface: "worktree", // nest each agent under homestead's workspace in herdr
    // Dogfood the review-converge gate (ADR-0003): before a PR opens, homestead runs
    // its own checks (the machine gate) and a fresh-context adversarial reviewer.
    // So homestead's own issues are hardened by the feature it ships. maxIterations,
    // sentinels, and the /homestead-plan + /homestead-implement + /homestead-review
    // skills take their defaults.
    loop: {
      review: true, // adversarial fresh-context review + machine gate before the PR
      verifyCommand: ["bun", "run", "check"], // the deterministic gate: typecheck then test
      // maxReviewRounds defaults to 3 — a builder that can't satisfy the reviewer in
      // 3 rounds is handed to a human (agent:blocked) rather than looping forever.
    },
  },

  // `homestead listen` — poll for open issues labelled agent:ready and auto-work
  // them, up to maxConcurrent at a time. Kept low: each agent runs `bun install`
  // + vendors Effect, so 2 in flight is plenty for this repo.
  listen: {
    label: "agent:ready",
    intervalSeconds: 10,
    maxConcurrent: 5,
  },
});
