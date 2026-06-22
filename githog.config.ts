// githog's own githog.config.ts — githog dogfooding itself.
//
// githog is a Bun + Effect CLI, not a server: no ports, no .env, no services,
// no database. Provisioning a worktree is just `bun install` (whose `prepare`
// lifecycle hook runs scripts/prepare-effect.sh to vendor Effect's source).
//
// Run from the repo root, inside a herdr session:
//   githog setup --create my-feature
//   githog implement-issues 2          # work issue #2 (the Ralph-loop PRD)
//   githog listen                      # drain the agent:ready backlog
//   githog kill my-feature

import { defineConfig } from "githog";

export default defineConfig({
  // No ports / env / services — a CLI worktree needs none of them.

  // Vendor Effect's source (the `prepare` hook fires on install) and get deps.
  setup: [{ label: "install", run: ["bun", "install"] }],

  // Opt-in issue tracking: reflect agent activity onto the GitHub issue.
  // Added when an agent starts, reversed on `githog kill`.
  issues: {
    branch: (item) => String(item.number),
    label: "agent:wip", // added on start (auto-created), removed on kill
    assign: true,
    comment: true,
  },

  // How each agent is launched. Today this sends one prompt to an interactive
  // claude. Once issue #2 (the Ralph loop runner) lands, this block evolves into
  // the loop config (iteration cap, sentinels, /githog-plan + /githog-implement
  // skills) — see docs/adr/0001-githog-driven-ralph-loop.md.
  agent: {
    command: ["claude"],
    surface: "worktree", // nest each agent under githog's workspace in herdr
    prompt: (item) => `/implement ${item.url}`,
  },

  // `githog listen` — poll for open issues labelled agent:ready and auto-work
  // them, up to maxConcurrent at a time. Kept low: each agent runs `bun install`
  // + vendors Effect, so 2 in flight is plenty for this repo.
  listen: {
    label: "agent:ready",
    intervalSeconds: 30,
    maxConcurrent: 2,
  },
});
