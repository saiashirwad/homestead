Homestead: An Open, Effect-Native Workspace and Orb Substrate

## Executive Summary

Homestead is an open control plane and Effect SDK for creating, operating, and composing isolated coding Workspaces.

The repository should deliberately contain two layers:

1. **Workspace Kernel** — an agent-neutral substrate for source materialization, execution, files, processes, lifecycle, endpoints, changes, artifacts, and reconciliation.
2. **Orb Runtime** — a first-party reference composition, built outside the kernel, that pairs a task and an agent driver with a Workspace.

The kernel must not contain model calls, prompting policy, transcript storage, or agent-loop logic. However, an Orb consumer must be used early enough to shape the public contract. Deferring every agent-backed acceptance test until the end risks building a clean remote-shell API rather than a useful Orb substrate.

The first meaningful proof is:

> The same serializable Workspace Blueprint runs unchanged on a local worktree backend and a container backend. A generic client and a reference agent driver can edit files, start a detached command, disconnect and reconnect without killing it, expose a service through an Endpoint, attach review evidence, capture an immutable Change Set, safely apply it to a target checkout, and remove the Workspace. A daemon crash at any tested lifecycle boundary converges without leaking owned resources or deleting resources it does not own.

The north-star extension story is:

> A library author can publish a backend, component driver, recipe, policy, or agent adapter as an ordinary package. An application composes those packages with Effect Layers. Trusted authoring code compiles to versioned, serializable data. The controller persists and reconciles that data without requiring changes to Homestead core.

Homestead is pre-1.0. Architectural correctness takes priority over compatibility with the current worktree-shaped API.

---

## 1. Product Thesis

An Orb-like product is not merely a remote machine with an RPC shell. It is a durable task environment with:

- an explicit source and base revision;
- an independently managed execution allocation;
- long-running commands and supervised services;
- reconnectable terminals and event streams;
- safe review and delivery of changes;
- stable endpoints for inspecting running software;
- secrets and workload identity with explicit authority;
- evidence such as logs, test reports, screenshots, and videos;
- lifecycle policy such as suspend, resume, expiration, and cleanup;
- an optional task, agent session, trigger, or parent-child relationship layered above the Workspace.

Homestead should make those behaviors composable rather than hard-code one hosted product's choices.

### 1.1 What Homestead owns

The Workspace Kernel owns:

- Project and Workspace identity;
- Source specifications and source materialization;
- desired and observed Workspace state;
- backend allocation, connection, suspension, resumption, and removal;
- capability discovery and honest guarantees;
- root-relative filesystem operations;
- Command Runs and Terminal Sessions;
- a versioned Blueprint and Component reconciliation engine;
- supervised processes, health checks, ports, and Endpoints;
- secret references and identity capabilities;
- immutable Change Sets and safe application/sync workflows;
- Artifacts and Review Bundles;
- durable Operations, Events, idempotency records, and audit metadata;
- transport-neutral protocol schemas and conformance suites.

The first-party Orb Runtime owns:

- a task record paired with a Workspace;
- an Agent Driver abstraction;
- agent-run lifecycle and steering adapters;
- optional parent-child Orb relationships;
- triggers, schedules, and webhook adapters when they are implemented;
- Orb-specific expiration and wake policy.

An Agent Driver implementation owns:

- models and provider credentials;
- prompts, tools, skills, and context policy;
- the model/agent loop;
- transcript representation and retention;
- agent-specific UI.

A Workspace never needs to know that an agent exists. An Orb does know that a Workspace exists.

### 1.2 Product boundary rule

Keep agent concepts out of `@homestead/core`, but do not keep agent validation out of the roadmap.

The public Workspace contract is not considered stable until it has passed all three of these consumers:

1. the Homestead CLI;
2. a generic non-agent integration client;
3. a thin reference Agent Driver using only the public protocol.

---

## 2. Design Principles

### 2.1 Typed at authoring time, serializable at runtime

TypeScript and Effect are the authoring and implementation model. The durable plan is data.

Trusted `homestead.config.ts` code may use generics, Effect, functions, and Layers to build a Blueprint. Before it crosses a process boundary or is persisted, it compiles into a versioned serializable graph with explicit references and schemas.

Do not persist closures. Do not make a remote daemon import arbitrary client code to understand desired state.

### 2.2 Capabilities, not a mega-provider

A backend allocates an execution domain and supplies scoped capability implementations. It does not become one indefinitely growing interface containing files, exec, Git, networking, secrets, portals, snapshots, and every future operation.

The controller talks to granular capability services such as Files, Processes, Terminals, Network, Snapshots, Suspend/Resume, and Identity. A backend advertises which versions and guarantees it provides.

### 2.3 One component graph, multiple lifecycle semantics

A temporary database and a one-time migration have different lifecycle behavior, but they do not need separate graph engines.

Use one `Component` node model with driver-defined reconciliation semantics. Standard drivers may represent:

- convergent managed resources;
- one-shot actions that rerun when their input generation changes;
- continuously supervised processes;
- observation-only checks;
- exported values such as ports, URLs, paths, and credentials.

“Resource” and “Provision Step” remain useful descriptions, not separate orchestration architectures.

### 2.4 Desired state is the source of truth

Persist desired specifications, observed state, external ownership, operation intent, and component status. Reconcile until observed state matches desired state.

Effect `Scope` is used for deterministic in-process lifetime management. It is not the durable cleanup mechanism and must never be the sole record that a resource exists.

### 2.5 Logical Workspace identity is separate from physical allocation

A Workspace is a durable logical object. An Allocation is the worktree, container, VM, or remote environment currently realizing it.

This separation allows:

- suspend and resume;
- allocation replacement after failure;
- provider migration;
- scale-to-zero;
- stable Workspace, Command, Endpoint, Artifact, and Change Set identities across backend lifecycle changes where the relevant capability supports it.

### 2.6 Stable IDs are canonical; names and paths are metadata

Every public operation is addressed by stable IDs. Names are human-friendly labels and may be non-unique outside an explicit scope. Host paths are optional backend metadata.

The protocol must not require `projectRoot + name` to identify a Workspace.

### 2.7 Protocol semantics are independent of transport and framework internals

Effect Schema may define the canonical data model, and the first-party TypeScript SDK should expose `Effect` and `Stream`. Bun sockets, Node sockets, `effect/unstable/rpc`, HTTP, WebSocket, or another transport are adapters.

No transport-specific handle or unstable RPC implementation type appears in the durable domain model.

### 2.8 Event delivery is replayable, not magically exactly-once

Every replayable stream has a stable stream identity and monotonically increasing sequence. Delivery may be at least once. Clients resume after a cursor and deduplicate by sequence.

