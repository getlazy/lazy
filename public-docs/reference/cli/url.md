# lazy url

This page is generated from `lazy url --help`.

```text
Usage: lazy url <task_id> [service]

Show where a task's declared [serve] ports are reachable on this machine.

Arguments:
  <task_id>    ID of the task (prefix matching works)
  [service]    A service name or container port. Prints exactly one bare URL,
               with no labels, so it composes in scripts.

Options:
  --direct     Print the raw http://127.0.0.1:<port> mapping instead of the name

Ports are declared per project in lazy.toml:

  [serve]
  ports = [3000, 5173]        # identity is the port itself

  [serve.services]            # or give them names
  web = 3000
  api = 8080

Each declared port is published to an OS-assigned port on 127.0.0.1 when the
task's container is CREATED, so parallel tasks never collide and nothing is
exposed off this machine. Editing [serve] takes effect the next time the task's
container is created.

The URL printed is a name served by the running daemon:

  http://my-task.web.lazy.localhost:<dashboard port>

It stays the same across container recreates (the 127.0.0.1 port does not), and
each task gets its own cookie jar, so two tasks running the same app no longer
log each other out. Chromium and Firefox resolve *.localhost themselves; the OS
resolver usually does not, and a wildcard cannot go in /etc/hosts — so use
--direct for curl, and for anything that is not a browser.

The list shows liveness per service — ● when a TCP connect to the published
port succeeds (something is listening), ○ when nothing answers yet. The check
never sends a request to the app.

Examples:
  lazy url my-task              # List every service, its URL and liveness
  lazy url my-task web          # Just the web service's URL
  lazy url my-task 3000         # By container port
  open "$(lazy url my-task web)"
  curl "$(lazy url my-task web --direct)"
```
