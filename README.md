# homestead

Isolated development environments for Git worktrees.

When you create a worktree, sibling checkouts compete for port 3000, collide on `.env`, and conflict on database state. `homestead` automates worktree provisioning with collision-free port allocation, derived environment files, lifecycle hooks, and a typed RPC daemon.

```bash
bun add -g homestead
homestead init
homestead create feature-auth
```

---

## Quickstart

```bash
# Provision a new worktree (allocates ports, writes .env, runs setup)
homestead create feature-auth
homestead create feature-auth --from staging

# List active worktrees and port allocations
homestead ls

# Teardown and delete a worktree
homestead rm feature-auth
```

---

## How It Works

1. **Worktree Checkout**: Creates a Git worktree for the requested branch.
2. **Port Allocation**: Probes open sockets and sibling worktrees, assigning the next free port from your configured base.
3. **Environment Derivation**: Copies `.env.example` / `.env`, injects dynamic ports, and computes derived values (such as isolated database URLs).
4. **Lifecycle Hooks**: Verifies dependent services (e.g. Postgres, Redis) and runs setup commands (`bun install`, migrations) inside the target worktree.

---

## Configuration

Add `homestead.config.ts` to your repository root:

```ts
import type { HomesteadConfig } from "homestead"

export default {
  // Ports dynamically allocated per worktree
  ports: [
    { key: "PORT", base: 3000 },
    { key: "VITE_PORT", base: 5173 },
  ],

  // Environment file template & derivation
  env: {
    source: ".env",
    fallback: ".env.example",
    derive: ({ slug }) => ({
      DATABASE_URL: `postgres://localhost:5432/app_${slug}`,
    }),
  },

  // Service readiness checks before setup runs
  services: [
    {
      name: "postgres",
      host: "localhost",
      port: 5432,
      start: ["docker", "compose", "up", "-d", "db"],
    },
  ],

  // Commands executed in the worktree on creation
  setup: [
    { label: "install", run: ["bun", "install"] },
    { label: "migrate", run: ["bun", "run", "db:migrate"] },
  ],

  // Commands executed before removing the worktree
  teardown: [{ label: "drop-db", run: ["bun", "run", "db:drop"] }],
} satisfies HomesteadConfig
```

---

## Daemon & RPC API

Homestead includes a daemon and typed client for programmatic control by scripts, CI, and AI agents:

```bash
homestead server      # Start the daemon (~/.homestead/run/daemon.sock)
homestead ping        # Check daemon health
homestead shutdown    # Stop the daemon
```

### Programmatic Client

```ts
import { makeClient } from "homestead"
import { Effect } from "effect"

const program = Effect.gen(function* () {
  const client = yield* makeClient()

  // Create an isolated worktree
  const worktree = yield* client.createWorktree({
    requestId: "task-101",
    repoRoot: process.cwd(),
    name: "feature-billing",
  })

  console.log(`Ready at: ${worktree.path}`)
  console.log(`Allocated ports:`, worktree.ports)
})
```

---

## License

MIT
