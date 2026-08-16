# Homestead: An Open Workspace Substrate for Agents and Developers

## Executive Summary

Homestead is an open, programmable workspace control plane. It creates isolated development environments, manages their lifecycle and resources, exposes provider-neutral file and process operations, and returns reviewable changes.

The near-term goal is to build the tooling from which an Orbs experience can be composed. It is **not** to build ROOP integration, agent loops, transcripts, delegation, or an Orb product yet.

The first objective is one reliable local Workspace:

> A developer or generic API client creates an isolated workspace, reads and writes files, starts commands, disconnects and reconnects to their output, inspects the diff, safely syncs changes, and removes the workspace without leaking resources.

A small test driver—not ROOP—proves this contract. Once it works, ROOP and other agents can consume it without Homestead depending on any agent runtime.

---

## 1. Product Vision

Amp's [Orbs](https://ampcode.com/what-are-orbs) demonstrate a useful interaction model: each task gets a fresh environment where an agent can work without occupying the developer's active checkout, expose live services through Portals, and [sync changes](https://ampcode.com/manual/orbs) into a local checkout.

Homestead builds the lower-level workspace substrate that makes that experience possible:

- **Open**: The workspace protocol, Provider contract, and lifecycle engine are inspectable and extensible.
- **Standalone**: Humans, scripts, CI systems, ROOP, and third-party agents can all use Homestead.
- **Local-first**: A Git worktree is the fast path for trusted repositories and ordinary development tasks.
- **Provider-independent**: The same operations can later target a worktree, container, lightweight sandbox, or remote machine.
- **Agent-independent**: Core concepts do not mention models, prompts, transcripts, turns, or delegation.
- **Programmable**: Repository setup is expressed with composable lifecycle primitives rather than a fixed catalog of supported stacks.
- **Effect-native**: Typed errors, scopes, streams, services, and layers model authority and lifecycle explicitly.

Local Workspaces can outlive a CLI or RPC client disconnect while the host and daemon remain running. Surviving host sleep or failure is a future remote Provider capability, not a local guarantee.

ROOP remains a likely first-party consumer, but Homestead earns that integration by first becoming useful and complete without it.

---

## 2. Product Boundary

The canonical language is defined in [`CONTEXT.md`](./CONTEXT.md). The initial Homestead model is:

```text
Project
└── Workspace
    ├── Provider and capabilities
    ├── files and environment
    ├── Command Runs
    ├── Resources and Provision Steps
    ├── Portals
    └── Change Set
```

Homestead owns:

- Workspace creation, discovery, connection, reconciliation, and removal;
- Provider selection and honest capability reporting;
- provider-neutral filesystem operations;
- Command Run lifecycle, input, output, cancellation, and status;
- Resources, Provision Steps, rollback, and cleanup;
- ports, health checks, and Portals;
- diffs, Change Sets, and sync.

An agent runtime owns:

- models, prompts, tools, and skills;
- agent loops and turn policy;
- sessions and transcript history;
- steering and delegation;
- parent-child task relationships;
- agent-specific TUI and web experiences.

An **Orb** is a later product composition that pairs a task or agent thread with one Homestead Workspace. It is not required in the initial Homestead data model, RPC protocol, CLI, or roadmap acceptance tests.

This boundary matters: Homestead provides the execution environment; it does not know why commands are running or interpret them as agent activity.

---

## 3. The Agent-Ready Workspace Contract

The first stable contract has five capability groups:

| Capability   | Required operations                                             |
| ------------ | --------------------------------------------------------------- |
| Lifecycle    | create, get, list, connect, remove, reconcile                   |
| Files        | read, write, stat, list directory, create directory, remove     |
| Commands     | start, inspect, list, stream/replay output, write input, cancel |
| Changes      | status, structured diff, capture Change Set, sync               |
| Capabilities | report filesystem, network, Portal, and durability guarantees   |

The protocol must not require a meaningful host path. A local Provider may expose one as optional metadata, but clients must be able to operate a Workspace through its handle and versioned protocol alone.

The command protocol emits structured events for stdout, stderr, exit, cancellation, and failures. Each Command Run has a stable identity. The daemon owns its process and bounded output history so a client can disconnect, reconnect, replay missed events, and continue following live output.

The first release does not claim that an active Command Run survives a daemon crash. On restart, a run whose state cannot be recovered is marked interrupted; the Workspace itself remains inspectable, syncable, and removable.

### Target CLI

The CLI should converge on an agent-neutral experience:

```bash
# Workspace lifecycle
homestead create feature-auth
homestead ls
homestead inspect feature-auth

# Interactive and detached commands
homestead shell feature-auth
homestead exec feature-auth -- pnpm test
homestead exec --detach feature-auth -- pnpm dev
homestead ps feature-auth
homestead logs --follow feature-auth <run>
homestead cancel feature-auth <run>

# Review and delivery
homestead diff feature-auth
homestead sync feature-auth
homestead portals feature-auth
homestead rm feature-auth
```

The exact spelling can follow the existing CLI conventions; the capability set is the contract.

### Sync semantics

`sync` is explicit, repeatable, and non-destructive:

1. Capture the Workspace's current Change Set relative to its recorded base revision.
2. Refuse to overwrite unrelated uncommitted local changes.
3. Use a three-way operation when the local checkout has advanced.
4. Report conflicts without destroying either side's state.
5. Leave the Workspace running so later changes can be synced again.

Creating a commit or pull request is an optional delivery policy built on Change Sets, not part of sync itself.

---

## 4. Architecture

### 4.1 Provider contract

A Provider owns external filesystem, process, network, and lifecycle authority, so it is an Effect service. The current Git worktree implementation becomes the first Provider rather than the permanent definition of a Workspace.

```ts
interface ProviderCapabilities {
  readonly filesystemIsolation: "rooted" | "container" | "vm"
  readonly networkIsolation: "host" | "filtered" | "isolated"
  readonly survivesHostDisconnect: boolean
  readonly supportsPortals: boolean
}
```

- A worktree isolates Git state and port allocation but is not a security sandbox.
- A container Provider is the future baseline for code that should not receive ambient host access.
- A remote Provider adds host independence and elastic capacity.
- Provider implementations pass the same behavioral conformance suite.

The contract should be generalized only as a second Provider proves where the worktree assumptions leak.

### 4.2 Authority services and values

The initial Effect authority seams are:

- **`WorkspaceProvider`**: creates, connects to, operates, and destroys Provider Workspaces.
- **`WorkspaceRegistry`**: owns Workspace identity, persisted metadata, lifecycle state, active scopes, and recovery.
- **`CommandRuntime`**: owns daemon-side Command Run processes, event streams, output replay, and cancellation.
- **`SyncEngine`**: computes and safely applies Change Sets.

Later capabilities may earn additional services:

- **`ResourceRuntime`**: acquires and releases Resource graphs within a Workspace scope.
- **`PortalRouter`**: discovers and routes Workspace HTTP services.

These are services because they own external authority, state, or lifecycle policy with real production variation. Deleting one would spread that authority into RPC handlers and CLI callers.

Configuration and per-operation data remain ordinary values:

- `ProjectSpec`
- `WorkspaceRequest`
- `CommandSpec`
- `CommandRun`
- `ResourceSpec<A>`
- `ProvisionStep`
- `ResourceRef<A>`
- `ChangeSet`

They are not services because they carry descriptions or results rather than owning authority. RPC handlers adapt the wire protocol to these application operations; they do not contain lifecycle policy.

### 4.3 Scoped lifecycle and persisted recovery

Each active Workspace owns a child `Scope` retained by `WorkspaceRegistry`, not the temporary scope of the RPC that created it.

- Successful acquisitions register finalizers in dependency-safe order.
- Provision failure or cancellation closes the Workspace scope and rolls back everything already acquired.
- Explicit removal cancels Command Runs and closes the scope before removing the Provider Workspace.
- The daemon persists enough metadata to rediscover and reconcile Workspaces after restart.

Effect scopes provide deterministic cleanup while the daemon is alive. They cannot run after a crash, so cleanup claims must be backed by a persisted resource manifest and idempotent reconciliation.

Effect Workflow or Cluster is deferred until a remote Provider introduces concrete durable scheduling requirements.

### 4.4 Transport and protocol

Unix sockets remain the local transport. The versioned Workspace protocol owns domain operations; local paths and Bun process handles stay inside adapters.

HTTP or WebSocket transport is added only when a remote or browser client requires it. Transport choice must not change Workspace semantics.

The protocol should be proven by:

1. the Homestead CLI;
2. an end-to-end generic test driver using only public operations;
3. the worktree Provider conformance suite.

An agent adapter is deliberately not one of the initial proofs.

---

## 5. Composable Workspace Resources

Homestead core provides lifecycle primitives, not stack-specific knowledge of Postgres, Redis, Vite, Bun, or any other tool.

### Resources and Provision Steps are different

- A **Resource** is acquired, remains available, produces a typed value, and must be released.
- A **Provision Step** runs once after its dependencies are ready and does not remain alive.

Examples:

- a supervised dev server is a Resource;
- a temporary database is a Resource;
- package installation is a Provision Step;
- a database migration is a Provision Step.

The resource graph must support:

- stable typed keys and `ResourceRef<A>` outputs;
- explicit dependencies and cycle detection;
- deterministic acquisition and rollback order;
- safe parallel acquisition of independent nodes;
- typed errors that preserve the failing node;
- environment and Portal values derived from acquired outputs;
- a serializable manifest sufficient for reconciliation.

The public API should be frozen only after generic command, port, health-check, and supervised-process primitives prove it. Stack-specific recipes live outside core and require no privileged extension mechanism.

The current `ports`, `env`, `services`, `setup`, and `teardown` configuration remains supported during migration and can compile into the same internal lifecycle plan.

---

## 6. Delivery Roadmap

The active roadmap builds Homestead itself. Each phase ends in a standalone capability and an executable acceptance test.

### Phase 0: Reliable Local Workspace Kernel

- [x] Introduce `WorkspaceProvider` around the current Git worktree implementation.
- [x] Add a Provider conformance suite for create, connect, inspect, and remove.
- [x] Persist Workspace identity, Project, base revision, lifecycle state, ports, and Provider metadata.
- [x] Give each active Workspace a registry-owned child Scope.
- [x] Roll back partial provisioning on failure and cancellation.
- [x] Reconcile existing Workspaces after daemon restart.
- [x] Expose Workspace terminology while retaining backward compatibility for the current worktree CLI and RPC.

**Exit criterion:** Concurrent local Workspaces do not collide; setup failure leaves no unmanaged worktree or reservation; a restarted daemon can list, inspect, and remove every existing Workspace.

### Phase 1: Provider-Neutral Files and Commands

- [ ] Expose scoped filesystem operations without requiring a host path.
- [ ] Add streaming command start, inspect, list, input, cancellation, and event RPCs.
- [ ] Give every Command Run a stable identity and bounded output replay.
- [ ] Keep Command Runs alive across client disconnects while the daemon is running.
- [ ] Mark unrecoverable active runs interrupted during daemon reconciliation.
- [ ] Implement `shell`, `exec`, `ps`, `logs`, and `cancel` in the CLI.

**Exit criterion:** A generic test client can edit files, start a detached command, disconnect, reconnect, replay its output exactly once, observe its exit, and cancel a second command—all through the public protocol.

### Phase 2: Change Sets and Safe Sync — First Substrate Release

- [ ] Add structured status and diff operations.
- [ ] Record the base revision needed to capture a repeatable Change Set.
- [ ] Implement non-destructive sync with dirty-check and three-way conflict handling.
- [ ] Keep the Workspace alive after sync.
- [ ] Test repeated sync and local-checkout divergence.

**Exit criterion:** A script can create a Workspace, modify and test a repository, inspect its Change Set, safely sync it into a local checkout, and remove the Workspace without any agent-specific dependency.

### Phase 3: Resource and Provision Graph

- [ ] Define typed Resources, Provision Steps, references, and dependency validation.
- [ ] Implement generic command, port, environment, health-check, and supervised-process primitives.
- [ ] Persist reconciliation metadata for acquired Resources.
- [ ] Adapt the existing flat configuration into the internal graph.
- [ ] Build one stack-specific recipe outside core to prove extensibility.

**Exit criterion:** An external recipe can acquire a multi-step environment, export typed outputs, and roll back correctly at every induced failure point without modifying Homestead core.

### Phase 4: Portals and Autonomous Verification Primitives

- [ ] Supervise declared HTTP services with sticky dynamic ports and health checks.
- [ ] Implement local Portal discovery and routing.
- [ ] Expose Portal handles through the public protocol without hard-coded hostnames.
- [ ] Make Portal metadata consumable by humans, scripts, browser tools, and future agents alike.

**Exit criterion:** A generic client can start an application, discover a stable preview URL, verify it with an ordinary HTTP/browser client, and clean up every service on removal.

### Phase 5: Container Provider

- [ ] Implement one Docker-compatible Provider behind the Workspace contract.
- [ ] Pass the Provider conformance suite without changing public clients.
- [ ] Enforce and report stronger filesystem and network capabilities than the worktree Provider.
- [ ] Evaluate lighter runtimes only through the same contract.

**Exit criterion:** Selecting a container instead of a worktree is a configuration/composition change, and the same lifecycle, files, commands, changes, and Portal tests pass.

### Phase 6: First Agent Consumer Validation

Only after the standalone substrate is stable:

- [ ] Implement a thin adapter from one agent runtime's existing execution abstraction to the Homestead protocol.
- [ ] Keep the adapter outside Homestead core.
- [ ] Use it to identify missing generic capabilities rather than adding agent concepts to Homestead.
- [ ] Validate ROOP as one consumer without making it the definition of the protocol.

**Exit criterion:** An agent can use Homestead entirely through the same public capabilities already proven by the CLI and generic test client. Homestead contains no agent loop, transcript, or ROOP-specific lifecycle policy.

### Phase 7: Remote Providers and Higher-Level Orbs

- [ ] Implement one concrete remote Provider before generalizing across vendors.
- [ ] Add secure checkout, secrets, authenticated Portals, and host-independent reconnect semantics.
- [ ] Evaluate Effect Workflow and Cluster against concrete scheduling and recovery requirements.
- [ ] Compose task records, agent sessions, Child Orbs, schedules, and webhooks in a higher-level product boundary.

**Exit criterion:** A higher-level runtime can compose durable Orbs from Homestead Workspaces without changing Homestead's core domain.

---

## 7. Immediate Build Slice

**Status: complete.** Phase 0 was implemented without an adapter or any ROOP changes:

1. Define the smallest Provider-neutral Workspace handle and capability record.
2. Wrap the current Git worktree lifecycle in `WorkspaceProvider` without rewriting it.
3. Add persisted `WorkspaceRegistry` records and registry-owned scopes.
4. Make creation transactional: failure closes the scope, releases ports, and removes the partial worktree.
5. Reconcile records against real Git worktrees after daemon restart.
6. Prove the behavior with the existing RPC end-to-end tests plus Provider conformance tests.

**Done means:** create, list, inspect, restart, and remove work through Workspace operations; induced failure leaves nothing behind; no code in ROOP changes.

Phase 1 then adds the file and command protocol that an eventual agent adapter will consume.

---

## 8. First-Release Non-Goals

The first substrate release deliberately excludes:

- any ROOP package, `ExecutionWorld` adapter, or Effect-version alignment with ROOP;
- agent loops, model calls, prompts, tools, skills, or transcripts;
- Orb and Child Orb records;
- automatically resuming an interrupted command after a daemon crash;
- remote execution or surviving host sleep;
- running untrusted code safely in the local worktree Provider;
- built-in Postgres, Redis, Vite, or package-manager integrations in core;
- schedules, webhooks, multiplayer collaboration, or a new dashboard;
- a Homestead/ROOP monorepo or package rename.

These exclusions protect the central proof: Homestead is independently useful infrastructure with a complete public contract that future agent runtimes can adopt.

---

## 9. Decision Rules

When implementation choices are unclear:

1. Prefer completing the standalone Workspace contract over demonstrating an agent integration.
2. Keep agent concepts out of Homestead core.
3. Put external authority behind Effect services; keep configuration and request data as values.
4. State Provider security and durability capabilities honestly.
5. Require persisted reconciliation for cleanup guarantees that must survive process failure.
6. Add a core primitive only when an external recipe cannot express the need safely.
7. Preserve backward compatibility while migrating from worktree-specific names.
8. Prove a second Provider before generalizing the Provider contract further.
