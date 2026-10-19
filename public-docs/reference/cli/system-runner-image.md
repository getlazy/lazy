# lazy system runner-image

This page is generated from `lazy system runner-image --help`.

```text
Usage: lazy system runner-image [<task>] [--json]
       lazy system runner-image retry
       lazy system runner-image rebuild [--no-cache] [--json]
       lazy system runner-image cancel [--json]
       lazy system runner-image log [-f, --follow] [--build <id>] [--json]
       lazy system runner-image use-project <task>

The project's own runner image ([docker] dockerfile in lazy.toml) is built by
the daemon when it starts. Everything except launching an agent keeps working
meanwhile. Builders start on lazy's default runner image and say so; agents
run on it only after you confirm (--default-image on start, unblock and resume).

Nothing switches back on its own once the project's image is ready.

  <task>        Also show which image that task runs on
  retry         Build the image again, e.g. after fixing a failed build
  rebuild       Build it again even when it is up to date; the current image
                stays in use until the new one succeeds. With no custom image,
                rebuilds lazy's default image from scratch
  --no-cache    With rebuild: refetch everything the Dockerfile pulls
  cancel        Stop the running build (an adoption's, or the project image's)
  log           The build's log with each step's timing; --follow streams it
  --build <id>  With log: a specific build (as named by --json output)
  use-project   Run the task on the project's image again from its next turn
  --json        Machine-readable output
```
