# lazy stats budget

This page is generated from `lazy stats budget --help`.

```text
Usage: lazy stats budget [--json]

The token budgets in play. For each credential with a usage-limit reading:
every window's percentage used and reset, the tokens lazy saw spent on that
credential inside the window, and from those an estimate of the tokens (and
typical turns) left before the limit. Then spend over the last 7 days by
harness, by day and by task, from each turn's recorded usage.

Only windows the provider reports a percentage for get an estimate (Claude
subscriptions via their 5-hour / 7-day headers, Codex via its own). Harnesses
with no window reading — Cursor, Pi, or anything without those headers — show
spend only; no budget is invented. Tokens and percentages only, never money.

Options:
  --json   Machine-readable: the same view the lazy_usage_limits MCP tool
           carries under "budget".
```
