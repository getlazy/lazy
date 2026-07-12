# lazy-agent Design

## Overview

`lazy-agent` is the binary that runs inside Docker containers. It serves two roles:

1. **Supervisor** (default mode) — container entrypoint that manages work phases
2. **MCP server** (`mcp` subcommand) — exposes lazy tools to Claude Code via JSON-RPC over stdio

## Process Architecture

Inside the container, three processes form a parent-child chain:

```
PID 1: lazy-agent --protocol-dir ... --worktree ...  (supervisor)
  └─ claude -p "..."                                  (Claude Code)
       └─ lazy-agent mcp --task-id ... --worktree ... (MCP server)
```

### Why two modes, not one process?

MCP's stdio transport requires the server to be a **child process** of the client
(Claude Code). Claude Code reads `~/.claude.json`, spawns the MCP server process,
and communicates with it via stdin/stdout.

The supervisor is already running as PID 1 — it can't also serve as the MCP server
on Claude Code's stdin/stdout because:

- The supervisor spawns Claude Code (parent → child)
- Claude Code spawns the MCP server (parent → child)
- MCP stdio requires the server's stdin/stdout to be owned by the client
- A process can't be both an ancestor and a child of Claude Code

So the supervisor and MCP server **must** be separate processes. They share the
same binary (`lazy-agent`) but run in different modes.

## Supervisor (default mode)

```
lazy-agent --protocol-dir <path> --worktree <path>
```

The supervisor is the container entrypoint. It:

1. Checks required tools (git, claude, lazy-agent)
2. Recovers worktree state from previous crashes
3. Enters a command loop: waits for `command.json` from the host
4. Executes phases: sync-with-remote → sync-with-upstream → write MCP config → work → post-turn sync
5. Writes `response.json` when done
6. Stays alive between turns (the container is long-lived)

Before spawning Claude Code, the supervisor writes `~/.claude.json` inside the
container so Claude Code discovers the MCP server on startup.

## MCP Server (`mcp` subcommand)

```
lazy-agent mcp --task-id <uuid> --worktree <path>
```

The MCP server is spawned by Claude Code (not by the supervisor directly). It:

1. Implements JSON-RPC 2.0 over stdio (no external dependencies)
2. Exposes agent tools including `lazy_search`, `lazy_show`, `lazy_create`, `lazy_comment`,
   `lazy_add_followup`, `lazy_commit`, `lazy_status`
3. Opens/closes storage per tool call to avoid stale state
4. Runs as long as Claude Code keeps stdin open

### Follow-ups: a passive, task-level store for orthogonal discoveries

When an agent notices genuinely **orthogonal** work — a different concern the current task
does not need in order to be correct and mergeable — it records it with `lazy_add_followup`
rather than creating a backlog task or burying it in prose. Follow-ups are stored on the task
(`follow-ups.json` / a `follow_ups` table), so they survive auto-turns and auto-resumes.

The defining invariant is that recording a follow-up is **non-triggering**: it creates no
comment, changes no task status, and writes no signal, so it can never kick off an auto-turn or
auto-resume. This is exactly why follow-ups are a separate store and not comments — comments
feed the comment auto-react loop, which would spuriously resume the agent. Follow-ups are
read and triaged by the builder/human at review time (`lazy_show` surfaces them as `follow_ups`):
each is folded back into the task, promoted to a vetted task, or dropped. The backlog only ever
receives builder-vetted tasks.

The MCP server replaces the old CLI-based agent commands. Instead of the agent
calling `lazy search ...` as shell commands, it uses MCP tool calls which are
type-safe and structured.

## Naming: lazy vs lazy-agent

The binary is named `lazy-agent` (not `lazy`) because eventually both will be
separate MCP servers:

- **`lazy-agent`** — runs inside containers, exposes tools for the coding agent
- **`lazy`** (future) — runs on the host, allows the lazy builder to talk to lazy directly

These have similar but different APIs. The agent-facing tools (propose, commit,
search) differ from the host-facing tools (create, start, unblock, accept).

## Container Setup

The host mounts the agent binary into the container:

```
-v ${agentBinaryPath}:/usr/local/bin/lazy-agent:ro
```

The container's entrypoint runs `lazy-agent --protocol-dir ... --worktree ...`
which starts the supervisor loop.

## MCP Config (~/.claude.json)

The supervisor writes this config before spawning Claude Code:

```json
{
  "mcpServers": {
    "lazy-agent": {
      "command": "lazy-agent",
      "args": ["mcp", "--task-id", "<uuid>", "--worktree", "<path>"]
    }
  }
}
```

Claude Code reads this on startup and spawns the MCP server as a child process.
