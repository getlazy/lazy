# lazy system machine

This page is generated from `lazy system machine --help`.

```text
Usage: lazy system machine [--logs] [--lines <n>] [--json]
       lazy system machine reset-docker-storage [--yes]

What the project's machine is doing: the container runtime, the port
forwarder (Lazy Teams machines only), the project daemon and its task proxy,
and CPU, memory and disk use. Read-only. Logs are redacted by the daemon.

  --logs        Also print each service's recent log (and dockerd's restart
                history on a Lazy Teams machine)
  --lines <n>   How many log lines per service (default 20 with --logs)
  --json        Machine-readable output (logs included with --logs)

reset-docker-storage  Empty this machine's Docker storage safely (Lazy Teams
                microVMs only): holds dockerd recovery off, stops dockerd and
                containerd, unmounts everything under the data root, removes it
                without crossing mounts, starts dockerd again, narrating each step.
                DELETES every image, container, volume and build cache; builds
                are cold afterwards. Asks first; --yes skips the question.
```
