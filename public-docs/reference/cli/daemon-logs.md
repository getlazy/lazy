# lazy daemon logs

This page is generated from `lazy daemon logs --help`.

```text
Usage: lazy daemon logs [options] [<task>]

Print the tail of the daemon log file (add -f to follow). Primary debugging tool.

Arguments:
  <task>              Filter log output to lines mentioning this task
                      (by short ID, full ID, or task code)

Options:
  -n, --lines N       Number of lines to show (default: 200)
  -f, --follow        Keep following new log output (default: print and exit)
  --no-follow         Print and exit (the default; accepted for old scripts)
  --project PATH      Explicit project root (default: auto-detect)

Examples:
  lazy daemon logs                    # Last 200 lines, then exit
  lazy daemon logs -n 100             # Last 100 lines, then exit
  lazy daemon logs -f                 # Last 200 lines, then follow
  lazy daemon logs abc12345           # Filter to task abc12345
  lazy daemon logs fix-auth           # Filter to task code fix-auth
  lazy daemon logs -n 200 abc12345    # Last 200 lines for task abc12345
```