Do not claim “exactly once” across reconnects. State the truncation and retention behavior explicitly.

### 2.9 Authority and ownership are explicit

Every backend and component driver declares the authority it needs. Every external object records whether Homestead created it, adopted it, or merely references it.

Deletion must be ownership-aware. Homestead never deletes a pre-existing Git branch, container, database, secret, or tunnel merely because a Workspace referenced it.

### 2.10 Evidence is a first-class result

Code changes alone are not the complete output of an autonomous coding environment. Logs, test reports, screenshots, videos, benchmark output, and live Endpoints materially improve review.

Artifacts and Review Bundles are agent-neutral kernel concepts.

### 2.11 Break the wrong API before 1.0

Do not retain worktree aliases, path-shaped identity, or a singleton provider abstraction solely for compatibility. Provide a migration path for persisted state and configuration, but prefer a clean v0.4 API over preserving v0.3's public surface.

---

## 3. Canonical Domain Model

```text
Project
├── ProjectId
├── SourceSpec
├── default Blueprint reference
└── policy defaults

Workspace
├── WorkspaceId
├── ProjectId
├── WorkspaceSpec                 desired state
├── WorkspaceStatus               observed state and conditions
├── Allocation                    physical backend realization
├── compiled Blueprint
│   └── Component Nodes
├── Command Runs
├── Terminal Sessions
├── Endpoints
├── Artifacts / Review Bundles
├── Change Sets / Sync Records
└── Operations / Events

Orb                              outside the Workspace Kernel
├── OrbId
├── Task
├── WorkspaceId
├── Agent Driver / Agent Run
├── optional parent OrbId
└── trigger and lifetime policy
```

### 3.1 Project

A durable source identity plus defaults used to create Workspaces.

A Project is not synonymous with a local directory. Its `SourceSpec` may be:

- a registered local Git checkout;
- a Git remote and revision policy;
- a local snapshot uploaded by a client;
- an archive or future source driver.

A local path may be stored by a local Project adapter, but it is not the cross-provider identity.

### 3.2 Workspace

A logical, independently managed coding environment created from a Project or explicit SourceSpec.

A Workspace has:

- a stable `WorkspaceId`;
- a desired `WorkspaceSpec` with a monotonically increasing generation;
- an observed `WorkspaceStatus` with `observedGeneration` and conditions;
- zero or one active Allocation initially;
- a compiled Blueprint;
- child entities with their own stable IDs.

A Workspace display name is not a Git branch name.

### 3.3 Allocation

The backend-owned physical realization of a Workspace: a worktree plus host process namespace, a container, a VM, or a remote machine.

An Allocation records:

- `AllocationId`;
- backend kind and backend API version;
- opaque, schema-versioned backend state;
- ownership metadata;
- observed power/lifecycle state;
- capability descriptors;
- creation and last-observed timestamps.

### 3.4 Blueprint

A versioned, serializable DAG of Component nodes and typed value references.

The authoring SDK may be highly typed and ergonomic. The compiled Blueprint must contain only data understood through registered component kinds and schemas.

### 3.5 Component

The smallest independently reconciled lifecycle unit.

Each Component node contains:

- a stable node ID within the Blueprint;
- a namespaced component kind;
- component API version;
- serializable input expressions;
- explicit dependencies;
- retry/timeout policy where applicable;
- optional replacement and deletion policy.

Each observed Component record contains:

- input/spec hash;
- driver state schema version;
- opaque driver state;
- typed outputs encoded against the driver's output schema;
- status and conditions;
- ownership metadata;
- last successful and failed operation IDs.

### 3.6 Operation

A durable representation of a requested mutation or long-running action.

Examples include Workspace creation, Blueprint update, removal, Component reconciliation, Change Set application, and suspend/resume.

Operations have stable IDs, status, progress/events, cancellation state, idempotency metadata, and terminal result or typed error.

### 3.7 Event

An immutable, ordered event envelope:

```ts
interface EventEnvelope<A> {
  readonly streamId: string
  readonly sequence: number
  readonly occurredAt: number
  readonly type: string
  readonly payload: A
}
```

Workspace, Operation, Command, Terminal, Component, and Orb streams use the same cursor model.

### 3.8 Command Run

One non-interactive process invocation with stable identity, status, input policy, output stream, and cancellation semantics.

A Command Run may outlive the client that started it. It does not initially survive a daemon crash; unrecoverable active runs become `interrupted`.

### 3.9 Terminal Session

A PTY-backed interactive session with stable identity, attach/detach, resize, input, output cursors, and explicit ownership policy.

Do not force interactive terminal semantics into the ordinary Command Run API.

### 3.10 Endpoint

A managed address through which a service in a Workspace can be reached.

An Endpoint describes protocol, target, exposure driver, access policy, health, URL/address, and lifecycle. “Portal” may remain a CLI or Orb UI term for an HTTP Endpoint intended for review.

### 3.11 Change Set

An immutable, content-addressed snapshot of source changes relative to an explicit base source identity.

A Change Set is not merely a string containing `git diff` output.

### 3.12 Artifact and Review Bundle

An Artifact is content plus media type, digest, provenance, labels, and retention metadata.

A Review Bundle references a Change Set, relevant Command Runs, Artifacts, Endpoints, and a summary. It does not require an agent to exist.

---

## 4. Effect-Native Architecture

### 4.1 Recommended package boundaries

Use one repository with multiple packages and one user-facing CLI binary:

```text
packages/
  core/                    IDs, domain schemas, errors, pure values
  protocol/                versioned operations and wire schemas
  sdk/                     Effect client and Blueprint authoring DSL
  controller/              reconciler, operations, commands, changes
  daemon/                  local server and production Layer composition
  components-standard/     file, command, process, health, port, endpoint primitives
  backend-worktree/        trusted local worktree + host capabilities
  backend-container/       Docker/Podman backend
  orb/                     reference Orb runtime and AgentDriver contract
  adapter-mcp/             lossy MCP tool facade
  adapter-roop/            ROOP integration
```

A separate state package may be extracted when there is a second implementation. Until then, keep the `StateStore` interface in the controller and its SQLite implementation in the daemon package.

The public root package may re-export stable SDK entry points, but backend, daemon, and adapter dependencies must not leak into `core` or `protocol`.

### 4.2 Backend contract

Replace the singleton, all-purpose `WorkspaceProvider` with a registry of backend implementations selected per Workspace.

Illustrative shape:

