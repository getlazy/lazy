# lazy system repair-commits

This page is generated from `lazy system repair-commits --help`.

```text
Usage: lazy system repair-commits <task> [--apply]
       lazy system repair-commits --all [--apply]

Fix recorded commit lists that name commits the task never made.

A task's recorded commits should be the commits its own branch carries. An
older version of lazy also recorded everything a merged-in upstream branch
brought with it, which on long-running tasks grew into hundreds of unrelated
commits in `lazy show`, the web Commits tab and search. New turns record
correctly; this repairs what is already stored.

Reports by default and changes nothing. Pass --apply to write the repair.

Options:
  --all        Scan every task instead of one
  --apply      Write the repair (asks for confirmation)
  --yes, -y    Skip the confirmation (required with --apply when non-interactive)
  --json       Machine-readable output

Examples:
  lazy system repair-commits my-task           # What is wrong with this one?
  lazy system repair-commits --all             # What is wrong anywhere?
  lazy system repair-commits --all --apply     # Fix it
```
