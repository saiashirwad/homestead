# homestead

Programmable Git worktree orchestration with dynamic port allocation, isolated environments, and a typed RPC control plane.

Built for **AI coding agents, multi-agent parallel executors, CI pipelines, and developer tooling** that need to spin up and tear down isolated Git workspaces without colliding on ports, environment variables, or database state.

```bash
bun add homestead
```

---

## Why Homestead?

When orchestrating parallel agents or background tasks across Git worktrees:

- **Port Contention**: Every instance tries to bind `:3000` or `:5173`. Homestead scans active listeners and sibling worktrees to allocate conflict-free ports deterministically.
- **Environment Collision**: Worktrees overwrite the shared `.env`. Homestead generates branch-isolated `.env` files with dynamic ports and derived config (e.g., unique database names).
- **Service & Setup Coordination**: Automates prerequisite health checks (Postgres, Redis) and setup commands (`bun install`, migrations) before the worktree is handed off.
- **Idempotent Control Plane**: Built-in `requestId` deduplication ensures agent retries replay identical results without duplicating worktrees or corrupting state.

---

## Programmatic Client

Homestead exposes a typed Effect client communicating over a local Unix domain socket (`~/.homestead/run/daemon.sock`).

```ts
import { makeClient } from "homestead"
import { Effect } from "effect"

const program = Effect.gen(function* () {
  const client = yield* makeClient()

  // 1. Provision an isolated worktree
  const worktree = yield* client.createWorktree({
    requestId: "agent-task-42",
    repoRoot: process.cwd(),
    name: "feature-billing",
    from: "main", // optional base ref
  })

  console.log(`Worktree directory: ${worktree.path}`)
  console.log(`Allocated ports:`, worktree.ports) // e.g. { PORT: 3001, VITE_PORT: 5174 }

  // 2. Query active worktrees
  const active = yield* client.listWorktrees({ repoRoot: process.cwd() })

  // 3. Teardown and clean up after task completion
  yield* client.removeWorktree({
    requestId: "agent-task-42-cleanup",
    repoRoot: process.cwd(),
    name: "feature-billing",
  })
})

Effect.runPromise(program)
```

### Client API

| Method                  | Payload                                 | Returns                               | Description                                                  |
| ----------------------- | --------------------------------------- | ------------------------------------- | ------------------------------------------------------------ |
| `client.createWorktree` | `{ requestId, repoRoot, name, from? }`  | `Effect<WorktreeInfo>`                | Creates worktree, allocates ports, writes `.env`, runs setup |
| `client.listWorktrees`  | `{ repoRoot? }`                         | `Effect<ReadonlyArray<WorktreeInfo>>` | Lists managed worktrees with paths and port allocations      |
| `client.removeWorktree` | `{ requestId, repoRoot, name, force? }` | `Effect<RemoveWorktreeResult>`        | Runs teardown hooks, removes worktree and branch             |
| `client.ping`           | `void`                                  | `Effect<{ timestamp: number }>`       | Health check probe                                           |
| `client.shutdown`       | `void`                                  | `Effect<void>`                        | Gracefully stops the daemon                                  |

---

## Configuration (`homestead.config.ts`)

Define repository-level provisioning rules in `homestead.config.ts`:

```ts
import type { HomesteadConfig } from "homestead"

export default {
  // Conflict-free ports allocated per worktree
  ports: [
    { key: "PORT", base: 3000 },
    { key: "VITE_PORT", base: 5173 },
  ],

  // Environment derivation
  env: {
    source: ".env",
    fallback: ".env.example",
    derive: ({ slug }) => ({
      DATABASE_URL: `postgres://localhost:5432/app_${slug}`,
    }),
  },

  // Ensure dependencies are ready before setup runs
  services: [
    {
      name: "postgres",
      host: "localhost",
      port: 5432,
      start: ["docker", "compose", "up", "-d", "db"],
    },
  ],

  // Lifecycle hooks
  setup: [
    { label: "install", run: ["bun", "install"] },
    { label: "migrate", run: ["bun", "run", "db:migrate"] },
  ],
  teardown: [{ label: "drop-db", run: ["bun", "run", "db:drop"] }],
} satisfies HomesteadConfig
```

---

## Daemon & CLI

Homestead can be managed directly via CLI for development and daemon lifecycle management:

```bash
# Daemon Lifecycle
homestead server      # Start the RPC daemon (~/.homestead/run/daemon.sock)
homestead ping        # Check daemon status
homestead shutdown    # Stop the daemon

# Manual Workspace Management
homestead init        # Scaffold starter homestead.config.ts
homestead create <name> [--from <ref>]
homestead ls
homestead rm <name> [--force]
```

---

## License

MIT