```ts
interface WorkspaceBackend {
  readonly kind: string
  readonly apiVersion: number

  readonly describe: Effect.Effect<BackendDescriptor, BackendError>

  readonly allocate: (request: AllocateRequest) => Effect.Effect<AllocationRecord, BackendError>

  readonly observe: (
    allocation: AllocationRecord,
  ) => Effect.Effect<AllocationObservation, BackendError>

  readonly connect: (
    allocation: AllocationRecord,
  ) => Effect.Effect<WorkspaceConnection, BackendError, Scope.Scope>

  readonly suspend?: (allocation: AllocationRecord) => Effect.Effect<AllocationRecord, BackendError>

  readonly resume?: (allocation: AllocationRecord) => Effect.Effect<AllocationRecord, BackendError>

  readonly destroy: (allocation: AllocationRecord) => Effect.Effect<void, BackendError>

  readonly discoverOwned: (
    controllerId: string,
  ) => Effect.Effect<ReadonlyArray<DiscoveredAllocation>, BackendError>
}
```

`connect` constructs a scoped Layer or capability bundle for that Allocation. The controller consumes only the capabilities that a given operation requires.

A worktree backend composes:

- rooted host Files;
- host Processes and Terminals with an enforced working root;
- host networking;
- Git worktree source ownership metadata.

A container backend composes:

- container Files;
- container Processes and Terminals;
- container networking;
- optional bind-mounted or cloned source.

A future remote backend may implement the same capabilities through a remote agent without changing controller semantics.

### 4.3 Capability model

Capabilities are open, namespaced, and versioned:

```ts
interface CapabilityDescriptor {
  readonly id: string // e.g. "homestead.files"
  readonly apiVersion: number
  readonly guarantees: Readonly<Record<string, unknown>>
  readonly limits: Readonly<Record<string, unknown>>
}
```

Initial capability services:

- `WorkspaceFiles`;
- `WorkspaceProcesses`;
- `WorkspaceTerminals`;
- `WorkspaceNetwork`;
- `WorkspaceSnapshots`;
- `WorkspacePower`;
- `WorkspaceIdentity`;
- optionally backend-optimized `WorkspaceChanges`.

Security and durability facts should be structured descriptors, not a closed pair of enums plus booleans. Examples include:

- filesystem boundary and symlink policy;
- host-device access;
- process namespace isolation;
- network ingress/egress policy;
- whether an allocation survives daemon loss, host loss, or suspension;
- whether commands survive client disconnect, daemon restart, or allocation suspension;
- maximum output retention and file sizes;
- endpoint exposure modes.

`supportsPortals: boolean` is too coarse to be useful.

### 4.4 Backend and component registries

Effect Layers install implementations into registries:

```ts
const HomesteadLive = Layer.mergeAll(
  WorktreeBackend.layer,
  ContainerBackend.layer,
  StandardComponents.layer,
  LocalEndpointPublisher.layer,
  ProjectSecretResolver.layer,
)
```

Registries reject duplicate `(kind, apiVersion)` registrations. A Workspace record persists the selected implementation kind and version so upgrades are explicit and migratable.

### 4.5 Blueprint authoring and compilation

Illustrative authoring API:

```ts
const webPort = Standard.port.reserve({ key: "web" })

const web = Standard.process.supervised({
  command: ["pnpm", "dev"],
  env: {
    PORT: webPort.output("port"),
  },
  ready: Standard.health.tcp({
    port: webPort.output("port"),
  }),
})

const preview = Standard.endpoint.http({
  target: web.output("address"),
  exposure: { driver: "homestead.local-proxy", access: "authenticated" },
})

export default Blueprint.make({
  nodes: [webPort, web, preview],
})
```

The compiler emits data similar to:

```json
{
  "schemaVersion": 1,
  "nodes": [
    {
      "id": "web-port",
      "kind": "homestead.port.reserve",
      "apiVersion": 1,
      "input": { "key": "web" },
      "dependsOn": []
    },
    {
      "id": "web",
      "kind": "homestead.process.supervised",
      "apiVersion": 1,
      "input": {
        "command": ["pnpm", "dev"],
        "env": {
          "PORT": { "$ref": { "node": "web-port", "path": ["port"] } }
        }
      },
      "dependsOn": ["web-port"]
    }
  ]
}
```

The expression model should initially support:

- literals;
- node output references;
- object and array composition;
- string templates;
- Project/Workspace metadata references;
- secret references;
- optional values and defaults.

Generic `ResourceRef<A>` values exist in the authoring SDK only. They compile to serializable output references and are revalidated against the registered output Schema at runtime.

### 4.6 Component driver contract

Illustrative shape:

```ts
interface ComponentDriver<I, O, S> {
  readonly kind: string
  readonly apiVersion: number
  readonly inputSchema: Schema.Schema<I>
  readonly outputSchema: Schema.Schema<O>
  readonly stateSchema: Schema.Schema<S>
  readonly authority: ReadonlyArray<AuthorityRequirement>

  readonly reconcile: (
    context: ReconcileContext,
    input: I,
    previous: Option.Option<S>,
  ) => Effect.Effect<ReconcileResult<O, S>, ComponentError>

  readonly destroy: (context: ReconcileContext, state: S) => Effect.Effect<void, ComponentError>
}
```

Driver requirements:

- idempotent reconciliation;
- deterministic external labels or discoverability;
- explicit ownership/adoption behavior;
- versioned persisted state;
- typed outputs;
- safe repeated destroy;
- bounded, classified retry policy;
- no hidden dependency on a host path;
- conformance tests including interruption between side effect and state commit.

Recipes are ordinary libraries that compose existing Component kinds. Recipes require no daemon privilege. New Component kinds are trusted runtime plugins and do require registration plus declared authority.

This distinction is essential: “recipes need no extension mechanism” is true; “all extensibility can be recipes” is not.

### 4.7 Reconciliation and durable state

Replace the JSON Workspace registry with a transactional `StateStore` service. Use SQLite as the local default and a content-addressed Blob Store for large logs, Change Set blobs, and Artifacts.

Persist at least:

- Projects and SourceSpecs;
- Workspace specs, generations, status, and deletion tombstones;
- Allocations and ownership metadata;
- compiled Blueprints;
- per-Component desired input hash, state, outputs, and conditions;
- Operations and durable idempotency records;
- ordered Events and stream cursors;
- Command/Terminal metadata and retained output chunk references;
- Endpoints;
- Change Sets and application records;
- Artifacts and Review Bundles;
- schema migrations.

Controller behavior:

