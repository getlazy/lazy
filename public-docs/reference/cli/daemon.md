# lazy daemon

This page is generated from `lazy daemon --help`.

```text
Usage: lazy daemon <subcommand> [options]

Manage the lazy daemon process. Each project gets its own daemon.
The daemon serves everything — CLI/agent RPC, MCP, and the web
dashboard — on a single TCP port (default: 26024, loopback-only).

Subcommands:
  start       Start the daemon (includes web dashboard)
  stop        Stop the daemon gracefully
  restart     Restart the daemon
  status      Show daemon status, web dashboard URL, the lazy.toml in force,
              and startup-only settings still pending from it
  reload      Apply the startup-only lazy.toml settings that need no restart
              (dashboard_url, sync_interval); list the ones that do
  health      Check the daemon's moving parts: loops, sweeps, proxy, storage,
              runner, stuck tasks, dashboard (OK / WARN / FAIL per row)
  dashboard-url  Print the web dashboard URL, or exit non-zero if not running
                 (the address only — to SIGN IN, run: lazy dashboard)
  list        List ALL running lazy daemons on this host (marks strays)
  kill-stray  Reap daemons whose project root no longer exists on disk
  logs        Print the daemon log tail; --follow keeps streaming (primary debugging tool)
  auto-budget Control + inspect the auto-react daily budget (list/update/pause/resume)
  config      Inspect + override concurrency caps at runtime (get/set/reset, ephemeral)
  resume-queue  Show the slow-lane auto-resume queue (read-only)

Start options:
  --foreground    Run in foreground (don't detach)
  --background    Run in background (default, explicit flag for auto-start)
  --project PATH  Explicit project root (default: auto-detect from cwd)

status options:
  --json          Print the status as JSON
  --project PATH  Explicit project root (default: auto-detect from cwd)

stop / restart options:
  --yes           Skip the pre-stop confirmation (for non-interactive callers)
  --project PATH  Explicit project root (default: auto-detect from cwd)

Stopping the daemon affects every live session it is responsible for: working
task agents are stopped mid-turn, and live builder and pair sessions keep
running but lose the proxy they reach the model through. stop and restart list
what is running and what happens to each before doing anything; --yes or a
non-TTY still prints the warning but never blocks.

kill-stray options:
  --yes           Skip the confirmation prompt (for non-interactive callers)
  --prune-dirs    Prune orphaned runtime state; preserve stored credentials

The daemon is required for all CLI commands (except init, daemon, and help).
It auto-starts when you run any command. If auto-start fails, start manually.

Examples:
  lazy daemon start             # Start in background
  lazy daemon start --foreground  # Start in foreground (for debugging)
  lazy daemon status            # Check if running, show web URL
  lazy daemon reload            # Apply an edited [server] dashboard_url
  lazy daemon health            # Is everything inside it still working?
  lazy daemon dashboard-url     # Print the web dashboard URL (for scripting)
  lazy dashboard                # Sign in and open the dashboard in a browser
  lazy daemon stop              # Stop gracefully
  lazy daemon restart           # Stop + start
  lazy daemon list              # Show every daemon on the host
  lazy daemon kill-stray        # Reap daemons whose project root was deleted
  lazy daemon kill-stray --yes --prune-dirs  # Non-interactive full cleanup
  lazy daemon auto-budget list  # Inspect today's auto-react budget
  lazy daemon config get        # Show the builder cap + current usage
  lazy daemon config set builders 4  # Change the builder cap (ephemeral)
```
