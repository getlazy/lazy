# lazy watch

This page is generated from `lazy watch --help`.

```text
Usage: lazy watch [<task-code>]

Watch a task in real-time as a unified timeline.

Streams three things as they happen:
  net>   every API request the agent makes through lazy's proxy — the one
         signal that works for EVERY agent (Claude, Cursor, anything else),
         because it watches traffic rather than an agent's output format
  sup>   the supervisor's stdout (pre-turn merges, post-turn check output,
         phase transitions, retries)
  agent  the agent's own JSONL session log, rendered — where the agent
         writes one (Claude does; cursor-agent does not)

A one-line status header shows the current supervisor phase and how long it
has been running; it refreshes every 5 seconds.

Arguments:
  <task-code>    Task to watch (code or short ID). If omitted and only one
                 task is running, watches that task automatically.

Options:
  --traffic      Show ONLY proxy traffic. With no task, that is every task's
                 traffic at once (the firehose).
  --no-traffic   Hide the proxy traffic lines.

Exits when the task leaves 'working' status or you press Ctrl-C.

Examples:
  lazy watch fix-auth      # Watch a specific task
  lazy watch               # Watch the only running task
  lazy watch abc12345      # Watch by short ID
  lazy watch --traffic     # Proxy traffic across every running task
  lazy watch fix-auth --traffic   # Only fix-auth's API requests
```
