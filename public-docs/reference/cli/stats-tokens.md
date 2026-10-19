# lazy stats tokens

This page is generated from `lazy stats tokens --help`.

```text
Usage: lazy stats tokens [--since <duration>] [--limit <n>] [--top <n>] [--role <role>] [--task <id>] [--subtree] [--json]

Token accounting from the proxy audit trail. The lazy proxy records one audit
record per forwarded request — attributed to a role (builder/agent) and a task
by the per-launch credential lazy issues — with the token usage parsed out of the response. This
command rolls those records up:

  total          requests, and input / output / cache-write / cache-read tokens
  By role        which role burned the tokens (builder vs agent)
  By task        which task burned them
  By model       which wire model served them

Every launch lazy makes routes through the proxy, whatever its harness, profile
or endpoint, so all of it is audited here; a process lazy did not launch is not. Requests that
failed before a response carry no usage and are counted in "requests" but not in
"with usage". A stream the client cancelled or that broke mid-way counts only
the tokens that had arrived (usually input only, or none), and an OpenAI-wire
stream reports usage only when the client asked for it, so totals can undercount.
Cursor requests are recorded without a model or token usage, so Cursor spend is
not in these totals.

Options:
  --since <duration>   Only records within this window (e.g. 30m, 2h, 1d)
  --limit <n>          Max audit records to scan, newest first (default 50000)
  --top <n>            Max rows per breakdown (default 10)
  --role <role>        Only count this role (e.g. agent, builder)
  --task <id>          Only count this task (short-id prefix match)
  --subtree            With --task, also count every descendant at every depth
                       — what a hub (a release task, a cluster) really spent. The
                       By task breakdown then has one row per task in it.
  --json               Emit the full rollup as JSON (ignores --top)

Examples:
  lazy stats tokens                        # everything recorded, ranked breakdowns
  lazy stats tokens --since 24h            # the last day
  lazy stats tokens --role agent --top 20  # agent traffic, 20 rows per breakdown
  lazy stats tokens --task add-proxy       # one task's spend
  lazy stats tokens --task release-v022 --subtree   # that task and everything under it
  lazy stats tokens --json                 # machine-readable rollup
```