1. Persist desired intent before beginning side effects.
2. Acquire a per-Workspace reconciliation lease or lock.
3. Observe backend and Component state.
4. Reconcile nodes in dependency order with bounded parallelism.
5. Persist each observed transition and event transactionally.
6. Retry classified transient failures.
7. Preserve terminal failure details and permit an explicit retry.
8. On deletion, retain a tombstone until every owned external object is confirmed gone.
9. Never infer ownership from a name alone.

Effect Scopes are scoped to active connections, reconciliation passes, and live process handles. The persisted controller state remains authoritative across daemon restarts.

### 4.8 Workspace status

Avoid a single three-value lifecycle enum as the complete status model.

Use a simple phase plus conditions:

```ts
interface WorkspaceStatus {
  readonly phase:
    "pending" | "reconciling" | "ready" | "degraded" | "suspended" | "deleting" | "failed"
  readonly observedGeneration: number
  readonly allocationId?: string
  readonly conditions: ReadonlyArray<Condition>
}
```

Conditions should explain allocation readiness, Blueprint readiness, source readiness, endpoint health, interrupted commands, cleanup failures, and unsupported requested capabilities without creating a combinatorial phase enum.

### 4.9 Operations and idempotency

Workspace mutations return an `Operation` immediately or expose an API that can synchronously await it as a convenience.

Idempotency records are durable and keyed by at least:

- authenticated principal or client ID;
- request ID;
- operation kind;
- canonical payload hash.

A replay returns the original Operation/result. Reusing a key for a different payload returns a typed conflict. Records survive daemon restart for a documented retention period.

---

## 5. Public Protocol

### 5.1 Canonical schema layer

`@homestead/protocol` contains pure, versioned request, response, error, and event Schemas. It must not import Bun platform services, daemon implementations, child-process handles, or backend packages.

The TypeScript SDK adapts protocol operations to Effect services and Streams. Additional SDKs can be generated or implemented later without redefining domain semantics.

The local daemon may initially use Effect RPC over a Unix socket, but `effect/unstable/rpc` is an implementation adapter rather than the public architectural contract.

### 5.2 Protocol discovery

Add `system.describe` before expanding the API. It reports:

- protocol versions;
- server version and controller identity;
- installed backend kinds and versions;
- installed Component kinds and versions;
- transport features;
- default retention limits;
- optional capabilities.

Clients negotiate features instead of guessing from a package version.

### 5.3 Identity

Canonical operations take IDs:

- `ProjectId`;
- `WorkspaceId`;
- `OperationId`;
- `CommandRunId`;
- `TerminalSessionId`;
- `EndpointId`;
- `ChangeSetId`;
- `ArtifactId`;
- `OrbId` outside the kernel.

Name-based lookup is a CLI convenience and may return ambiguity. `rootPath` is optional metadata and never required for remote operation.

### 5.4 Initial operation groups

```text
system
  describe

projects
  create | get | list | update | remove

workspaces
  create | get | list | update | remove
  reconcile | suspend | resume
  watchEvents

operations
  get | list | cancel | watchEvents

files
  stat | list | read | write | mkdir | rename | remove

commands
  start | get | list | watchOutput | writeInput | signal | cancel

terminals
  create | get | list | attach | writeInput | resize | close

changes
  status | capture | get | export | apply

endpoints
  get | list | watch

artifacts
  create | get | list | download

reviewBundles
  create | get | list
```

Not every backend must implement every optional operation. Required capabilities are checked against `WorkspaceSpec` before allocation or reconciliation.

### 5.5 Files

Filesystem operations are binary-safe and root-relative.

Required semantics:

- reject traversal outside the Workspace root;
- define symlink escape behavior explicitly;
- support byte streams or ranges for large files;
- atomic writes where the backend can provide them;
- optional digest/version preconditions to prevent accidental concurrent overwrite;
- structured file kind, mode, size, timestamps, and digest;
- no server response requires exposing a host path.

### 5.6 Commands

Starting a command and following its output are separate operations.

```ts
interface CommandSpec {
  readonly argv: ReadonlyArray<string>
  readonly cwd?: WorkspacePath
  readonly env?: Readonly<Record<string, ValueOrSecretRef>>
  readonly timeoutMs?: number
  readonly disconnectPolicy: "continue" | "cancel"
  readonly outputPolicy?: OutputRetentionPolicy
}
```

Required behavior:

- `start` returns a stable `CommandRunId` after the daemon owns the process;
- closing an output stream does not implicitly cancel a `continue` command;
- output events have stable sequence numbers;
- reconnect resumes after a cursor;
- a client may receive duplicate events and can deduplicate by sequence;
- a retention gap produces an explicit `outputTruncated` event;
- stdout, stderr, exit, signal, timeout, cancellation, interruption, and spawn failure are distinct events/statuses;
- cancellation targets the process tree and documents escalation behavior;
- on daemon restart, an unrecoverable active run is marked `interrupted`;
- supervised services are Component nodes and may be reconciled/restarted independently of ordinary Command Runs.

The CLI `homestead exec` is a convenience that starts and follows a Command Run. `--detach` changes only the client workflow, not the underlying API.

### 5.7 Terminals

Terminal Sessions add PTY-specific semantics:

- rows/columns at creation;
- resize events;
- bidirectional byte streams;
- attach and detach without accidental termination;
- explicit close/kill;
- optional multi-attach policy;
- bounded replay or a documented live-only mode.

### 5.8 Event streams

Every watch/follow operation accepts an optional cursor and returns envelopes with monotonic sequence.

Document:

- at-least-once delivery;
- retention duration/size;
- behavior when a cursor is too old;
- heartbeat and reconnect behavior;
- terminal stream events;
- authorization boundaries.

---

## 6. Source, Change Sets, and Delivery

### 6.1 Separate source from Workspace naming

`Workspace.name`, source revision, checkout branch, and delivery target are separate values.

For Git sources, record:

- repository identity;
- requested revision expression;
- resolved immutable base revision;
- checkout mode;
- branch ownership: `created`, `adopted`, or `none`;
- worktree ownership;
- remote and credential references where needed.

A backend may create an ephemeral branch, use detached HEAD, clone into a container, or mount an existing worktree. The generic Workspace model does not assume one choice.

### 6.2 Immutable Change Set model

A captured Change Set includes:

- `ChangeSetId` and content digest;
- Project/Source identity;
- exact base revision;
- capture time and Workspace generation;
- entries for add, modify, delete, rename, copy, type change, and conflict;
- old/new modes;
- symlink targets;
- binary blob references;
- untracked files according to an explicit include policy;
- optional commits and metadata as annotations, not the canonical content model.

Git patch text may be an export format. It is not the only canonical representation.

### 6.3 Apply and sync semantics

The kernel exposes Change Set capture and application. `sync` is a higher-level SDK/CLI workflow that chooses a registered target checkout or delivery adapter.

