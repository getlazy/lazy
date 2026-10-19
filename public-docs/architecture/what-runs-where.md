# What runs where

Two places run lazy's code: your machine (the host) and one container per task.

## On the host

The **daemon** runs on the host, one per project, along with the **proxy** it starts. The daemon owns the task store, launches containers, runs `git` and the forge CLIs (`gh`, `glab`), and serves the dashboard. See [The daemon and its state](daemon-and-state.md).

## In a task container

Each task's agent runs in a Docker (or Podman) container on that task's git worktree. Inside it:

- **The supervisor**: lazy's own small program, mounted into the container at launch. It runs the agent, watches it and reports to the daemon.
- **The lazy MCP server**: the process that gives the agent its `lazy_*` tools. It talks to the daemon, which decides what each call may do. See [MCP tools](../mcp-tools.md).
- **The agent**: Claude Code, Codex, Cursor or Pi.
- **Whatever the task builds and runs**: installs, builds, test runs and any services. A project's `[serve]` ports are published on the host's loopback address only.

The image, and how to give a project its own, are covered in [The agent container](../agent-container.md).

## What a container can reach

| | In the container |
| --- | --- |
| Project checkout | Read-only. The project's `.lazy/` folder inside it is hidden behind an empty in-memory folder, so it cannot see other tasks' worktrees or the store's working files. |
| The task's worktree | Read-write. This is where the agent works. |
| Git | The repository's shared git directory (refs, config, hooks, other tasks' worktree metadata) is read-only. Only the object store and this task's own worktree metadata are writable, so the agent can stage files and create objects but cannot move a branch. The agent commits with the `lazy_commit` tool rather than `git commit`. |
| Push and forge credentials | None. No SSH keys, no `gh`/`glab` login and no forge token are mounted. The daemon pushes and talks to the forge. |
| Model credentials | A per-task placeholder, not your credential. See [Agents and the proxy](agents-and-proxy.md). |
| The daemon | One file with this container's own access token, and nothing else from the daemon's state folder. Mounting that folder through `[[mounts]]` is refused. |
| Network | Model traffic goes to the proxy on the host. |

How the git protections work in detail, including the three pointer files that tell git where the repository is, is in [The agent container](../agent-container.md#what-the-container-can-and-cannot-change-in-git).

## Agents always run in containers

Agents always run in a container. A `lazy.toml` that asks for the `host-process` runner fails to load with an error pointing at Docker. See [`[runner]`](../lazy-toml.md#runner).

## Lazy Teams

In [Lazy Teams](../explanation/lazy-teams.md) (private alpha), when the server has hardware virtualization, the same split applies inside a machine of its own: each project's daemon and its task containers run in a microVM instead of on your laptop.
