# lazy daemon auto-budget

This page is generated from `lazy daemon auto-budget --help`.

```text
Usage: lazy daemon auto-budget <subcommand> [options]

Runtime control + visibility for the daemon's auto-react daily budget.
"Today" resets at LOCAL midnight. The cap override and pause set here are
ephemeral (they reset with the day) — permanent budget sizing lives in
lazy.toml (`[daemon] auto_react_daily_budget`).

Subcommands:
  list                Show today's used/limit, reset countdown, pause state,
                      and the log of what consumed budget today
  update <+N|-N|=N>   Adjust TODAY'S effective cap only (e.g. +50, -20, =100)
  pause               Pause auto-react until local midnight (auto-resumes)
  resume              Clear the pause early

Options:
  --reason <text>     Reason for a pause (used with pause)
  --yes               Skip confirmation prompts (non-interactive use)

Examples:
  lazy daemon auto-budget list           # Show today's budget + activity
  lazy daemon auto-budget update +50     # Raise today's cap by 50
  lazy daemon auto-budget update =100    # Set today's cap to exactly 100
  lazy daemon auto-budget pause          # Pause until midnight
  lazy daemon auto-budget resume         # Resume now
```