Required behavior:

1. Capture an immutable Change Set.
2. Resolve the target's current base and working state.
3. Refuse to overwrite unrelated dirty changes by default.
4. Use a three-way application when the target has advanced.
5. Return structured conflicts without destroying either side.
6. Persist an application record linking Change Set, target, result, and conflict state.
7. Leave the source Workspace running.
8. Permit a later Change Set to be captured and applied.
9. Never silently commit, push, or open a pull request.

Delivery adapters may build on Change Sets to:

- update a local checkout;
- create a branch or commit;
- push to a remote;
- open a pull request;
- export an archive or patch bundle.

Those policies are outside the primitive `apply` operation.

---

## 7. Standard Components and Extensibility

### 7.1 Initial standard Component kinds

| Kind                           | Purpose                                                                      |
| ------------------------------ | ---------------------------------------------------------------------------- |
| `homestead.source.materialize` | Materialize the selected source and record ownership                         |
| `homestead.file.render`        | Atomically render a file from values and secret references                   |
| `homestead.port.reserve`       | Reserve a stable logical port/address value                                  |
| `homestead.command.once`       | Run a command once per relevant input generation                             |
| `homestead.process.supervised` | Keep a long-running process healthy while desired                            |
| `homestead.health.tcp`         | Observe TCP readiness                                                        |
| `homestead.health.http`        | Observe HTTP readiness                                                       |
| `homestead.endpoint.publish`   | Publish a service through a selected exposure driver                         |
| `homestead.artifact.capture`   | Attach a file/blob/report as an Artifact                                     |
| `homestead.secret.materialize` | Expose a secret as env/file for a bounded scope without persisting its value |

Keep the set small. Stack-specific behavior such as Postgres, Redis, Vite, Rails, or Prisma belongs in recipe or plugin packages.

### 7.2 Extension classes

#### Recipe

Trusted authoring library that composes existing Component kinds. No daemon installation is required if it compiles entirely to installed kinds.

#### Component Driver

Runtime implementation of a new Component kind. Installed into the daemon through an Effect Layer. It declares Schemas, authority, state migrations, and conformance tests.

#### Backend

Allocation implementation that supplies capability Layers for a worktree, container, VM, or remote service.

#### Policy

Pure or Effectful policy consulted for backend selection, authority approval, retry, retention, endpoint access, or Workspace lifetime.

#### Transport

Adapter exposing the same protocol over a Unix socket, Node/Bun socket client, HTTP, WebSocket, or test transport.

#### Agent Adapter

Implementation of the Orb Runtime's Agent Driver. It consumes the public Workspace SDK; it does not receive privileged controller internals.

#### Delivery Adapter

Applies immutable Change Sets to a branch, checkout, pull request, or export target.

### 7.3 Plugin trust model

Initial runtime plugins are trusted in-process code with the authority of the daemon. Say this plainly.

Every plugin ships a manifest declaring:

- package and implementation version;
- registered kinds and API versions;
- required capability/authority classes;
- state schema migrations;
- supported platforms;
- conformance suite entry point.

A future out-of-process or WASM plugin host may support untrusted extensions. Do not imply sandboxing before it exists.

### 7.4 External extensibility proof

Before calling the Component API stable, publish or build in a separate test package one non-trivial external plugin—for example an ephemeral Postgres database Component—that:

- is installed only through a Layer;
- adds no switch statement to Homestead core;
- exports typed outputs such as URL and credentials via secret references;
- survives daemon restart through observe/reconcile;
- releases only the database it owns;
- passes induced failure and repeated-destroy tests;
- is consumed by a recipe that also works with the standard process and endpoint Components.

---

## 8. Endpoints, Secrets, Identity, and Security

### 8.1 Endpoints rather than a Portal boolean

An Endpoint is its own entity and Component output, not a field stuffed into `WorkspaceInfo`.

An Endpoint records:

- logical service key;
- protocol;
- internal target reference;
- exposure driver;
- access policy;
- stable public/local address when supported;
- health and readiness;
- owning Component and Workspace;
- lifecycle and expiration.

Initial exposure drivers:

- local authenticated reverse proxy;
- direct local port for trusted local use;
- one optional tunnel implementation as an external plugin.

A future authenticated remote gateway can implement the same Component kind or a new version.

### 8.2 Secrets

Blueprints, Workspace records, logs, Events, and Artifacts contain `SecretRef` values, never plaintext secret values.

The controller composes Secret Resolver Layers. A resolver may source values from:

- process environment for local development;
- Project/Workspace encrypted storage;
- OS keychain;
- external secret manager;
- short-lived identity exchange.

Required behavior:

- just-in-time resolution;
- bounded injection as env or file;
- output/log redaction where feasible;
- no value in serialized Blueprint or StateStore;
- audit metadata without secret contents;
- explicit precedence configured as policy rather than embedded globally.

### 8.3 Workload identity

Model an optional Identity capability early even if implementation comes later. Long-lived cloud credentials should not be the only way a remote Workspace authenticates.

An identity issuer may mint short-lived, audience-bound credentials containing Workspace, Project, principal, and optional Orb identity claims.

### 8.4 Authority policy

WorkspaceSpec and plugin manifests declare requested authority. Examples:

- host filesystem outside the Workspace root;
- process spawning;
- host Docker socket;
- network egress/ingress;
- secret access;
- endpoint publication;
- privileged container options;
- device access.

The local worktree backend is explicitly trusted-only. It is not a security sandbox. Container guarantees are described from actual configuration rather than assumed from the word “container.”

### 8.5 Audit

Durable Events should identify:

- principal/client;
- operation and request ID;
- Workspace and affected entity;
- backend/plugin implementation;
- authority decision;
- result and error class;
- timestamps.

Avoid logging secret values, auth tokens, webhook URLs, or raw credentials.

---

## 9. Artifacts and Review

### 9.1 Artifact model

```ts
interface Artifact {
  readonly id: ArtifactId
  readonly workspaceId: WorkspaceId
  readonly digest: string
  readonly mediaType: string
  readonly byteLength: number
  readonly labels: ReadonlyArray<string>
  readonly provenance: {
    readonly commandRunId?: CommandRunId
    readonly componentId?: string
    readonly path?: WorkspacePath
  }
  readonly createdAt: number
}
```

Artifacts may represent:

- command logs;
- JUnit or other test reports;
- screenshots;
- videos;
- benchmark output;
- coverage reports;
- generated documentation;
- arbitrary files selected for review.

### 9.2 Review Bundle

A Review Bundle is a durable, shareable assembly of:

