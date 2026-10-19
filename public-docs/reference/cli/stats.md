# lazy stats

This page is generated from `lazy stats --help`.

```text
Usage: lazy stats <subcommand>

Read-only analytics over what lazy recorded. Nothing here changes any state.

Subcommands:
  tokens    Token accounting from the proxy audit trail (by role, task and model)
  tools     One task's per-tool breakdown — which tool filled its context
  audit     Browse the proxy audit trail record by record (filters + detail view)
  latency   Time to first token / last token and tokens per second, by model, endpoint and tier
  timings   Recorded request traces, ranked by self time
  limits    Latest usage-limit reading per credential (subscription / rate-limit windows)
  budget    Token budgets: per-window spend and what is left, per harness / task / day

Examples:
  lazy stats tokens                 # totals plus by-role / by-task / by-model
  lazy stats tokens --since 24h     # only the last day
  lazy stats tokens --json          # machine-readable rollup
  lazy stats tools add-proxy        # one task's tools, ranked by tokens added
  lazy stats audit                  # newest proxied requests, one row each
  lazy stats audit --denied         # only requests with a policy denial
  lazy stats timings                # newest traces, ranked by self time
  lazy stats limits                 # how close each credential is to its limits
  lazy stats budget                 # tokens left per window, spend per harness
  lazy stats timings --limit 1 --tree  # newest request plus its span tree
  lazy stats tokens -h              # full options for a subcommand
```
