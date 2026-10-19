# lazy system offline

This page is generated from `lazy system offline --help`.

```text
Usage: lazy system offline

Enable offline mode for this project. All remote operations (push, fetch,
sync, PR creation) are skipped. Tasks start from local HEAD, accept
performs local squash merge.

This is TEMPORARY: offline mode auto-recovers at the next local midnight, so
you can't get stranded offline after forgetting to come back. The output and
'lazy system status' always show when it expires. Run 'lazy system online' to
restore remote operations sooner.

To stay offline PERMANENTLY (e.g. an air-gapped or Ollama-only project), set
'offline = true' under '[remote]' in lazy.toml instead. That is not subject to
the midnight auto-expiry, and 'lazy system online' will not clear it — remove
the flag from lazy.toml to go back online.

What works offline:
  - Creating and starting tasks
  - Running agents (requires Ollama or local models)
  - Accepting tasks (local squash merge)
  - Reviewing, rejecting, closing tasks

What is deferred:
  - Branch pushing, PR creation, remote sync

Equivalent to: lazy config set offline on

Examples:
  lazy system offline           # Enable temporary offline (auto-recovers at midnight)
  lazy system online            # Restore remote operations now
```
