---
name: homestead-setup
description: Use when the user wants to set up homestead in a repo or author/repair a homestead.config.ts (e.g. "set up homestead in this repo", "write my homestead.config.ts", "fix my homestead config"). Walks a discovery recipe to derive ports, env, services, and setup steps from the repo instead of guessing.
---

# homestead-setup

## Overview

Author (or repair) a `homestead.config.ts` for the current repo. homestead gives each git worktree its own ports, its own copied/derived `.env`, and its own provisioning — so **everything else misbehaves until this config is right**. Your job is to *discover* the repo's real ports, env, and setup commands and encode them, not to guess plausible-looking values.

**The golden rule: derive, never hardcode.** Every port, db name, and command must come from something you actually found in the repo (`package.json`, compose file, env files, framework config). If you can't find it, ask — don't invent.

The authoritative option set lives in **`homestead.config.example.ts`** at the repo root (a fully-commented reference) and is validated by the schema in `src/config-schema.ts`. Read the example before writing; mirror its shape so the result stays valid.

## The discovery recipe

Work through these in order. Each produces one section of the config.

### 1. Ports — `ports: [{ key, base }]`

Worktrees run in parallel, so every listening port needs a distinct per-worktree value. Find the *real* ports the repo listens on; emit one `{ key, base }` per distinct port, where `key` is the env var the app reads and `base` is the default it falls back to.

Grep, in order of reliability:
- `.env` / `.env.example` — `PORT=`, `CLIENT_PORT=`, `*_PORT=` lines (most authoritative).
- `package.json` `scripts` — `--port 3000`, `-p 5173`, `PORT=3000 ...` prefixes.
- Framework config — `vite.config.*` (`server.port`), `next.config.*` / Next default `3000`, `astro.config.*`, etc.
- `docker-compose.yml` — `ports:` mappings for app services (not backing services — those are `services`, see below).

One `{ key, base }` per **distinct** port. A repo with a server on 3000 and a Vite client on 5173 → two entries. **Never** hardcode a port you didn't find; if the app reads a port from an env var with no default, surface that as an open question.

### 2. env — `env: { source, fallback, derive }`

`source` is the `.env` copied into each worktree (the real dev values, usually `.env`); `fallback` is `.env.example`. `derive` returns the keys that must *differ per worktree* so two worktrees don't collide on shared infra.

`derive: ({ slug, env }) => ({ ... })` patterns — match these to what the repo actually uses:

- **Database URL** — give each worktree its own logical DB on the shared server. Swap only the **db-name segment** of the DSN, preserving creds/host/`?query`. Copy the `withDbName` helper from `homestead.config.example.ts`:
  `DATABASE_URL: withDbName(env("DATABASE_URL") ?? DEFAULT, \`myapp_${slug}\`)`
- **Redis** — swap the **`/N` database index**, never the host (Redis has 16 numbered DBs on one server). e.g. rewrite the trailing `/0` to a slug-derived index.
- **Object storage / buckets** — suffix the bucket/prefix with the slug (`uploads` → `uploads-${slug}`).
- **OAuth callback URLs** — rewrite the port in the callback to the worktree's allocated port. **See the loud warning below — this is only half a fix.**

Only derive what genuinely collides. A key that's safe to share across worktrees (an API key, a public URL) should be left to the plain copied `.env` — don't derive it.

### 3. services — `services: [{ name, host, port, start }]`

Shared backing services (Postgres, Redis, etc.) that must be **up before provisioning**. Parse `docker-compose.yml`: each backing service becomes one entry with its `host`/`port` and a `start` command that brings just it up, e.g. `start: ["docker", "compose", "up", "-d", "db"]`. If there's no compose file and no obvious local service, omit `services` entirely.

### 4. setup — ordered `setup: [{ label, run, injectEnv?, fatal? }]`

The commands that provision a fresh worktree, **in dependency order**. Read `package.json` `scripts` and order them:

1. `install` (`bun install` / `pnpm install` / `npm install` — match the lockfile).
2. code generation (`generate`, `prisma generate`, `codegen`) if present.
3. `migrate` — DB schema. Add `injectEnv: ["DATABASE_URL"]` so the *derived* per-worktree URL wins over any value a script loads from a checked-in `--env-file`.
4. `seed` — usually `injectEnv: ["DATABASE_URL"]` and `fatal: false` (a blank `.env` can make seed fail, but the schema is still ready).
5. `build` only if the dev flow needs it.

**`injectEnv` on every step that touches the database** — this is the most common bug in a hand-written config: migrations run against the wrong DB because the derived URL wasn't injected.

## Guardrails — do NOT paper over these

### OAuth callbacks — warn loudly, don't pretend

You can rewrite the callback **URL** in the worktree's env, but the config **cannot register that new port/URL with the OAuth provider** (Google, GitHub, etc. only accept callbacks on URLs allow-listed in their dashboard). So a derived OAuth callback will *look* right and still fail at login. When you emit an OAuth-related derive, tell the user plainly:

> ⚠️ I rewrote the OAuth callback to the worktree's port, but **you must add that exact callback URL to the provider's allowed-redirects list yourself** — homestead can't do that. Until you do, OAuth login in this worktree will fail.

Never silently emit an OAuth derive as if it solved the problem.

### Shared infra with no isolation strategy — ask, don't invent

If you find shared infra (a message queue, a single-tenant external service, a bucket with no namespacing) where two worktrees would **fight over the same resource** and there's no clean per-worktree derive, **stop and surface it as an open question** rather than inventing a derive that two worktrees will corrupt. e.g.:

> Open question: both worktrees would publish to the same `orders` queue / write the same S3 prefix. There's no obvious per-worktree split. How do you want to isolate this — namespace by slug, share it read-only, or run a local stand-in?

A wrong derive here is worse than none: it gives false confidence while two sessions silently clobber each other.

### Secrets — keys only, never values

The `.env` you read contains live secrets. **Never** echo a secret *value* into chat or into `homestead.config.ts`. The config references env **keys** (`env("DATABASE_URL")`), never literals. When you explain what you found, say "I found a `STRIPE_SECRET_KEY` entry" — never paste the value. The real values stay in `.env`, which homestead copies per worktree; the config only describes how to *transform* them.

## Worktrees

This skill writes config; it does **not** create worktrees. Defer to the built-in `using-git-worktrees` skill only to note: in a homestead repo, use **`homestead worktree <slug>`** — do not hand-roll `git worktree`, because homestead's command is what allocates ports, derives the env, and runs setup.

## Finishing

- Validate the result mentally against `homestead.config.example.ts` and `src/config-schema.ts` — same field names, same shapes. `ports`/`services`/`setup` are arrays; `env`/`agent`/`issues`/`pr` are optional objects.
- Keep `agent: { command: ["claude"], surface: "worktree" }` unless the repo clearly uses a different agent.
- Summarize what you derived and from where (e.g. "ports from `vite.config.ts` + `.env.example`; DB derive swaps the db-name segment"), and list any open questions you surfaced. Don't claim the config is complete if an open question is unresolved.
