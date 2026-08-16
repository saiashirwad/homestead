# Homestead

Homestead manages isolated, reproducible Workspaces for development tasks. People, scripts, and agent runtimes can operate those Workspaces through the same capabilities.

## Language

**Project**:
A source repository together with the configuration needed to prepare its Workspaces.
_Avoid_: App, codebase

**Workspace**:
An isolated filesystem and process environment created from a Project for one task. A Workspace may be operated by a person, an agent, or both.
_Avoid_: Orb, sandbox, machine

**Provider**:
The execution environment that creates and operates Workspaces, such as a local Git worktree, a container, or a remote machine.
_Avoid_: Runner, backend

**Command Run**:
One invocation of a command inside a Workspace, with stable identity, lifecycle status, input, and output. It may outlive the client that started it.
_Avoid_: Agent turn, task, session

**Orb**:
A task or agent thread paired with one Workspace by a higher-level runtime. An Orb may create related Child Orbs, each with its own task and Workspace.
_Avoid_: Workspace, session, agent

**Child Orb**:
An Orb created by another Orb to perform a delegated task. It is independently inspectable and has its own Workspace.
_Avoid_: Sub-workspace, hidden subagent

**Agent Session**:
The durable interaction history between a user and an agent within an Orb. Agent runtimes own Agent Sessions; Homestead does not require them for ordinary Workspaces.
_Avoid_: Orb, Workspace

**Resource**:
A managed capability that remains available for some or all of a Workspace's lifetime and must be released, such as a supervised process or temporary database.
_Avoid_: Setup step, Effect service

**Provision Step**:
A one-time action used to prepare a Workspace, such as installing dependencies or running a migration.
_Avoid_: Resource

**Portal**:
A stable URL through which a service running in a Workspace can be reached and inspected.
_Avoid_: Port, service

**Change Set**:
A reviewable snapshot of changes made in a Workspace relative to its base revision.
_Avoid_: Workspace, result

**Sync**:
An explicit operation that applies a Workspace's current Change Set to a local checkout without ending the Workspace.
_Avoid_: Merge, teardown