- one immutable Change Set;
- selected command outcomes;
- selected Artifacts;
- selected live Endpoints;
- optional human/agent-written summary;
- source and Workspace metadata.

The kernel stores and exposes the bundle. A CLI, web UI, CI reporter, or Orb UI renders it.

---

## 10. Reference Orb Runtime

### 10.1 Purpose

The reference Orb Runtime proves that the Workspace contract supports real agent workflows without putting agent concepts into the kernel.

It should remain thin enough that alternative runtimes can replace it.

### 10.2 Orb model

```ts
interface OrbSpec {
  readonly projectId: ProjectId
  readonly workspace: WorkspaceSpec
  readonly task: TaskSpec
  readonly agent: AgentDriverRef
  readonly lifetime?: OrbLifetimePolicy
  readonly parentOrbId?: OrbId
}
```

The Orb Runtime persists:

- Orb identity and task;
- Workspace association;
- Agent Driver kind/version and opaque run reference;
- parent-child relationships;
- Orb status and events;
- lifetime/expiration policy.

The Workspace Kernel stores none of this unless exposed as generic metadata.

### 10.3 Agent Driver

Illustrative contract:

```ts
interface AgentDriver {
  readonly kind: string
  readonly apiVersion: number

  readonly start: (
    task: TaskSpec,
    workspace: WorkspaceClient,
  ) => Effect.Effect<AgentRun, AgentDriverError>

  readonly steer: (run: AgentRun, input: AgentInput) => Effect.Effect<void, AgentDriverError>

  readonly cancel: (run: AgentRun) => Effect.Effect<void, AgentDriverError>

  readonly watch: (
    run: AgentRun,
    cursor?: EventCursor,
  ) => Stream.Stream<AgentEvent, AgentDriverError>
}
```

The driver gets the same public Workspace client as any third party. It does not receive a host path, raw child-process spawner, registry internals, or backend object.

### 10.4 Initial proof

Before the Workspace protocol is called stable, implement a fake/reference Agent Driver that:

1. creates or receives a Workspace;
2. reads and edits files through the Files capability;
3. starts a detached command and reconnects to its output;
4. starts a supervised service from the Blueprint;
5. waits for and reports an Endpoint;
6. attaches at least one Artifact;
7. captures a Change Set and Review Bundle;
8. leaves cleanup to the public Workspace lifecycle.

A real ROOP adapter can follow without defining the protocol.

### 10.5 MCP

MCP is a useful compatibility facade, not the canonical Homestead API. It cannot faithfully expose every stream, cursor, typed error, terminal, or long-running Operation semantic.

Keep `adapter-mcp` separate and implement it in terms of the public SDK.

---

## 11. Delivery Roadmap

Do not freeze a v1 public protocol until both a semantically different backend and an agent consumer have exercised it.

### Phase 0: v0.4 Architecture Reset and Safety Fixes

- [ ] Fix worktree ownership immediately: never delete a branch that Homestead did not create.
- [ ] Separate Workspace display name, source revision, checkout branch, and delivery branch.
- [ ] Introduce stable branded IDs for every durable entity.
- [ ] Define `WorkspaceSpec`, `WorkspaceStatus`, `Allocation`, `Operation`, `EventEnvelope`, and capability descriptors.
- [ ] Replace the singleton provider with a backend registry and scoped capability connection.
- [ ] Ensure no controller/manager module imports `worktree/*` implementation code.
- [ ] Extract pure protocol Schemas from Bun and `effect/unstable/rpc` adapters.
- [ ] Replace JSON state with a transactional SQLite-backed `StateStore` and schema migration support.
- [ ] Persist durable idempotency records.
- [ ] Remove or quarantine public `Worktree*` aliases and path-shaped Workspace APIs.
- [ ] Convert the repository to explicit package/import boundaries.
- [ ] Add crash-injection and ownership tests before adding features.

**Exit criterion:** A Workspace is created, observed, and removed by ID through a backend registry; a restart preserves state and idempotency; an adopted branch survives removal; and no Workspace controller code knows how a Git worktree is implemented.

### Phase 1: Blueprint and Reconciler

- [ ] Define the versioned Blueprint AST and value-expression model.
- [ ] Implement Component driver registration with input/output/state Schemas.
- [ ] Implement DAG validation, cycle detection, output reference validation, and bounded parallel reconciliation.
- [ ] Persist per-Component desired hash, observed state, outputs, conditions, and ownership.
- [ ] Implement deletion tombstones and retryable cleanup.
- [ ] Add standard `file.render`, `port.reserve`, and `command.once` drivers.
- [ ] Compile the legacy `ports`, `env`, `services`, `setup`, and `teardown` config into a Blueprint compatibility layer.
- [ ] Build an external test plugin with no core changes.
- [ ] Inject interruption before and after every external side effect in conformance tests.

**Exit criterion:** A serialized Blueprint converges after daemon restart; changing one node only reconciles affected dependents; deletion is ownership-safe; and an external Component package works through Layer registration alone.

### Phase 2: Two Backends Before Contract Freeze

- [ ] Rebuild the local worktree backend against the new Allocation/capability contracts.
- [ ] Implement a minimal Docker or Podman backend now, not after files, commands, sync, and endpoints are frozen.
- [ ] Run the same backend conformance suite against both.
- [ ] Run the same basic Blueprint on both.
- [ ] Report honest filesystem, process, network, persistence, and security guarantees.
- [ ] Prove backend selection is per Workspace.
- [ ] Exercise suspend/resume with containers if the backend can support it without distorting the API.

**Exit criterion:** Selecting worktree versus container is a WorkspaceSpec change; the same source, file, command, and cleanup behavior passes without conditionals in the generic controller.

### Phase 3: Files, Commands, Terminals, and Public Consumer Validation

- [ ] Expose binary-safe, root-relative Files operations.
- [ ] Add digest/version preconditions for safe concurrent writes.
- [ ] Implement stable Command Runs with separate start and watch operations.
- [ ] Persist command metadata and bounded output chunks with sequence cursors.
- [ ] Make disconnect cancellation an explicit policy; default detached runs to continue.
- [ ] Implement process-tree signalling/cancellation and interrupted-on-restart status.
- [ ] Implement Terminal Sessions with PTY resize and reconnect.
- [ ] Add Node and Bun client transport adapters without platform leakage into protocol types.
- [ ] Add `system.describe` and feature negotiation.
- [ ] Implement CLI `shell`, `exec`, `ps`, `logs`, and `cancel`.
- [ ] Implement the fake/reference Agent Driver against only the public SDK.

