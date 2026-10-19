# lazy describe

This page is generated from `lazy describe --help`.

```text
Usage: lazy describe <task_id> [--yes]

Write a linked task's description from its branch and pull request.

A task created by 'lazy link' adopts someone else's branch, so it starts with
little more than a title. Describing it reads the pull request body, the
comments, the commits and the diff against the base branch, and writes the
task's goal and a prompt saying what the work is, what is already done, what
reviewers asked for, and what is still open.

'lazy link' does this automatically. Run this when that step was skipped or
failed (no model credential, no network), or to refresh the description after
the branch has moved on.

Arguments:
  <task_id>          Task id or code of a linked task

Options:
  --yes              Replace a hand-edited prompt without asking

Notes:
  - Only linked tasks can be described; a task lazy created already has the
    prompt it was started with (change it with 'lazy edit --prompt')
  - If you have edited the prompt yourself since lazy wrote it, this asks
    before replacing it
  - The previous prompt is kept as a prompt version, not overwritten
  - Nothing is written to the linked branch

Examples:
  lazy describe fix-auth
  lazy describe a1b2c3d4

Documentation: https://docs.getlazy.dev/link
```
