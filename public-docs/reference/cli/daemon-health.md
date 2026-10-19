# lazy daemon health

This page is generated from `lazy daemon health --help`.

```text
Usage: lazy daemon health [--json] [--verbose] [--project PATH]

Check whether the running daemon's moving parts are alive — the things that can
stop working without the daemon itself crashing:

  Daemon      version, uptime, and whether it runs this CLI's build
  Loops       the reconcile, sync-retry and remote-sync loops are completing ticks
  Sweeps      each reconciler sweep's last run, duration and last error
  Proxy       it answers a self-check request (spends nothing), audit log writable
  Storage     who holds the storage lock, whether writes are completing
  Runner      docker/podman (or the host agent) reachable, container image present
  Tasks       working tasks with no live run, held syncs, interrupted tasks
              nothing will resume
  Dashboard   bound, and on which addresses

Each row is OK, WARN or FAIL with a one-line reason; WARN and FAIL rows say
what to do. Rows print as each check completes. Never starts a daemon.

Options:
  --json          Print the full report as JSON (for scripts)
  -v, --verbose   List every sweep, not only the ones that are not OK
  --project PATH  Explicit project root (default: auto-detect from cwd)

Exit status: 1 when any row FAILs (or no daemon is running), 0 otherwise.

Examples:
  lazy daemon health
  lazy daemon health --json | jq '.rows[] | select(.state != "ok")'
```
