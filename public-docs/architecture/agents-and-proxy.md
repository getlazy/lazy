# Agents, the proxy and credentials

Lazy runs four agent harnesses: Claude Code, Codex, Cursor and Pi. A task picks one through an [agent profile](../lazy-toml.md#agentsname--named-agent-profiles). All four are launched the same way, in a task container, and all four reach their model through the same proxy.

## What the proxy does

The proxy is a process the daemon runs on the host, always on, listening on loopback by default (`[proxy] bind`). Every agent is handed the proxy's address, never the provider's, so nothing an agent sends goes to a model without passing through it. For each request the proxy:

1. identifies the caller from its placeholder token;
2. picks the upstream the caller's profile points at (a provider, or an endpoint such as a local Ollama);
3. swaps in the real credential;
4. records the call (tokens, timing, which task) in a bounded audit log, and reads the provider's usage-limit headers.

## Placeholder tokens

At launch the daemon mints a random placeholder per task and role, and puts it in the environment variable the harness would normally read its credential from, shaped like the real one. The proxy looks the placeholder up to learn the task and the agent profile; it does not trust anything the agent says about itself. The placeholder cannot authenticate to the provider directly, but treat it as a live token for this machine's proxy until it is revoked when the task ends. Where Docker lets lazy tell containers apart (native Linux Docker) it is also pinned to its own container; on Docker Desktop, rootless or remote Docker it is not. Full mechanics: [Just-in-time credential injection](../proxy-jit-credentials.md).

## Per harness

Each harness is pointed at the proxy in the way it supports:

- **Claude Code** is given the proxy as its API base address.
- **Codex** is given a provider block in its own config file, rewritten each turn, that names the proxy; its key is the placeholder.
- **Cursor** is given an endpoint on the proxy under a fixed path prefix, which the proxy forwards verbatim to Cursor's service.
- **Pi** is given a provider config file, rewritten each turn, that pins its provider addresses to the proxy.

## The credential store

Real credentials live with the daemon, not in any project file. `lazy auth set` stores one in the operating system's keychain or libsecret store, or in a file store when neither exists. The proxy resolves it on each request, outside the task containers. When a change takes effect is covered in [Credentials](../credentials.md).

## How usage limits are read

The proxy keeps only response headers that report rate limits, for example the 5-hour and 7-day windows of a Claude subscription, and the equivalents some other providers send. Anything else in a response's headers is dropped, and a value that looks like a secret is refused. The latest reading per credential is held by the daemon and survives a restart. `lazy stats limits` and `lazy stats budget` show it, and `[usage_pause]` can hold new turns past a threshold. See [Token budgets](../token-budgets.md). A harness whose provider sends no such headers shows no reading.

More: [The daemon, the task container and the proxy](../explanation/daemon-and-proxy.md).
