# lazy stats limits

This page is generated from `lazy stats limits --help`.

```text
Usage: lazy stats limits [--json]

The latest usage-limit reading per credential, as the lazy proxy saw it on
model API responses: subscription utilization (5-hour and 7-day windows),
API-key rate-limit headroom, and retry-after on refusals. Credentials are
named by who owns them or the variable they come from — never by value.
A credential [usage_pause] in lazy.toml is currently holding is marked PAUSED;
one it is armed for but cannot read a subscription window from is marked
ARMED, NO READING; a window that has reset since its reading is shown as
"reset at <time>" with its old percentage only as history.

"Model providers, last hour" lists each provider or endpoint the proxy
forwarded to (Anthropic, OpenAI, Cursor, a configured endpoint) with its
request count, failures by kind (connection reset, timeout, connect, 5xx,
529 overloaded, 429 rate-limited) and the latest failure — so "is it the
provider or is it lazy?" is answered by looking.

Options:
  --json   Machine-readable: { scope, readings, pause, providerHealth, budget } — every reading with
           its raw headers, windows, overage status and pause verdict, plus
           the [usage_pause] thresholds, override, held tasks and coverage
           (which credentials it is armed for with no reading). Refuses, naming
           the file, while lazy cannot read its saved readings. "budget" is
           the view "lazy stats budget" shows (null with "budgetError" when it
           cannot be built)
```
