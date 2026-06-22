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
pass), `/githog-implement` (one iteration), and `/githog-review` (the fresh-context
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
What githog does when the agent loop ends on the completion sentinel (and, with
review-converge on, only after the diff clears both gates): open a pull request from the
worktree's branch (`gh pr create`), link the issue, and move it to the `agent:review`
state. The worktree is left alive for inspection until `githog kill`. The PR queue is the
human review/merge surface.

### Review-converge cycle
The optional gate (ADR-0003, off by default) between a builder's completion sentinel and
the completion handoff: build → **machine gate** → **fresh-context reviewer** → (fix and
repeat if either fails) → PR only when the gate is green *and* the review is clean. It
exists because a builder grading its own exam rationalises its own shortcuts; githog
enforces the two gates itself rather than trusting the builder's `COMPLETE`. The cycle is
capped (`maxReviewRounds`); a builder that can never satisfy the reviewer ends
`agent:blocked` for a human. Findings and gate failures are carried across the amnesia
boundary by appending them to the task list as fix tasks — so a review pass is symmetric
with a plan pass (plan decomposes the issue, review decomposes the defects).

### Machine gate
The deterministic half of the review-converge cycle: githog runs a configured
`verifyCommand` (the project's own checks, e.g. typecheck + test) and reads its exit code
directly. A non-zero exit is never "complete", whatever the builder claimed — the failure
becomes a fix task and the loop rebuilds. Unset `verifyCommand` means review-only (no
machine gate). This is just the project's configured command; githog adds no formal or
mathematical verification.

### Fresh-context reviewer
The adversarial half of the review-converge cycle: a separate agent invocation
(`/githog-review`) over the whole diff, run in a **clean context with no shared history
with the builder** — always fresh, even when `resume` continuity (ADR-0002) is on, so it
stays hostile instead of endorsing the author's choices. It reads the issue, the task
list, and the diff; checks the work against each slice's acceptance criteria (so "clean"
means "satisfies the spec", not "compiles"); then either appends concrete fix tasks and
signals findings, signs off clean, or `<blocked>`s on a human-only question.

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
