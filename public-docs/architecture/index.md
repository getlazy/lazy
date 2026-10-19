# Architecture

Lazy is a daemon on your machine that runs each task's agent in a container, on a git branch of its own, and routes the agent's model traffic through a proxy that holds your real credentials. These pages describe what runs where, how agents are reached, what lazy does on a forge, who owns the rules and the store, how tasks map onto git, and how a task moves between statuses. Each one is short; the explanation and reference pages they link to have the detail.

- [What runs where](what-runs-where.md): the host, the task container, and what a container can and cannot reach.
- [Agents, the proxy and credentials](agents-and-proxy.md): how Claude Code, Codex, Cursor and Pi reach their models without holding your credential.
- [Forges](forges.md): what lazy reads from GitHub and GitLab, the few things it writes, and where an accept merges.
- [The daemon and its clients](daemon-and-state.md): the daemon owns the rules and the store; the CLI, dashboard, MCP server and supervisor are clients.
- [Git integration](tasks-in-git.md): worktrees, task branches, the task tree, sync, and what accept does to git.
- [The task state machine](../state-machine.md): the statuses, the moves between them, who makes each move, and what happens on a crash or daemon restart.
