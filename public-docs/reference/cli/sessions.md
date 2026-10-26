# lazy sessions

This page is generated from `lazy sessions --help`.

```text
Usage: lazy sessions <task_id> [name] [--lines <n>] [--log-bytes <n>] [--json]

Show who else is in a task and what runs in its own environment. People: the
members with terminals in it, by session name and attached or idle (never what
they run), and whether the agent is running a turn. Sessions: its services
(the "services" session that Start services runs) and any long-running
command, with whether each is running or how it exited, how long it has been
up, and when it last printed. With a session name, print that session's live
screen and the tail of its log instead.

Sessions keep running between the agent's turns and across a restart of lazy.
This only reads them; it starts nothing. To watch or type into one, open the
task's Services tab (Attach, Take control).

Options:
  -n, --lines <n>      Lines of the screen's scrollback to include (default 200)
  --log-bytes <n>      How much of the end of the log to print (default 16 KiB)
  --json               Print the daemon's answer as JSON
```
