# lazy regions

This page is generated from `lazy regions --help`.

```text
Usage: lazy regions <task_id> [--region <id>] [--depth <n>|--all] [--files] [--json]
       lazy regions <task_id> --region <id> [--name <text>] [--owner <who>] [--sign-off | --unsign]

Show a task's review regions — the walkthrough it filed with its report
(presentation.groups), with an "Other changes" region for anything no group
claimed. A walkthrough is authored on every park that faces a human, not only
on a task declared done, and re-authored only once the branch has moved past
the one on record.

A task with LANDED subtasks is presented by them instead: a map derived from
its children, one region per accepted child. Nobody writes that one, and it
says so.

Regions are a PARTITION: every file in the review belongs to exactly one
region, so the file counts add up to the size of the change and signing one
off means something. A file several groups reference is owned by the group
that claimed it whole; the others may quote it as a snippet, which names the
owner alongside it as having also touched it.

Regions keep the order the agent's walkthrough declared them in — that order
is the story to review by — and form a TREE: the top-level groups by default,
then --region <id> to open one and see what is inside it.

Regions come from the task's own report, or from its children. A git-derived
carve is the agents' authoring hint (the MCP tool's provenance flag); the
human surface has no flag for it, because the thing a review navigates by is
the walkthrough, not the carve.

Arguments:
  <task_id>        ID of the task

Options:
  -r, --region <id>  Show one region in detail (a task code or a full region id)
  --files            With --region, list the region's files
  --depth <n>        Show regions down to depth n (default 0: top level only)
  --all              Show every region at every depth
  --name <text>      Name a region (survives every recompute)
  --owner <who>      Say who this region is to review; empty string clears it
  --sign-off         Record a sign-off for a region, against its current content
  --unsign           Withdraw a region's sign-off
  --json             Machine-readable output

Examples:
  lazy regions release-v022                     # the walkthrough's top-level groups
  lazy regions release-v022 -r fix-timings      # that region, and what is inside it
  lazy regions release-v022 --all               # every region, however deep
  lazy regions release-v022 -r fix-timings --files
  lazy diff release-v022 --region fix-timings --full
  lazy regions release-v022 -r fix-timings --owner ierceg
  lazy regions release-v022 -r fix-timings --sign-off
```
