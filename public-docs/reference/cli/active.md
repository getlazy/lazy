# lazy active

This page is generated from `lazy active --help`.

```text
Usage: lazy active [<task_id>] [--flat] [--levels <n>] [--follow | -f]

List unfinished tasks that have been started (working, blocked, submitted,
interrupted, ...). Backlog tasks are not shown.

Arguments:
  <task_id>   Optional task ID or code - shows only that task's subtree
              (the task itself and all its descendants)

Options:
  --flat         Show flat list instead of tree structure
  --tree         Show tree structure (default)
  --levels <n>   Show only the first <n> levels of the hierarchy (1-based:
                 1 = top-level tasks only, 2 = those plus their children).
                 Levels are counted from the rows this listing shows, so with
                 a <task_id> filter that task is level 1. Tasks hidden by the
                 limit are counted as "(+N hidden)" on their parent's row.
  --follow, -f   Poll and refresh the display (press Ctrl+C to stop)
  --ids-only     Output only task IDs, one per line (for shell completion)

The tree view shows child tasks indented under their parents.

Examples:
  lazy active                # All active tasks in tree view
  lazy active --levels 1     # Only top-level active tasks (+N hidden per row)
  lazy active release-v020 --levels 2 # That release and its direct children
  lazy active --flat         # Active tasks in flat list
  lazy active --follow       # Live-updating active tasks view
  lazy active release-v020 -f # Live view of one release's subtree
```
