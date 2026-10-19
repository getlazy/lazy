# lazy env set

This page is generated from `lazy env set --help`.

```text
Usage: lazy env set <task_id> KEY=VALUE [KEY=VALUE ...] [--env-file <path>]

Give one task an environment variable. The value is injected into that task's
agent process/container at every launch — start, unblock, sync, and automatic
resumes — and into no other task.

Prefer the bare-KEY form for real secrets:

  lazy env set my-task STRIPE_API_KEY        # prompts, echo off

A value typed as KEY=VALUE is visible in your shell history and, while the
command runs, in the process table to every other user on this machine.

Arguments:
  <task_id>          Task to set the variable on (short hex prefix or task code)
  KEY=VALUE          Variable to set. Repeatable.
  KEY                Variable whose value you will be prompted for (echo off)

Options:
  -f, --env-file <path>  Read KEY=VALUE lines from a dotenv-style file

Storage: values live only on this host, in the daemon's own 0600 state file
(never in the project, never in task state, turns, prompts, or logs), and are
deleted when the task is accepted, rejected, or closed.
```
