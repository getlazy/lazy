# lazy sync

This page is generated from `lazy sync --help`.

```text
Usage: lazy sync <task_id> [--default-image] [--yes]

Reconcile a task's worktree, by task ID, with everything it is behind — in two
steps, each narrated as it happens.

  1. The task's own branch on origin — if a colleague has pushed commits to
     origin/<task-branch>, they are merged into the worktree first. Skipped
     with a one-line reason when the remote driver is "local", when lazy is
     offline, or when the branch is not on origin yet.
  2. The parent/upstream branch — fetched and merged, as before.

  - Conflicts in either step are resolved by the task's own agent
  - Neither step ever touches or pushes the parent branch
  - If the upstream fetch fails, marks the task for retry (pending_sync)
  - Task must be blocked/conflict/submitted/interrupted (not working)
  - A submitted task stays submitted: the merge changes nothing about its
    open PR, so syncing it does not take it out of the review queue

Global remote sync (detecting external changes, fetching comments, pushing
branches, refreshing PR descriptions) is now handled automatically by the daemon. Start
the daemon with: lazy daemon start

Requirements:
  - Task must have a session and worktree
  - A remote driver must be configured for upstream fetch

Options:
  --default-image    If the merge conflicts while the project's runner image is still
                     building (or failed), resolve it on lazy's default runner image
                     instead of being asked (--yes does too)

Examples:
  lazy sync abc12345   # Merge upstream into task abc12345
```
