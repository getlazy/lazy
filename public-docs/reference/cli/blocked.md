# lazy blocked

This page is generated from `lazy blocked --help`.

```text
Usage: lazy blocked [--flat] [--tag <tag>] [--levels <n>]

List tasks waiting on a person: blocked, conflict or submitted.

Options:
  --flat         Show flat list instead of tree structure
  --tree         Show tree structure (default)
  --tag <tag>    Show only blocked tasks carrying this tag (flat list of matches)
  --levels <n>   Show only the first <n> levels of the hierarchy (1-based:
                 1 = top-level blocked tasks only, 2 = those plus their
                 children). Levels are counted from the rows this listing
                 shows; tasks hidden by the limit are counted as "(+N hidden)"
                 on their parent's row.

The tree view shows child tasks indented under their parents. Tags are shown
after each task's goal.

Examples:
  lazy blocked                 # Blocked tasks in tree view
  lazy blocked --levels 1      # Only top-level blocked tasks
  lazy blocked --flat          # Blocked tasks in flat list
  lazy blocked --tag onboarding # Blocked tasks tagged 'onboarding'
```
