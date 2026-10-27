# lazy reject

This page is generated from `lazy reject --help`.

```text
Usage: lazy reject <task_id> [--reason "..."] [--yes] [--accept-dirty-worktree] [--end-sessions]

Reject a task's work and close its PR, if it has one (no comment is posted).

Arguments:
  <task_id>    ID of the task to reject

Options:
  --reason "..."          Provide rejection reason inline instead of opening editor
  --yes, -y               Skip confirmation prompt
  --accept-dirty-worktree Allow rejecting even if worktree has uncommitted changes;
                          also aborts a merge left in progress (every commit is kept)
  --end-sessions          End any member's open sessions in the task's environment
                          first (Lazy Teams); without it, the reject is refused
                          while they have sessions open

Reason input priority: --reason flag > piped stdin > $EDITOR (interactive)

Notes:
  - Requires an active session. For tasks that haven't been worked on, use 'lazy close'.
  - The task's session ends with outcome 'rejected'
  - The PR is closed without a review or comment; the reason stays on the task
  - Worktree is removed; branch and task history are preserved
  - Task is marked as 'abandoned'
  - Use 'lazy reopen <task_id>' to restore the task later
  - By default, uncommitted changes prevent rejection (safety check)
  - Use --accept-dirty-worktree to bypass this check when certain

Examples:
  lazy reject abc12345 --reason "Incorrect approach, needs redesign" --yes
  lazy reject abc1 --reason "Bad approach"
  echo "Bad approach" | lazy reject abc1 --yes
```
