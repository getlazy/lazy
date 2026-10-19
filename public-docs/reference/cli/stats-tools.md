# lazy stats tools

This page is generated from `lazy stats tools --help`.

```text
Usage: lazy stats tools <task> [--subtree] [--since <duration>] [--limit <n>] [--top <n>] [--json]

Which tool filled a task's context. The lazy proxy folds each forwarded
request's tool calls and their results into the task's own record, so these
cover the task's whole life and nothing expires — the same numbers the task
page's Stats tab shows.

  CALLS      distinct calls to that tool (a call replayed in later requests is
             still one call)
  TOKENS     the size of what that tool's results put into the conversation,
             counted once per call
  SHARE      that tool's share of all attributed result tokens
  PER CALL   average result size over the calls whose size was recorded
  ERRORS     results that came back flagged as errors

TOKENS is context the tool added, NOT a share of the model bill: a request's
usage is one number for the whole request, and a response routinely asks for
several tools at once, so splitting it would be an invention. Results with no
recorded size are reported as not-recorded rather than zero, and results whose
call was never observed are reported as unattributed rather than filed under a
guessed tool name.

--since and --limit ask a different question — what a task's tools cost over a
stretch of time — which only the proxy's bounded, disposable audit trail can
answer. Either flag reads that recent window instead of the task's record, and
the report says so.

Options:
  --subtree            Include every descendant task, at every depth, merging
                       the rows by tool name — what a hub (a release task, a
                       cluster) actually spent, rather than its own few turns
  --since <duration>   Read the proxy's recent audit window instead, limited to
                       records within it (e.g. 30m, 2h, 1d)
  --limit <n>          Max audit records to scan, newest first (default 50000);
                       implies the audit-window reading
  --top <n>            Max tool rows to show (default 20)
  --json               Emit the full rollup as JSON (ignores --top)

Examples:
  lazy stats tools add-proxy           # one task's tools, ranked by tokens added
  lazy stats tools release-v022 --subtree   # the release and everything under it
  lazy stats tools add-proxy --since 2h # the recent audit window instead
  lazy stats tools add-proxy --top 5   # the five heaviest tools
  lazy stats tools add-proxy --json    # machine-readable rollup
```
