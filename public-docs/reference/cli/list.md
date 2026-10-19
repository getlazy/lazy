# lazy list

This page is generated from `lazy list --help`.

```text
Usage: lazy list [<task_id>] [--all] [--flat] [--tag <tag>] [--levels <n>]

List all non-terminal tasks (every status except complete and abandoned).

Arguments:
  <task_id>   Optional task ID or code to filter - shows only that task and its descendants

Options:
  --all          Show all tasks including completed/abandoned/closed
  --flat         Show flat list instead of tree structure
  --tree         Show tree structure (default)
  --tag <tag>    Show only tasks carrying this tag (flat list of matches)
  --levels <n>   Show only the first <n> levels of the hierarchy (1-based:
                 1 = top-level tasks only, 2 = those plus their children).
                 Levels are counted from the rows this listing shows, so with
                 a <task_id> filter that task is level 1. Tasks hidden by the
                 limit are counted as "(+N hidden)" on their parent's row.
  --ids-only     Output only task IDs, one per line (for shell completion)

The tree view shows child tasks indented under their parents. Tags are shown
after each task's goal.

Examples:
  lazy list                  # All non-terminal tasks in tree view
  lazy list release-v05      # Only release-v05 task and its descendants
  lazy list --levels 1       # Top-level tasks only, with hidden-child counts
  lazy list release-v05 --levels 2 # That task and its direct children
  lazy list --all            # All tasks including terminal states
  lazy list --tag onboarding # Non-terminal tasks tagged 'onboarding'
  lazy list --all --tag infra # All tasks (incl. terminal) tagged 'infra'
```
