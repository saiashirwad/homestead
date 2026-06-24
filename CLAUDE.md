---
description: Bun + Effect project conventions
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

Use Bun, not Node: `bun test`, `bun install`, `bun run`, `bunx`. Bun loads `.env` automatically.

<!-- effect-solutions:start -->
## Effect Best Practices

**IMPORTANT:** Always consult effect-solutions before writing Effect code.

1. Run `effect-solutions list` to see available guides
2. Run `effect-solutions show <topic>...` for relevant patterns (supports multiple topics)
3. Search `~/.local/share/effect-solutions/effect` for real implementations

Topics: quick-start, project-setup, tsconfig, basics, services-and-layers, data-modeling, error-handling, config, testing, cli.

Never guess at Effect patterns - check the guide first.

### Effect version & ecosystem

This project uses **Effect v4** (`effect@4.0.0-beta.85`, `@effect/platform-bun`). In v4 the ecosystem is consolidated into the core `effect` package — most things that were separate `@effect/*` packages in v3 now live under `effect/...`. Notes:

- **Schema** lives in `effect/Schema` — do **not** install or import `@effect/schema` (the deprecated v3 package).
- **CLI** lives in `effect/unstable/cli` (`Argument`, `Command`, `Flag`) — do **not** install the standalone `@effect/cli` package; its published versions (`0.75.2`, snapshot) target Effect v3 and conflict with our v4 `effect`. `src/cli.ts` is built with `effect/unstable/cli` + `Command.run` on `BunServices.layer`. The `unstable/` prefix means the API may shift during the v4 beta.

### Local Effect Source

The Effect v4 source is cloned to `~/.local/share/effect-solutions/effect` (and to `.repos/effect` locally via `scripts/prepare-effect.sh`). Use it to explore APIs, find usage examples, and understand implementation details when the documentation isn't enough.
<!-- effect-solutions:end -->
