# Context

The ubiquitous language for homestead. Glossary only — no implementation details.

## Terms

### Worktree
An isolated git worktree provisioned by homestead for one unit of work: its own branch,
allocated ports, `.env`, services, and setup steps. The unit of isolation.

### Agent
The interactive coding agent (e.g. `claude`) that homestead boots inside a worktree's
herdr pane. homestead launches it, hands it one kickoff prompt, and then leaves — the
human drives the live session from there.

### Surface
The herdr container homestead opens for one issue, nested under the repo's workspace:
a `worktree` (the default — the git worktree as a child workspace), a `tab`, or a flat
`workspace`. The pane inside it is where the agent runs.

### Launch
What homestead does per issue: provision the worktree, open a surface, boot the
interactive agent in its pane, poll the pane until the REPL is ready, and type the
**kickoff prompt** once. After the launch, homestead is hands-off until `close`/`kill`.

### Ready marker
The text homestead polls a pane for to know the agent's REPL has finished booting and
will accept input (Claude's is `❯`). Per-agent, declared in config, so the launcher
stays agent-blind.

### Trust prompt
An optional pre-REPL gate some agents show on a fresh directory (Claude's "trust this
folder?"). homestead clears it — waits for it, confirms, and waits for it to vanish —
before looking for the ready marker.

### Kickoff prompt
The single message homestead types into the freshly-booted agent. Built from the issue,
worktree, and CLI args — homestead applies a default automatically. Override with an
optional config `prompt(ctx)` callback if you want a custom kickoff. Fired exactly once;
everything after is the human driving the session.

### AgentConfig
The per-project description of how to launch an agent: the launch argv (`command`), the
`surface`, the `readyMarker` / `trustPrompt`, and the `prompt(ctx)` callback. Swapping
Claude for another agent, or changing the kickoff, is a config edit — no code change.

### Autonomous mode
The unattended variant of a launch (`agent.autonomous`). The kickoff drops the
plan-gate ("show me your plan") so the agent builds to completion without a human
approving a plan, and the agent process is wrapped so that **the harness** — not the
model — writes the done-signal (the agent sentinel) when the agent exits. The verdict
comes from the configured **check** command (exit 0 → done, non-zero → failed); a
genuine `blocked` the agent self-reports is left untouched. Built for fan-out where no
human is watching each pane.

### Check command
The verification command (`agent.check`, e.g. `bun run check`) the harness runs the
moment an autonomous agent exits, to decide the sentinel's status deterministically.
Distinct from `pr.checks`, which is only named in a PR kickoff prompt for the agent to
run itself.

### Issue states
The label-driven lifecycle, reflected onto the GitHub issue (opt-in via config):
`agent:ready` (queued, a human convention) → `agent:wip` (homestead launched an agent on
it) → `agent:review` (the human ran `close`: work is done, branch kept, handed off for
review/merge). `kill` instead reverses the signals entirely (abandoned).

### Close
The graceful finalize: tear down the worktree and herdr surface, **keep the branch**
(the open PR / pushed commits), and move the issue to `agent:review`. The soft inverse of
launch, for work whose session is done.

### Kill
The hard teardown: remove the worktree, herdr surface, **and** the branch (local +
remote), and reverse every GitHub signal homestead applied at launch. For abandoned work.
