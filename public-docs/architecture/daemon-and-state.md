# The daemon and its clients

Each project has one daemon. It owns every rule and all the state; everything else is a client that asks it to act.

- **The CLI** parses what you type and prints the answer.
- **The dashboard** is served by the daemon itself.
- **Agents** reach it through the MCP server in their container, which can act only for the turn that is running.
- **The supervisor** in each container runs one agent and reports back.

Clients ask the daemon to do things and never write the store themselves, so a rule such as "accept refuses while a blocking question is open" is the same on every surface. The daemon listens on loopback by default (`[server] bind`). See [The daemon, the task container and the proxy](../explanation/daemon-and-proxy.md).

## The store

Tasks, sessions, turns, commits, comments, conversations and memory live in the project's store: by default a folder under `~/.lazy/<project-name>`, or the `[storage] external_path` you set. It sits outside the repository, so it is never committed, and task containers are not given it.

Before a new lazy version first opens a store, lazy saves it as a verified compressed archive next to it and keeps the newest five (`[storage] backup_keep`). If the backup fails, the new version does not open the store. See [Store backups](../store-backups.md).

## What the daemon also does

It runs the proxy ([Agents and the proxy](agents-and-proxy.md)), reconciles task statuses against what is actually running (see [The task state machine](../state-machine.md)), and retries background work such as pushes and follow-through after an accept.