**Exit criterion:** CLI, generic client, and reference Agent Driver can edit files; run, detach, reconnect, replay with cursor deduplication, and cancel commands; and use an interactive terminal on both backends.

### Phase 4: Change Sets and Safe Delivery — First Substrate Release

- [ ] Define immutable content-addressed Change Sets.
- [ ] Support binary files, symlinks, mode changes, additions, deletions, renames, and explicit untracked-file policy.
- [ ] Implement capture, get, export, and apply.
- [ ] Implement target dirty checks and three-way conflict handling.
- [ ] Persist Change Set application/sync records.
- [ ] Keep Workspaces running after application.
- [ ] Add repeated-sync and target-divergence tests.
- [ ] Add one delivery adapter outside core.

**Exit criterion:** A script and reference Agent Driver can create a Workspace, modify and test a repository, capture an immutable Change Set, apply it safely to a target, repeat after further edits, and remove the Workspace without an agent-specific dependency.

### Phase 5: Supervised Services, Endpoints, Secrets, and Identity

- [ ] Implement `process.supervised` with restart policy and persisted desired state.
- [ ] Implement TCP/HTTP health Components.
- [ ] Implement stable logical port reservation.
- [ ] Implement Endpoint entities and a local authenticated reverse-proxy publisher.
- [ ] Keep Endpoint lifecycle separate from WorkspaceInfo.
- [ ] Implement SecretRef, resolver Layers, redaction, and scoped materialization.
- [ ] Add authority manifests and policy checks for plugins/backends.
- [ ] Define the Identity capability and implement one local/test issuer.
- [ ] Test service restoration after daemon restart and supported allocation resume.

**Exit criterion:** A Blueprint starts a supervised service, obtains a stable healthy Endpoint, injects a secret without persisting its value, and restores desired service state after controller restart on every supporting backend.

### Phase 6: Artifacts, Review Bundles, and Reference Orbs

- [ ] Implement content-addressed Artifact storage and retrieval.
- [ ] Attach command logs and test reports with provenance.
- [ ] Create Review Bundles combining Change Sets, Artifacts, commands, and Endpoints.
- [ ] Implement the `@homestead/orb` reference runtime and Agent Driver registry.
- [ ] Implement one real Agent Driver adapter outside the kernel.
- [ ] Keep transcript and model policy in the adapter/runtime package.
- [ ] Add a minimal review CLI or local web view only if needed to prove the model.

**Exit criterion:** A real agent completes a task in an Orb using only public Workspace operations and returns a reviewable bundle with changes, test evidence, and a live Endpoint where applicable.

### Phase 7: Remote Backend, Power Lifecycle, and Leases

- [ ] Implement one concrete remote backend before introducing vendor-generic abstractions.
- [ ] Add authenticated HTTP/WebSocket transport using the same protocol Schemas.
- [ ] Implement Allocation suspend/resume/replacement and Workspace desired power state.
- [ ] Add idle/expiration leases as policy.
- [ ] Add secure remote source materialization, secret delivery, and workload identity.
- [ ] Define host-loss and reconnect guarantees from observed behavior.
- [ ] Evaluate Effect Workflow/Cluster only against concrete remote scheduling and recovery requirements.

**Exit criterion:** A Workspace retains logical identity while its remote Allocation suspends and resumes; public clients reconnect through the same protocol; and cleanup remains convergent after controller or backend interruption.

### Phase 8: Higher-Level Orb Workflows

- [ ] Add parent-child Orb relationships and delegation policy.
- [ ] Add durable trigger/event ingestion with at-least-once semantics and idempotency keys.
- [ ] Add schedules and webhook adapters outside the Workspace Kernel.
- [ ] Add wake-on-trigger or wake-on-Endpoint policy where the backend supports it.
- [ ] Add multiplayer authorization and shared-terminal policy only after a real product consumer requires them.

**Exit criterion:** Higher-level runtimes compose child Orbs, triggers, and durable agent work without changing Workspace Kernel concepts or bypassing its authority model.

---

## 12. Non-Negotiable Acceptance Gates

### 12.1 Backend parity gate

- [ ] One compiled Blueprint must run unchanged on worktree and container backends. Backend-specific options may be selected in `WorkspaceSpec`, but recipes and generic controller code may not branch on backend kind for ordinary files/processes/endpoints behavior.

### 12.2 External extension gate

- [ ] A separately packaged Component Driver must register through an Effect Layer, reconcile, emit typed outputs, survive restart, and clean up without any edit to Homestead core.

### 12.3 Public-only agent gate

- [ ] A reference Agent Driver must complete the end-to-end Workspace flow using only the public SDK. No host path, registry access, raw spawner, backend object, or daemon-private service may be injected.

### 12.4 Crash matrix gate

For backend allocation and every standard managed Component, tests interrupt:

- [ ] before intent persistence
- [ ] after intent persistence but before side effect
- [ ] after side effect but before observed state persistence
- [ ] during dependent-node reconciliation
- [ ] during removal
- [ ] after external deletion but before tombstone completion

Restart must converge to desired state or a precise, retryable terminal condition without deleting unowned resources.

### 12.5 Protocol isolation gate

The same protocol test suite runs through:

- [ ] an in-memory transport
- [ ] the local Unix socket
- [ ] Bun client adapter
- [ ] Node client adapter
- [ ] future HTTP/WebSocket adapter

No test changes Workspace semantics by transport.

### 12.6 Security honesty gate

- [ ] A capability conformance report must distinguish trusted rooting from actual sandboxing and document network, filesystem, process, secret, and persistence guarantees for each backend.

### 12.7 Review result gate

- [ ] An end-to-end task must produce more than a diff: at least one command result and one Artifact or Endpoint are linked into a Review Bundle.

---

## 13. Migration from the Current Repository

### 13.1 Versioning stance

Make v0.4 intentionally breaking.

Do not preserve source compatibility for:

- `WorktreeManager` and `WorktreeInfo` exports;
- Workspace lookup by `projectRoot + name` as the canonical API;
- `WorkspaceProvider` as a singleton Context service;
- closed `ProviderCapabilities` enums/booleans;
- arbitrary string-only provider metadata;
- `WorkspaceInfo` as one flat record containing path, branch, ports, provider, and future portal data;
- an Effect RPC group as the only protocol definition.

Offer CLI aliases or a small compatibility adapter for one release if useful, but keep the new core clean.

### 13.2 State migration

Provide an explicit migration from `workspaces.json` to SQLite:

- [ ] generate stable Project records for known local roots
- [ ] preserve existing Workspace IDs
- [ ] import worktree path and branch as backend state
- [ ] conservatively mark branch ownership as `unknown/adopted`, never `created`, unless ownership can be proven
- [ ] observe each worktree before marking it ready
- [ ] retain the old file as a backup
- [ ] surface ambiguous or unsafe records for manual resolution

