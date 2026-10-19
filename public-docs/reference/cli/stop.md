# lazy stop

This page is generated from `lazy stop --help`.

```text
Usage: lazy stop <task_id> [--reason "..."] [--yes]

Halt a running task without auto-resume. Records a human turn note and sets
the user-stopped flag so the reconciler will NOT auto-resume the task.

Arguments:
  <task_id>    ID or code of the task to stop (running, or carrying a
               review/ask that is still running on it)

Options:
  --reason "..."  Reason for stopping (default: "Stopping to change direction")
  --yes, -y       Skip the interactive reason prompt and use the default

Reason input priority: --reason flag > piped stdin > interactive prompt > default.

Notes:
  - Running ('working') tasks can be stopped. So can a task carrying a
    `lazy review` or `lazy ask` that is still running on it, whatever its
    status reads — that ends the review or ask only, and restores the status it
    found. For anything else, use `lazy close` or `lazy unblock`.
  - The task transitions to 'blocked' (with a user-stopped gate). Unlike a
    crash, the reconciler will NOT auto-resume — a manual `lazy unblock` is
    required to continue.
  - `lazy unblock` (with or without --message) re-arms auto-resume.

Examples:
  lazy stop abc12345
  lazy stop abc12345 --reason "Wrong approach, will redirect"
  lazy stop abc12345 --yes
  echo "Need to redirect" | lazy stop abc12345
```
