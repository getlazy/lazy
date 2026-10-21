# lazy diff

This page is generated from `lazy diff --help`.

```text
Usage: lazy diff <task_id> [--full] [--full-branch] [--region <id>] [--turn N|latest] [--lines N..M]

Show changes made by a task relative to its upstream branch.
The diff is always the task's whole branch, including work that accepted
subtasks brought in. Use --region to look at one subtask's share.
Comments added since the last agent turn are shown as virtual diff additions.

Arguments:
  <task_id>        ID of the task

Options:
  --full           Show full diff (default: stat summary)
  --full-branch    No-op, kept for old scripts (the diff is always the whole branch)
  -r, --region <id>  Scope the diff to one review region's files.
                   List regions with: lazy regions <task_id>
  --turn N|latest  Show diff for a specific turn only
  --lines N..M     Return only lines N through M of the output (1-indexed, inclusive)
                   Formats: N..M (range), N.. (from N to end), ..M (start to M)

Examples:
  lazy diff abc123                    # Summary of all changes vs upstream
  lazy diff abc123 --full             # Full diff vs upstream
  lazy diff abc123 --region task:fix-x --full   # Just that region's files
  lazy diff abc123 --turn latest      # Diff for the most recent work turn
  lazy diff abc123 --turn 1           # Diff for turn 1
  lazy diff abc123 --lines 10..50     # Show only lines 10-50 of diff output
  lazy diff abc123 --full --lines 1..100  # First 100 lines of full diff
```