### 13.3 Configuration migration

Keep `homestead.config.ts` as trusted authoring code, but change its output to a Blueprint.

The old configuration compiler may:

- [ ] evaluate `worktreeDir` and `env.derive` only in the trusted authoring/controller process
- [ ] translate ports, environment edits, services, setup, and teardown into standard Component nodes
- [ ] emit warnings for semantics that cannot be made portable
- [ ] never persist the closure itself
- [ ] eventually deprecate implicit `.env` scanning in favor of explicit Component outputs

### 13.4 Rewrite the current issues

#### Issue #54: platform-neutral clients

Expand it from “add a Node socket Layer” into:

- [ ] pure `@homestead/protocol` Schemas
- [ ] Effect client interface independent of platform
- [ ] in-memory, Bun Unix-socket, and Node Unix-socket adapters
- [ ] no Bun import in core/protocol/sdk entry points

#### Issue #55: command execution

Replace one streaming `exec` call with stable command lifecycle operations:

- [ ] start
- [ ] get/list
- [ ] watch from cursor
- [ ] write input
- [ ] signal/cancel
- [ ] ensure stream interruption does not kill a command whose disconnect policy is `continue`

#### Issue #56: diff and sync

- [ ] Replace raw diff/patch endpoints with immutable `ChangeSet` capture/export/apply and a CLI sync workflow
- [ ] Keep Git patch as one export encoding

#### Issue #57: provider abstraction

Do not add more methods to a mega-provider. Replace it with:

- [ ] backend registry
- [ ] Allocation lifecycle
- [ ] scoped capability services
- [ ] versioned capability descriptors
- [ ] early worktree and container conformance

#### Issue #58: portals

- [ ] Model Endpoints and publisher Components
- [ ] Do not add portal URLs to `WorktreeInfo` or a boolean to provider capabilities

#### Issue #59: ROOP and MCP

- [ ] Keep both as adapters outside the kernel
- [ ] Build the reference Orb Runtime first, then let ROOP implement `AgentDriver`
- [ ] Treat MCP as a compatibility facade over the SDK

---

## 14. Immediate Pull Request Sequence

- [ ] **1. Safety patch:** persist branch/worktree ownership and stop deleting adopted branches.
- [ ] **2. ADR: domain reset:** approve Workspace versus Allocation, Blueprint/Component, Operation/Event, Endpoint, Artifact, and Orb boundaries.
- [ ] **3. Package boundaries:** create core/protocol/sdk/controller/backend packages or strict equivalent export boundaries.
- [ ] **4. StateStore:** add SQLite migrations, durable IDs, Operations, Events, and idempotency; import v1 JSON state.
- [ ] **5. Backend registry:** replace the singleton provider and remove worktree imports from the generic controller.
- [ ] **6. Worktree backend v2:** implement allocation, discovery, ownership-safe destruction, and capability Layer.
- [ ] **7. Blueprint compiler:** add AST, output refs, driver registry, DAG validation, and legacy config compiler.
- [ ] **8. Reconciler:** desired/observed state, Component records, tombstones, crash-injection harness.
- [ ] **9. Container backend spike:** implement enough Files/Processes behavior to pressure-test the contracts before protocol freeze.
- [ ] **10. Protocol v0:** add `system.describe`, ID-based lifecycle, Operation/Event watching, in-memory/Bun/Node transport suites.
- [ ] **11. Command runtime:** stable runs, output cursor store, disconnect policy, process-tree cancellation.
- [ ] **12. Thin agent proof:** implement a fake Agent Driver immediately after commands, before proceeding to broad feature work.

Do not start Portal tunnels, MCP tools, or broad remote-provider generalization before this sequence establishes the extension and durability model.

---

## 15. First-Release Non-Goals

The first substrate release does not need:

- a model implementation or general-purpose agent loop in the Workspace Kernel;
- transcript storage in the Workspace Kernel;
- automatic continuation of an arbitrary Command Run after daemon crash;
- a multi-tenant scheduler;
- vendor-neutral remote compute abstractions before one remote backend exists;
- untrusted in-process plugin sandboxing;
- transparent security claims for local worktrees;
- a built-in catalog of every database and web framework;
- a hosted multiplayer UI;
- automatic commit, push, or pull-request policy inside Change Set application;
- transparent migration of every v0.3 edge case at the cost of the new model.

These are exclusions from the first release, not reasons to omit the extension points and domain boundaries they will eventually require.

---

## 16. Decision Rules

When implementation choices are unclear:

1. Prefer a serializable contract over a convenient persisted closure.
2. Prefer a small capability service over widening a backend interface.
3. Prefer one reconciled Component graph over parallel lifecycle systems.
4. Prefer stable IDs and explicit references over names, paths, or inferred ownership.
5. Persist intent before side effects and ownership before deletion.
6. Use Effect Scope for live handles; use persisted reconciliation for crash recovery.
7. Validate every major contract against worktree, container, and a public-only agent consumer before freezing it.
8. Add a core Component only when a safe external recipe cannot express the behavior.
9. Add a new Component kind only with Schemas, authority declaration, state migration, and conformance tests.
10. State delivery, retention, security, and durability guarantees precisely; never hide uncertainty behind a boolean capability.
11. Keep model, prompt, transcript, and delegation policy out of the Workspace Kernel.
12. Break v0.x compatibility when it blocks composition, safety, or a transport-neutral model.

---

## 17. Definition of Success

Homestead has reached a strong composable foundation when all of the following are true:

- [ ] a Project is not tied to a host path
- [ ] a Workspace is not tied to a Git branch or one Allocation
- [ ] a backend is not an ever-growing service interface
- [ ] a Blueprint is typed to author and serializable to store
- [ ] third-party Components install without core edits
- [ ] every owned external object is discoverable and reconciled after restart
- [ ] adopted resources are never deleted accidentally
- [ ] commands and terminals survive client disconnect according to explicit policy
- [ ] streams resume from cursors with honest at-least-once semantics
- [ ] Change Sets are immutable, portable, binary-safe, and safely applicable
- [ ] Endpoints, secrets, identity, and Artifacts are first-class rather than provider metadata
- [ ] the same Blueprint works on worktree and container backends
- [ ] a real agent can use the public SDK without privileged escape hatches
- [ ] an alternative Orb runtime can replace the first-party one without changing the Workspace Kernel

That is the point at which Homestead is not merely an open clone of one Orb implementation. It is a genuinely composable substrate from which different Orb products can be built.
