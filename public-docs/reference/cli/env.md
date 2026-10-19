# lazy env

This page is generated from `lazy env --help`.

```text
Usage: lazy env <subcommand> [options]

Per-task environment variables — give ONE task an API token or endpoint without
exposing it to every other task.

Values are held on this host only, in the daemon's own 0600 state file. They are
never written to task state, turns, prompts, comments, the journal, or any log,
are redacted from debug output, and are deleted when the task reaches a terminal
state. Nothing in lazy will print a value back to you.

For a variable every task should get, use your shell environment or the agent
image instead — this is the per-task granularity.

Subcommands:
  set      Set one or more variables on a task
  list     List a task's variable NAMES (never values)
  unset    Remove named variables from a task
  clear    Remove every variable from a task

Examples:
  lazy env set my-task STRIPE_API_KEY          # prompts for the value, echo off
  lazy env set my-task API_BASE=https://x.test # non-secret value inline
  lazy env set my-task --env-file ./task.env
  lazy env list my-task
  lazy env unset my-task STRIPE_API_KEY

You can also set variables while starting a task:
  lazy start my-task --env STRIPE_API_KEY --env-file ./task.env

Run 'lazy env <subcommand> --help' for details on any subcommand.
```
