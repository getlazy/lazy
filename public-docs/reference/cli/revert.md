# lazy revert

This page is generated from `lazy revert --help`.

```text
Usage: lazy revert <task_id> [--reason <reason>] [--yes]

Revert an accepted task by creating a revert task.

The revert task will instruct the agent to run `git revert` on the
original task's merge commit and resolve any conflicts.

Arguments:
  <task_id>           ID of the accepted task to revert

Options:
  --reason <reason>   Why the task is being reverted (opens $EDITOR if omitted)
  --yes               Skip interactive prompts

The original task must be:
  - In 'complete' status
  - Have an accepted session
  - Have a findable merge commit on the target branch

After the revert task is created, start it with `lazy start`.
Accept the revert once clean, and you'll be offered to create
a continuation task to redo the work.

Examples:
  lazy revert fix-auth                          # Interactive (opens editor for reason)
  lazy revert fix-auth --reason "Needs more testing"
  lazy revert abc12345 --reason "Broke prod" --yes
```
