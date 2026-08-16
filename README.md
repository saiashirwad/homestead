# homestead

Worktrees that don't fight over port 3000.

When you create a git worktree, you get a clean checkout in seconds. But both branches want the same ports, the same `.env`, and the same database.

`homestead` provisions each worktree with unique ports, derived config, and runs your setup scripts automatically. It also runs a local daemon with a Unix domain socket RPC API so scripts, tools, and AI agents can spin up environments programmatically.

```bash
bun add -g homestead
homestead init
homestead create feature-auth
```

---

## What happens on `homestead create`

1. **Git worktree**: runs `git worktree add` for your branch.
2. **Ports**: scans sibling worktrees and local listeners, picking the next available ports starting from your configured base.
3. **Environment**: copies `.env.example` (or `.env`), injects the allocated ports, and evaluates any derived variables (like `DATABASE_URL` with a branch-specific DB name).
4. **Setup**: runs your configured setup steps (`bun install`, migrations, etc.) inside the new directory.

---

## CLI

```bash
# Provision a worktree (allocates ports, writes .env, runs setup)
homestead create feature-auth
homestead create feature-auth --from staging

# List worktrees and allocated ports
homestead ls

# Remove a worktree and run teardown hooks
homestead rm feature-auth
homestead rm main --force

# Daemon & IPC (Unix domain socket at ~/.homestead/run/daemon.sock)
homestead server      # start the RPC daemon
homestead ping        # check daemon status
homestead shutdown    # stop the daemon
```

---

## Config (`homestead.config.ts`)

```ts
import type { HomesteadConfig } from "homestead"

export default {
  // Ports to allocate per worktree
  ports: [
    { key: "PORT", base: 3000 },
    { key: "VITE_PORT", base: 5173 },
  ],

  // Environment file derivation
  env: {
    source: ".env",
    fallback: ".env.example",
    derive: ({ slug }) => ({
      DATABASE_URL: `postgres://localhost:5432/app_${slug}`,
    }),
  },

  // Ensure dependencies are reachable before setup
  services: [
    {
      name: "postgres",
      host: "localhost",
      port: 5432,
      start: ["docker", "compose", "up", "-d", "db"],
    },
  ],

  // Commands run inside the worktree after creation
  setup: [
    { label: "install", run: ["bun", "install"] },
    { label: "migrate", run: ["bun", "run", "db:migrate"], injectEnv: ["DATABASE_URL"] },
  ],

  // Commands run before removing the worktree
  teardown: [{ label: "drop-db", run: ["bun", "run", "db:drop"] }],
} satisfies HomesteadConfig
```

---

## Control Plane (RPC over Unix Domain Socket)

Homestead runs a typed RPC server (`@effect/rpc`) over a Unix domain socket at `~/.homestead/run/daemon.sock`.

You can talk to it from Node/Bun or any language using line-delimited JSON (NDJSON) over the socket:

```ts
import { makeClient } from "homestead"
import { Effect } from "effect"

const program = Effect.gen(function* () {
  const client = yield* makeClient()

  const worktree = yield* client.createWorktree({
    requestId: "task-101",
    repoRoot: process.cwd(),
    name: "fix-nav",
  })

  console.log(`Worktree ready at: ${worktree.path}`)
  console.log(`Allocated ports:`, worktree.ports)
})
```

RPC endpoints:

- `v1/daemon/ping`
- `v1/daemon/shutdown`
- `v1/worktree/create`
- `v1/worktree/list`
- `v1/worktree/remove`

---

## License

MIT
