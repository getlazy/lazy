# lazy stats latency

This page is generated from `lazy stats latency --help`.

```text
Usage: lazy stats latency [--since <duration>] [--top <n>] [--task <id>] [--subtree] [--json]
       lazy stats latency --recent [--since <duration>] [--limit <n>] [--top <n>] [--role <role>] [--task <id>] [--subtree] [--json]

How fast the models answered, per endpoint × model (× tier).

By default this reads the per-turn latency rollups lazy keeps in the store, so
--since can reach back as far as you like. Each row has requests, errors
(429 / 4xx / 5xx / network / cancelled) and p5 / p50 / p95 of:

  TTFB    request start → upstream response headers
  TTFT    request start → first content token (a non-streamed reply: its end)
  TTLT    request start → last token (the stream's end)
  TOK/S   output tokens ÷ TTLT, over the whole request

plus the share of agent turn time spent waiting on the model. Percentiles come
from merged histograms and are within about ±16%.

--recent reads the proxy audit trail instead: p50 / p90 by model, endpoint,
endpoint × model (with an errors column) and tier,
but only as far back as the trail is kept ([proxy] audit_retention_days).
For individual requests see `lazy stats audit`.

Options:
  --since <duration>   Only turns (or, with --recent, records) within this window (e.g. 30m, 2h, 30d)
  --top <n>            Max rows per table (default 10)
  --task <id>          Only this task (short-id prefix match)
  --subtree            With --task, also every descendant
  --recent             Read the audit trail (recent, per request) instead of the store
  --limit <n>          With --recent: max audit records to scan, newest first (default 50000)
  --role <role>        With --recent: only this role (e.g. agent, builder)
  --json               Emit the full rollup as JSON (ignores --top)

Examples:
  lazy stats latency --since 30d
  lazy stats latency --task release-v091 --subtree
  lazy stats latency --recent --since 24h
```
