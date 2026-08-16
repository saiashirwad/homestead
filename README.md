# homestead

Manage isolated git worktrees with automatic port allocation, environment derivation, and lifecycle hooks.

## Install

```bash
bun add homestead
```

Or install the standalone CLI:

```bash
curl -fsSL https://raw.githubusercontent.com/saiashirwad/homestead/main/scripts/install.sh | bash
```

## Quick Start

Initialize a config in your project:

```bash
homestead init
```

Create, list, and remove workspaces:

```bash
homestead create feature-a
homestead ls
homestead rm feature-a
```

## Configuration

Create a `homestead.config.ts` in your repository root:

```ts
import type { HomesteadConfig } from "homestead"

export default {
  // Allocate conflict-free ports starting from base
  ports: [
    { key: "PORT", base: 3000 },
    { key: "VITE_PORT", base: 5173 },
  ],

  // Generate branch-isolated .env
  env: {
    source: ".env",
    fallback: ".env.example",
    derive: ({ slug }) => ({
      DATABASE_URL: `postgres://localhost:5432/app_${slug}`,
    }),
  },

  // Wait for or start required services
  services: [
    {
      name: "postgres",
      host: "localhost",
      port: 5432,
      start: ["docker", "compose", "up", "-d", "db"],
    },
  ],

  // Hooks
  setup: [
    { label: "install", run: ["bun", "install"] },
    { label: "migrate", run: ["bun", "run", "db:migrate"] },
  ],
  teardown: [
    { label: "drop-db", run: ["bun", "run", "db:drop"] },
  ],
} satisfies HomesteadConfig
```

## Programmatic Usage

Homestead provides a typed client over a local domain socket (`~/.homestead/run/daemon.sock`).

```ts
import { makeClient } from "homestead"
import { Effect } from "effect"

const program = Effect.gen(function* () {
  const client = yield* makeClient()

  // Create workspace
  const workspace = yield* client.createWorkspace({
    projectRoot: process.cwd(),
    name: "feature-billing",
    from: "main",
  })

  console.log(workspace.rootPath, workspace.ports)

  // Clean up
  yield* client.removeWorkspace({
    projectRoot: process.cwd(),
    name: "feature-billing",
  })
})

Effect.runPromise(program)
```

### Client Methods

- `client.createWorkspace(options)` &mdash; create and set up a workspace
- `client.getWorkspace(options)` &mdash; get workspace details and allocated ports
- `client.listWorkspaces(options)` &mdash; list workspaces for a project
- `client.removeWorkspace(options)` &mdash; run teardown and remove workspace
- `client.reconcileWorkspaces(options)` &mdash; reconcile persisted state with git
- `client.ping()` &mdash; check daemon health
- `client.shutdown()` &mdash; stop the background daemon

## CLI

```bash
homestead init             # Generate starter config
homestead create <name>    # Create a workspace (--from <ref>)
homestead ls               # List workspaces
homestead inspect <name>   # Inspect workspace details
homestead rm <name>        # Remove a workspace (--force)

homestead server           # Start daemon
homestead ping             # Ping daemon
homestead shutdown         # Stop daemon
```

## License

MIT
