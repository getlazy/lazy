# lazy reopen

This page is generated from `lazy reopen --help`.

```text
Usage: lazy reopen <task_id> [--reason "reason text"]

Reopen a previously abandoned or accepted (complete) task.

Restores the task to 'blocked' status and brings back its branch at the
task's last head: the local branch if it still exists, otherwise the
task's branch on the remote (unless lazy recorded newer work the remote
never received, which is restored instead), otherwise the last commit lazy
recorded for it. If none can be found, reopen refuses and changes nothing — reopen
never starts a task empty (use 'lazy clone' or 'lazy redo' for that).
If the parent moved meanwhile, run 'lazy sync' afterwards.

Arguments:
  <task_id>    ID of the abandoned or complete task to reopen

Options:
  --reason     Reason for reopening (required for complete tasks)
               If not provided for complete tasks, $EDITOR will be opened

Reason input priority: --reason flag > piped stdin > $EDITOR (interactive)

Interactive Mode:
  - For complete tasks without --reason, requires an interactive terminal (TTY)
  - Opens $EDITOR to enter the reopening reason
  - For non-interactive use, provide --reason or pipe via stdin

Notes:
  - Only works on tasks with 'abandoned' or 'complete' status
  - For complete tasks, a reason is required and recorded as a comment
  - Resets the session so the task can receive new feedback
  - For complete tasks, clears the old agent session ID to start fresh
  - After reopening, use 'lazy unblock' to continue (or 'lazy start' for never-started tasks)

Examples:
  lazy reopen abc12345
  lazy reopen def4 --reason "Erroneous acceptance by reconciler bug"
  echo "Need to fix a bug" | lazy reopen abc1
```
