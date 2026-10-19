# lazy raised

This page is generated from `lazy raised --help`.

```text
Usage: lazy raised [subcommand] [options]

Everything agents raised for a human, across every task — one queue, one flag.

A BLOCKING item is a question or decision about its task's own scope or diff:
it gates `lazy accept` until it is responded to, promoted, dismissed, or acknowledged. A
NON-BLOCKING item is an orthogonal proposal or an FYI and never gates. The flag
is the agent's opening judgement, not the last word — correct it with
`lazy raised blocking`.

Subcommands:
  list                    Cross-task queue with filters and recurrences
                          (the default — a bare `lazy raised` lists)
  respond <task> <id> <text>
                          Answer the agent; rides the next unblock
  acknowledge <task> <id> [--note "..."]
                          Noted, maybe later (ack is an alias)
  dismiss <task> <id> [--reason "..."]
                          Won't pursue
  promote <task> <id> [--subtask|--peer] [--goal "..."] [--code <code>]
                          Create a backlog task from it (never auto-starts)
  blocking <task> <id> <true|false>
                          Change whether it gates accept

List options:
  -b, --blocking          Only items that gate accept
      --non-blocking      Only items that never gate
  -s, --status <filter>   Originating task status: terminal, non-terminal,
                          complete-only, or a specific status (working, blocked…)
  -q, --query <text>      Case-insensitive substring on the item body
      --min-age <days>    Only items at least N days old
      --min-recurrence <n>
                          Only items recurring at least N times (default 2 with -r)
  -r, --recurring-only    Show recurrences only (no per-item rows)
      --all               Include resolved items (default: open only)
      --sort <field>      age | recurrence | task (default age; recurrence with -r)
      --order <dir>       asc | desc (default desc)
      --limit <n>         Max rows after sort
      --offset <n>        Skip rows after sort

Promote options:
      --subtask           Child of the originating task
      --peer              Sibling of the originating task (default)
  -g, --goal "..."        Goal (default: the item's title or first sentence)
  -c, --code <code>       Task code (default: the agent's proposed code, else derived)
  -p, --prompt "..."      Prompt override (default: the item's body + provenance)
      --parent <task>     Parent override

Examples:
  lazy raised
  lazy raised --blocking
  lazy raised --status complete-only --min-age 7
  lazy raised -r
  lazy raised respond abc12345 a1b2c3d4 "ship option 2"
  lazy raised dismiss abc12345 a1b2c3d4 --reason "out of scope"
  lazy raised promote abc12345 a1b2c3d4 --subtask --code fix-retry-helper
  lazy raised blocking abc12345 a1b2c3d4 false

Documentation: https://docs.getlazy.dev/raised-items
```
