# lazy dashboard

This page is generated from `lazy dashboard --help`.

```text
Usage: lazy dashboard [options]

Sign in to this project's web dashboard and open it in your browser.

The dashboard needs a signed-in browser session — it lives on the same port as
the daemon's RPC and MCP endpoints, which task containers can reach. This
command asks the daemon for a one-time login link and opens it; the browser
trades the link for a session cookie that lasts 30 days of use.

By default the dashboard is addressed as http://lazy.localhost:<port>, not
127.0.0.1. Task apps started by [serve] are published on 127.0.0.1, and browser
cookies are scoped by hostname and not by port — sharing one would hand a
task's app your dashboard session. A trusted reverse proxy can instead supply
one exact public origin with [server] dashboard_url; other hosts are refused.

Options:
  -p, --print     Print the login URL instead of opening a browser
  --no-open       Same as --print
  --project PATH  Explicit project root (default: auto-detect from cwd)

lazy prints the link instead of opening it whenever a browser cannot be opened:
no terminal, an SSH session, no graphical session, or the opener failing.

The link works ONCE. Run this command again for a new one.

Examples:
  lazy dashboard              # Sign in and open the dashboard
  lazy dashboard --print      # Print the one-time login link
  lazy daemon dashboard-url   # Print the dashboard's plain URL (no sign-in)
```
