# Context

The ubiquitous language for githog. Glossary only — no implementation details.

## Terms

### Worktree
An isolated git worktree provisioned by githog for one unit of work: its own branch,
allocated ports, `.env`, services, and setup steps. The unit of isolation.

### Agent
The coding agent (e.g. `claude`) that githog launches to work on an issue inside a
worktree's herdr pane.

### Skills
The prompt logic for each stage of work, shipped as versioned Claude skills that githog
seeds into a worktree at provision time and invokes by name: `/githog-plan` (the plan
pass), `/githog-implement` (one iteration), and later `/githog-review` (the fresh-context
reviewer). Built-in defaults apply if a skill is absent; `githog.config.ts` can override
the skill name or supply a custom prompt. Keeping the logic in skills (not buried in
config or hardcoded) is what makes the factory tunable and introspectable — a skill can
be read, edited, or run by hand in a pane to debug. The same mechanism later hosts the
backlog-filling front of the pipeline (`/grill`, `/to-prd`, `/to-issues`).

### agent loop
The mechanism by which an agent works an issue: the agent is re-invoked with a **clean
context** each **iteration** until the issue is done. Replaces the previous "launch
claude interactively and type one prompt" model. The loop runs *inside the herdr pane*
so it can be watched live, but it
is driven by headless re-invocation, not interactive typing.

### Iteration
One pass of the agent loop: a fresh agent invocation that picks up the issue's current
state, does work, and exits. Iterations do not share context — state carries across
iterations via durable artifacts, not the agent's memory.

### Plan pass
A one-shot agent invocation that runs *before* the agent loop. It reads the issue and
decomposes it into a **task list** of atomic, vertical-slice tasks, written to a durable
file in the worktree. Distinct from an iteration: it plans, it does not implement.

### Task list
The decomposed, ordered list of atomic tasks for one issue, produced by the plan pass
and stored in the worktree. It is the single cross-iteration memory: each iteration picks
the next incomplete task and marks it done, so the task list doubles as the progress log.
The agent loop ends when every task is marked done.

### Completion sentinel
A token the agent emits (e.g. `<promise>COMPLETE</promise>`) to signal the issue is
finished. githog watches the agent's output for it and stops the agent loop. The agent
is responsible for running its own tests/checks before emitting it. An iteration cap is
the backstop if the sentinel is never emitted.

### Completion handoff
What githog does when the agent loop ends on the completion sentinel: open a pull request
from the worktree's branch (`gh pr create`), link the issue, and move it to the
`agent:review` state. The worktree is left alive for inspection until `githog kill`.
The PR queue is the human review/merge surface. (A future fresh-context reviewer pass —
a clean agent invocation that posts review notes or files follow-up issues — layers on
top of this.)

### Issue states
The label-driven lifecycle of an issue: `agent:ready` (queued) → `agent:wip` (an agent
loop is running) → `agent:review` (loop completed, PR open, awaiting human) /
`agent:blocked` (loop stopped without completing — needs a human). Both `agent:review`
and `agent:blocked` free a `listen` concurrency slot. The `agent:wip` count is the
concurrency gauge for the `listen` daemon.

### Blocked
A loop that stopped without completing. Two causes: the iteration cap was exhausted
without a completion sentinel, or the agent emitted a `<blocked>reason</blocked>`
sentinel mid-loop because it hit a decision it couldn't make. In both cases githog stops,
moves the issue to `agent:blocked`, pushes the partial branch, and posts the reason / last
output as a comment — never an auto-PR. The agent-initiated block is what makes
unattended operation safe: hard questions surface to the human instead of being guessed.
