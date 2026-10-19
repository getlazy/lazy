# lazy daemon logs

This page is generated from `lazy daemon logs --help`.

```text
Usage: lazy daemon logs [options] [<task>]

Tail the daemon log file. Primary debugging tool.

Arguments:
  <task>              Filter log output to lines mentioning this task
                      (by short ID, full ID, or task code)

Options:
  -n, --lines N       Number of lines to show (default: 50)
  -f, --follow        Follow log output (default, can be explicit)
  --no-follow         Show recent lines and exit
  --project PATH      Explicit project root (default: auto-detect)

Examples:
  lazy daemon logs                    # Tail daemon log (last 50 lines + follow)
  lazy daemon logs -n 100             # Show last 100 lines + follow
  lazy daemon logs --no-follow        # Show last 50 lines and exit
  lazy daemon logs abc12345           # Filter to task abc12345
  lazy daemon logs fix-auth           # Filter to task code fix-auth
  lazy daemon logs -n 200 abc12345    # Last 200 lines for task abc12345
```
