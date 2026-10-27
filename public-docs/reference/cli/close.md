# lazy close

This page is generated from `lazy close --help`.

```text
Usage: lazy close <task_id> [--reason "reason text"] [--yes] [--accept-dirty-worktree] [--end-sessions]

Close a task — stop work and mark it as abandoned.

Arguments:
  <task_id>    ID of the task to close

Options:
  --reason                Reason for closing the task (required)
                          If not provided, $EDITOR will be opened to enter the reason
  --yes, -y               Skip editor prompt (non-interactive mode)
                          Requires --reason or piped stdin
  --accept-dirty-worktree Allow closing even if worktree has uncommitted changes;
                          also aborts a merge left in progress (every commit is kept)
  --end-sessions          End any member's open sessions in the task's environment
                          first (Lazy Teams); without it, the close is refused
                          while they have sessions open

Reason input priority: --reason flag > piped stdin > $EDITOR (interactive)

Notes:
  - Does not require an active session — works on backlog tasks
  - Worktree is removed but the branch is preserved
  - An open PR for the task is closed (no comment is posted)
  - Unfinished subtasks are reparented to this task's parent
  - Task history is preserved
  - Use 'lazy reopen <task_id>' to restore the task later
  - For work you want to reject (the session ends as 'rejected'), use 'lazy reject'
  - By default, uncommitted changes prevent closing (safety check)
  - Use --accept-dirty-worktree to bypass this check when certain

Examples:
  lazy close abc12345 --reason "Superseded by task def67890" --yes
  lazy close abc1 --reason "No longer needed"
  echo "No longer needed" | lazy close abc1 --yes
```
