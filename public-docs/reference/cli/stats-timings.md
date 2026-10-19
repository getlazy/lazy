# lazy stats timings

This page is generated from `lazy stats timings --help`.

```text
Usage: lazy stats timings [--since <duration>] [--limit <n>] [--top <n>] [--tree]

Show recorded request traces ranked by SELF TIME — the time a span spent on its
own work, with its children's time removed. For each request you get:

  slowest operations                 leaf spans (no children), by duration
  slowest own work in nested spans   spans with children, by self time

Ranking this way suppresses wrappers: a span that merely awaits one slow child
has almost no self time and drops out, so what's left is where time really
went. Children that run concurrently are counted once (the union of their
intervals), never twice.

Request tracing is always on; there is nothing to enable. Traces are recorded
automatically as you use lazy, and the store is pruned to a bounded size.

Options:
  --since <duration>   Only traces started within this window (e.g. 30m, 2h, 1d)
  --limit <n>          Max traces to show, newest first (default 20)
  --top <n>            Max entries per ranked list (default 10)
  --tree               Also print the full nested span tree per trace

Examples:
  lazy stats timings                   # newest 20 traces, ranked by self time
  lazy stats timings --since 1h        # traces from the last hour
  lazy stats timings --top 5           # shorter lists
  lazy stats timings --limit 1 --tree  # newest request, rankings plus the tree
```
