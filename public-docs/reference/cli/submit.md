# lazy submit

This page is generated from `lazy submit --help`.

```text
Usage: lazy submit <task_id> [options]

Submit a task for review by creating or updating a pull request.

Arguments:
  <task_id>    ID of the task to submit

Options:
  -y, --yes    Skip the confirmation prompt

Behavior:
  - Pushes the task branch to the remote
  - Creates a PR (or updates an existing one) and marks it ready for review
  - Transitions the task from blocked/conflict to submitted
  - Only submitted tasks receive PR comment auto-react (review feedback)

Pre-conditions:
  - Task must be in blocked or conflict status
  - Task must have at least one commit (non-empty diff)
  - A remote driver must be configured (e.g., [remote] driver = "github" in lazy.toml)
    (a repository Lazy Teams hosts has no pull requests: review happens in
    Teams, and accept pushes the target branch to origin)

Notes:
  - A subtask integrates into its parent task's branch, and lazy never opens
    a PR for it on its own. Submitting one explicitly opens the PR against
    the parent's branch, which must already be on the remote (submit never
    pushes it). Accept still merges locally, then closes the PR
  - An open PR you opened by hand for the task's branch is adopted rather
    than duplicated, as long as it targets the task's target branch
  - Until submit, the branch is pushed by daemon auto-push and CI runs,
    but there is no PR and no review comments. With
    [remote] <driver>_auto_push = false there is no automatic push either,
    and submit is the first thing to publish the branch
  - Use 'lazy accept <task_id>' to merge after review
  - Use 'lazy unblock <task_id>' to send feedback and return to working
  - Protected targets get a yes/no prompt (default No). Unprotected or
    unknown targets require typing the target branch or the task code.
  - --yes skips the prompt; MCP has no equivalent (confirmation_code instead)

Examples:
  lazy submit abc12345          # Submit task for review
  lazy submit fix-auth --yes    # Submit by task code, skip confirmation
```
