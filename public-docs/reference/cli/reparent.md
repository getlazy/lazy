# lazy reparent

This page is generated from `lazy reparent --help`.

```text
Usage: lazy reparent <task_id> --parent <new-parent> [--yes]

Repoint a task to a new parent and merge that parent into the task's branch.

Use this when a task was created on the wrong parent (e.g. branched from main
when it should have been on a release branch). Reparent keeps the task — same
session, same turns, same commits, same branch — and only changes its parent.
It then runs a sync so the task's own agent merges the new parent in, resolving
any conflicts in place.

Arguments:
  <task_id>          Task code or short ID of the task to reparent

Options:
  --parent <target>  New parent: a task code, short ID, or a raw branch
                     name (e.g. main). Required.
  --yes              Skip the confirmation prompt (for non-interactive use)

Notes:
  - The task must not be currently 'working' (wait or interrupt the agent first)
  - Terminal tasks (complete/abandoned) must be reopened first
  - Child tasks are unaffected — they stay based on this task's branch and pick
    up the new parent's changes the next time they sync
  - If the task is already on the requested parent, this is a no-op

Examples:
  lazy reparent fix-auth --parent release-v016
  lazy reparent abc12345 --parent main --yes
```
