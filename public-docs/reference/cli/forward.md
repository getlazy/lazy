# lazy forward

This page is generated from `lazy forward --help`.

```text
Usage: lazy forward <task_id> <port> [<port> ...]

Reach a port inside a running task's container from this machine, for as long as
this command runs. Ctrl-C stops it and leaves nothing behind.

Arguments:
  <task_id>    ID of the task (prefix matching works)
  <port>       <host-port>:<container-port>, e.g. 8080:3000 — listen on host
               port 8080 and forward into the container's port 3000.
               Or just <container-port>, e.g. 3000, to have a free host port
               assigned. The resolved address is printed either way.

Listeners are bound on 127.0.0.1 only — a forwarded port is never
exposed to the network this machine is on.

This is the ad-hoc counterpart to [serve] and `lazy url`, which publish a
project's declared ports permanently when a task's container is created. Use
[serve] for the ports a project always serves on; use `lazy forward` for the
one-off look at a database, a debug server, or a port you did not declare.
A running container's published ports cannot be changed, which is why this
forwards host-side instead.

The task's container must already be running with something listening on the
port — this command never starts a container, because a fresh one would have
nothing in it yet. Bring it up with `lazy shell <task>` first.

Examples:
  lazy forward my-task 3000              # container 3000 -> an assigned host port
  lazy forward my-task 8080:3000         # container 3000 -> 127.0.0.1:8080
  lazy forward my-task 8080:3000 5433:5432
  lazy forward my-task 5432              # poke at the task's database
```
