# lazy daemon reload

This page is generated from `lazy daemon reload --help`.

```text
Usage: lazy daemon reload [--json] [--project PATH]

Re-read the lazy.toml the daemon is using and apply the startup-only settings
that can change without a restart — [server] dashboard_url (links, sign-in and
`lazy dashboard` use the new address) and [server] sync_interval. Running
turns are never interrupted.

Settings that need a restart (ports, bind addresses, the proxy, storage, …) are
listed and left unchanged; apply them with `lazy daemon restart`. Everything
else in lazy.toml is read on each use and needs neither.

A lazy.toml that does not load is refused with its error, and the daemon keeps
its running config. `lazy daemon status` shows which file is in force.

Options:
  --json          Print the result as JSON
  --project PATH  Explicit project root (default: auto-detect from cwd)
```
