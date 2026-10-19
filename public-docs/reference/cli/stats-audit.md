# lazy stats audit

This page is generated from `lazy stats audit --help`.

```text
Usage: lazy stats audit [<record-id>] [filters] [--limit <n>] [--summary] [--json]

Browse the proxy audit trail one record per proxied request — the record-level
view of the same trail `lazy stats tokens` rolls up. Every request through the
lazy proxy is recorded with its role, task, model, the tool_use/tool_result
blocks it carried, any policy denials applied to the response, and any failover
reroute.

With no record id you get the newest matching records as a table; NOTES flags
the rows worth looking at (DENY, REROUTE, FAIL). Pass a record id — the short
form from the ID column is enough — for the full detail view of one request,
including denied tool calls with the rule that fired and the reason given.

Every launch lazy makes routes through the proxy, whatever its harness, profile
or endpoint, so all of it is audited here; a process lazy did not launch is not.

Limits of what the trail can know: a stream the client cancels or that breaks
mid-way is still recorded, but its tokens are only what had arrived (usually
input only, or none); an OpenAI-wire stream reports usage only when the client
asked for it; a Cursor request is recorded without a model or usage; and a
request that failed before any response has no usage.

Filters (all combine):
  --task <id>          Only this task (short-id prefix match)
  --role <role>        Only this role (agent, builder)
  --model <substr>     Only models whose name contains this
  --since <duration>   Only records within this window (e.g. 30m, 2h, 1d)
  --last <duration>    Synonym for --since
  --denied             Only requests where the policy engine denied a tool_use
  --reroutes           Only requests that failed over to a fallback target
  --errors             Only failed requests (proxy error, or non-2xx upstream)

Options:
  --summary            One row per endpoint × model (× profile and tier, for a tiered profile): requests, errors (429 / 5xx /
                       timeout / cancelled), p50/p90 TTFB, TTFT, TTLT, output tokens/s and
                       input/output tokens — to compare endpoints serving the same model.
                       Covers every matching record (--limit does not apply; --scan does)
  --limit <n>          Max records to show, newest kept (default 20)
  --scan <n>           Max records to read from the trail (default 50,000)
  --json               Emit matching rows as JSON; with a record id, the raw record

Examples:
  lazy stats audit                          # the newest 20 proxied requests
  lazy stats audit --denied                 # every policy denial recorded
  lazy stats audit --task add-audit --last 2h
  lazy stats audit --errors --limit 50      # recent failures, e.g. 401s
  lazy stats audit --summary --since 24h    # compare endpoints per model
  lazy stats audit 3f9a1c2b                 # full detail for one record
  lazy stats audit --reroutes --json        # failovers, machine-readable
```
