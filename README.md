# homestead

Deterministic git worktree isolation with dynamic port allocation, derived environments, and an Effect RPC control plane.

```bash
homestead create my-feature
```

A branch, isolated with its own conflict-free ports, derived `.env`, and dependencies provisioned in one command.

---

## Core Capabilities

- **Port Allocation**: Scans sibling worktrees and local TCP listeners to allocate conflict-free ports deterministically.
- **Environment Derivation**: Copies or templates `.env`, computing branch/slug specific overrides (e.g. per-worktree databases).
- **Setup & Teardown**: Runs lifecycle commands (`bun install`, migrations) in the isolated worktree directory.
- **Effect RPC Control Plane**: Unix Domain Socket daemon with namespaced RPCs (`v1/worktree/create`, `v1/worktree/list`, `v1/worktree/remove`) and in-memory idempotency.

---

## CLI Usage

```bash
# Initialize homestead in a repository
homestead init

# Create an isolated worktree (allocates ports, derives .env, runs setup)
homestead create feature-auth --from main

# List active worktrees, branches, ports, and paths
homestead ls

# Remove a worktree and clean up its branch & resources
homestead rm feature-auth

# Run the background RPC daemon over Unix Domain Socket
homestead server

# Ping the daemon
homestead ping

# Stop the daemon
homestead shutdown
```

---

## Configuration (`homestead.config.ts`)

```ts
import type { HomesteadConfig } from "homestead";

export default {
  // Ports to dynamically allocate starting from a base
  ports: [
    { key: "PORT", base: 3000 },
    { key: "CLIENT_PORT", base: 5173 },
  ],

  // Environment file derivation
  env: {
    source: ".env",
    fallback: ".env.example",
    derive: ({ slug }) => ({
      DATABASE_URL: `postgres://localhost:5432/myapp_${slug}`,
    }),
  },

  // Setup commands executed in the worktree root
  setup: [
    { label: "install", run: ["bun", "install"] },
  ],

  // Teardown commands executed before removing the worktree
  teardown: [
    { label: "db:drop", run: ["bun", "run", "db:drop"] },
  ],
} satisfies HomesteadConfig;
```

---

## Integrating with Frontends & AI Agents

Because Homestead exposes its control plane over typed Effect RPC (`@effect/rpc`) via Unix Domain Sockets:
- **Agents & Orchestrators** can provision and tear down environments programmatically with `HomesteadClient`.
- **Dashboards & TUIs** can connect directly to `~/.homestead/run/daemon.sock` to inspect or control live worktrees.
- **Terminal Multiplexers** (tmux, Zellij, Ghostty, Herdr) can be composed on top by wrapping `homestead create`.

---

## Requirements

- [Bun](https://bun.sh) (>= 1.0.0)
- Git (>= 2.20)
