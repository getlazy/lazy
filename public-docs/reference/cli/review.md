# lazy review

This page is generated from `lazy review --help`.

```text
Usage: lazy review <task_id> [--yes] [--no-wait] [--model <model>] [--effort <level>] [--override-usage-pause]

Run an agent review of a task's work. The reviewer starts a new session
in the task's container (it does not resume the implementer's conversation),
sweeps the branch for security and data-integrity issues first, then
correctness / tests / incomplete work / style, and prints a structured
report. The task's status is restored afterwards (submitted stays submitted).
Finished tasks (complete / abandoned) are refused.

A review has no time limit. This command waits for it and prints the report;
interrupting the command leaves the review running and its report still lands
as a review turn on the task. Use --no-wait to start one without waiting, and
`lazy stop <task>` to end one you no longer want.

The report lands on the task and nowhere else: lazy does not post reviews
to a pull or merge request. Read it with `lazy show <task>`, on the web
review page, or here when this command waits for it.

The former TUI artifact browser is now `lazy browse`.

Options:
  --yes              Skip the "run a review?" confirmation
  --post             Deprecated no-op — lazy does not post reviews to a PR/MR
  --no-wait          Start the review and return; read the report later with lazy show
  --model <model>    Model for this review only (not written back to the task)
  --effort <level>   Reasoning effort for this review only (low, medium, high, xhigh, max)
  --override-usage-pause Let this review start even though the task's credential is past the
                     usage-pause threshold (used up by that one turn)

Examples:
  lazy review abc123
  lazy review abc123 --yes --effort max
```
