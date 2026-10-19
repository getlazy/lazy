# lazy untag

This page is generated from `lazy untag --help`.

```text
Usage: lazy untag <task_id> <tag> [<tag>...]

Remove one or more tags from a task. Untagging is recorded in the task's
append-only tag history — it never erases the earlier tagging event.

Arguments:
  <task_id>    ID or code of the task to untag (can be shortened)
  <tag>        One or more tags to remove.

Examples:
  lazy untag abc12345 onboarding
  lazy untag abc1 launch infra
```
