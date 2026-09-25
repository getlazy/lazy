# Pairing

`lazy pair <task>` drops you into an interactive agent session on a task — the
same session its supervised turns run, with the same history, on the same
branch. You talk to the agent directly, it edits the worktree, and when you exit
lazy records a summary turn and puts the task back to `blocked`.

## Where the session runs

**In the task's container**, alongside the task's own turns. Pairing joins the
existing container with `docker exec` rather than starting a new one, so
whatever else is running in it — dev servers, watchers, published ports — keeps
running. If the container is gone (daemon restart, `lazy upgrade`, a manual
`docker rm`), pairing starts one, the same way a supervised turn would.

This is a change from earlier versions, where pairing launched the agent as a
**host** process against the task worktree. That had three problems, and moving
into the container fixes all three:

- **Session state.** The agent's home directory is now the sandbox mount the
  task's own turns already write (`<worktree>/.lazy-task-sandbox/`), so resuming
  a container-written session Just Works: it is the same directory, not a copy.
  Nothing is imported across the container boundary, which closes the
  escalation channel described in [Cursor pairing](#cursor-and-codex-pairing) below.
- **Blast radius.** `--autonomous` (permission prompts off) is now the same
  trust decision as any supervised turn, not "an agent with your privileges on
  your machine".
- **Honesty.** Host pairing was the escape hatch for everything that did not
  work in a container. Anything that does not work in a paired session is now a
  container bug to fix.

## The `--host` escape hatch

**Branchless mode** — `lazy pair` with no task, on a non-task branch — has no
container to join. It requires an explicit `--host`, and prints what that means
before launching.

On a normal task, `--host` is an optional claude-code-only opt-in to run the
agent on your machine instead of in the task's container. There is deliberately
**no automatic fallback**: if the container path fails, pairing fails loudly
rather than quietly running an agent on your machine instead.

```
lazy pair <task>          # in the task's container (the normal case)
lazy pair <task> --host   # claude-code only: on your machine instead of the container
lazy pair --host          # branchless: no task, no worktree, no container
```

## Tools the paired session gets

A paired session is wired with **this task's** `lazy_*` MCP tools — the same
scoped toolset the task's own agent gets, not the broader builder toolset. That
is deliberate: the session is operating on one task, in that task's worktree, so
it gets that task's tool channel or none. Tool registration fails loudly; a
paired session with no lazy tools is broken, not degraded.

## Cursor and Codex pairing

Cursor and Codex tasks pair the same in-container way: the interactive CLI runs
inside the task's container on the same mounted home (`~/.cursor` / `~/.codex`)
the supervised turns used, resuming the task's own session. For Cursor this was
previously a hard refusal, for a security reason
that in-container pairing removed: a container-written Cursor chat lives in the
worktree sandbox, a *host* `cursor-agent` reads your real `~/.cursor` and cannot
see it, and lazy will not close that gap by copying agent-authored history into
your host home — that turns a task's chat log into a prompt-injection channel
into a session running as you. Since the session now runs on the same side of
the boundary as the agent that wrote the history, nothing is copied and there is
nothing to escalate.

**Honest gap:** conversation capture and the AI end-of-session summary need
session files lazy can read back, and Cursor's and Codex's are not that — so
pairing on a Cursor or Codex task records the commits you made and skips the
transcript and summary. Pairing says so rather than silently omitting them.

## Pi pairing

Pi tasks pair the same in-container way: `lazy pair` launches `pi`
interactively in the task container. When the task already has a session, the
paired one resumes it with its history and continues the supervised work;
otherwise a fresh session starts, and pairing says which it did.

Pi's session files are in Pi's own documented format, which lazy reads back:
when the session ends, every session file the pairing wrote is captured into
lazy's conversation store (searchable with `lazy search`), and the
end-of-session summary is synthesized from that transcript — the same as for
Claude Code. If saving a conversation fails, pairing says so and still writes
the summary; the session file is untouched on disk either way.

## Ending a session

Exit the agent. Lazy releases the pairing lock, restores the task's status, and
(for Claude Code and Pi) captures the conversation and synthesizes a summary
turn from it.

If the host side is killed — a daemon restart, `lazy upgrade` — the in-container
process is signalled through a pidfile in the shared sandbox directory rather
than left holding the session, because `docker exec` does not forward signals to
the process it started.

```
lazy pair <task> --unlock
```

recovers a session that outlived its host command. It signals the in-container
agent through that same pidfile, removes the pairing lock, and restores the task
to `blocked`. If no pidfile is present there is nothing running to signal, and
`--unlock` just clears the lock and status — it will not start a stopped
container to go looking.

`--host` sessions have no pidfile: they are ordinary child processes of your
shell, so exiting or killing the terminal is what ends them.
