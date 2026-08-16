# homestead

An Effect-native control plane for isolated, reproducible development Workspaces.

Homestead gives people, scripts, CI systems, and future agent runtimes the same durable Workspace lifecycle. The first Provider uses Git worktrees; the public model leaves room for containers and remote environments.

## Installation

```bash
# As a TypeScript/Effect library:
bun add homestead

# As a standalone CLI (no Node/Bun runtime required):
curl -fsSL https://raw.githubusercontent.com/saiashirwad/homestead/main/scripts/install.sh | bash

# Or globally via Bun/NPM:
bun add -g homestead
```

---

## Why Homestead?

When running parallel development tasks:

- **Port Contention**: Every instance tries to bind `:3000` or `:5173`. Homestead scans active listeners and sibling worktrees to allocate conflict-free ports deterministically.
- **Environment Collision**: Worktrees overwrite the shared `.env`. Homestead generates branch-isolated `.env` files with dynamic ports and derived config (e.g., unique database names).
- **Service & Setup Coordination**: Automates prerequisite health checks (Postgres, Redis) and setup commands (`bun install`, migrations) before the worktree is handed off.
- **Durable Lifecycle**: Workspace identity, base revision, state, ports, Provider capabilities, and metadata survive daemon restarts.
- **Transactional Cleanup**: Failed or cancelled provisioning closes the Workspace scope, releases reservations, and removes the partial worktree and branch.
- **Idempotent Control Plane**: Built-in `requestId` deduplication prevents retries from duplicating Workspaces in one daemon lifetime.

---

## Programmatic Client

Homestead exposes a typed Effect client communicating over a local Unix domain socket (`~/.homestead/run/daemon.sock`).

```ts
import { makeClient } from "homestead"
import { Effect } from "effect"

const program = Effect.gen(function* () {
  const client = yield* makeClient()

  // 1. Provision an isolated Workspace
  const workspace = yield* client.createWorkspace({
    requestId: "task-42",
    projectRoot: process.cwd(),
    name: "feature-billing",
    from: "main", // optional base ref
  })

  console.log(`Workspace ID: ${workspace.id}`)
  console.log(`Provider: ${workspace.provider}`)
  console.log(`Workspace directory: ${workspace.rootPath}`)
  console.log(`Allocated ports:`, workspace.ports)

  // 2. Inspect or query active Workspaces
  const inspected = yield* client.getWorkspace({
    projectRoot: process.cwd(),
    name: workspace.name,
  })
  const active = yield* client.listWorkspaces({ projectRoot: process.cwd() })

  // 3. Tear down after task completion
  yield* client.removeWorkspace({
    requestId: "task-42-cleanup",
    projectRoot: process.cwd(),
    name: "feature-billing",
  })
})

Effect.runPromise(program)
```

### Client API

| Method                       | Description                                                       |
| ---------------------------- | ----------------------------------------------------------------- |
| `client.createWorkspace`     | Creates and transactionally provisions a Workspace                |
| `client.getWorkspace`        | Inspects one Workspace, including Provider capabilities and state |
| `client.listWorkspaces`      | Lists persisted Workspaces                                        |
| `client.removeWorkspace`     | Runs teardown and closes the Workspace scope                      |
| `client.reconcileWorkspaces` | Reconciles persisted records with actual Provider state           |
| `client.ping`                | Checks daemon health                                              |
| `client.shutdown`            | Gracefully stops the daemon without deleting completed Workspaces |

The `createWorktree`, `listWorktrees`, and `removeWorktree` methods remain available as backward-compatible aliases. Workspace records are stored atomically in `~/.homestead/state/workspaces.json`; set `HOMESTEAD_STATE_DIR` to choose another state directory.

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
homestead inspect <name>
homestead rm <name> [--force]
```

---

## License

MIT
