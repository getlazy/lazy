# Per-task environment variables

This page explains how to give **one** task an API token without exposing it to every other task.

```bash
lazy env set my-task STRIPE_API_KEY          # prompts for the value, echo off
lazy env list my-task                        # names only — never values
lazy env unset my-task STRIPE_API_KEY
lazy env clear my-task

lazy start my-task --env STRIPE_API_KEY      # same thing, at start time
lazy start my-task --env-file ./task.env
```

The variable is injected into that task's agent process (or container) at every
launch, and into no other task's.

## When this is the right tool

Use it when exactly one task needs a credential or endpoint: a task integrating
against a payment sandbox, a task that must call an internal API, a task pointed
at a staging database.

Do **not** use it for something every task should have — that belongs in your
shell environment or in the agent image, where it costs nothing per task. The
whole point of this feature is the granularity: the other tasks don't get it.

Do not use it for large values either. It is capped at 64 variables and 128 KiB
per task; if you need to hand a task a file, mount it with `[[mounts]]`.

## The security model

**Values live on this host only.** They are written to the daemon's own state
directory — `~/.lazy/daemon/<project-slug>/task-env.json`, mode `0600` — and
nowhere else.

That placement is the whole property, and it is the same one the per-task MCP
token already relies on:

- A task's container bind-mounts the project root **read-only**
  (`-v <repo>:<repo>:ro`). Anything under `<project>/.lazy/` is therefore
  readable by *every* agent — which is exactly the separation this feature
  exists to provide. So the values cannot live there.
- The daemon state directory is never mounted into anything: lazy refuses any
  mount source inside it.

**Values never become durable project state.** They do not enter task state,
turns, prompts, comments, the journal, or any log line. This is deliberate and
load-bearing: turns and prompts are durable and human-visible, and a token
leaked into a turn cannot be un-leaked. It is also why the values are not kept
in the project's task store, which can be pushed to an external or shared
store — a task's API token must not travel with the project.

**Nothing prints a value back.** There is no `lazy env get` and no
`--show-values` flag. `lazy env list` prints names only, so its output is safe
to paste into a bug report. Debug output that shows the launch command redacts
the task's own keys by name, whatever they are called — you set them because
they were sensitive, so `STRIPE_SANDBOX` is treated exactly like
`STRIPE_API_KEY`.

**Agents cannot reach this at all.** There is no MCP tool for `lazy env`, for
reads or writes. The agent gets its variable by finding it in `process.env` and
by no other route; it cannot enumerate its task's secret store, and it cannot
hand a token to a subtask it spawned. This is the one place where even a *read*
is withheld from agents — see
[surface-asymmetries.md](surface-asymmetries.md#4-human-only-commands-with-no-mcp-equivalent).

### Keep the value out of your shell history

Prefer the bare-key form:

```bash
lazy env set my-task STRIPE_API_KEY       # prompts, echo off
lazy start my-task --env STRIPE_API_KEY   # same
```

`--env KEY=VALUE` is fine for a non-secret (an endpoint, a feature flag), but a
value typed that way lands in your shell history and, while the command runs, in
the process table where any other user on the machine can read it with `ps`.

Under the Docker runner the value is also visible in `docker inspect` for the
container's lifetime to anyone in the `docker` group on the host — the same
posture as the Anthropic credentials lazy already passes to every task container,
so this is not a new exposure, but it is worth knowing before you hand a
production token to a task.

## Lifetime: set once, cleared when the task ends

A variable is supplied **once** and persists for the task's lifetime. It is
injected at *every* launch — `start`, `unblock`, `sync`, `ask`, and automatic
resumes — and deleted when the task reaches a terminal state (accepted,
rejected, or closed), next to the task's MCP token.

Lazy does not ask for `--env` on every unblock because many launches have no
human in the loop at all — an automatic resume after a crash, for example. Those
launches would carry no value, so the
variable would silently vanish mid-task and the agent would fail in a way that
looks like a bug in your own code.

The cost is that the value sits at rest in a `0600` host file until the
task ends. Clear it early with `lazy env clear <task>` if you want it gone
sooner; you never need to run that at the end of a task, because accept, reject,
and close each clear it for you.

### A running agent keeps the environment it launched with

Docker fixes a container's environment at creation time, and lazy reuses a live
supervisor container across turns. So a change made while a task is `working`
takes effect at the task's **next** launch — typically after the agent
blocks and you unblock it. `lazy env set`/`unset`/`clear` say so when the task is
working.

## Reserved names

Lazy refuses, at the moment you type it, any name it sets itself:

- exactly: `PATH`, `HOME`, `USER`, `SHELL`, `PWD`, `TMPDIR`, `GIT_SSH_COMMAND`,
  `CLAUDECODE`
- any name starting with `LAZY_`, `ANTHROPIC_`, `CLAUDE_`, `CURSOR_`, or `PI_`

These carry the agent's credentials, its model routing, and its connection back
to the daemon. Overriding one would not be "a per-task variable" — it would be a
per-task hijack of where model traffic goes or which credential is used. Names
must also be valid POSIX identifiers (`[A-Za-z_][A-Za-z0-9_]*`).

For belt and braces, the container runner merges the task's variables *after*
lazy's own credential and routing variables are set, so lazy wins on reserved names.

## Env files

`--env-file` reads dotenv-style lines: `KEY=VALUE` one per line, `#` comments
and blank lines ignored, an optional leading `export ` stripped, and surrounding
quotes removed. Everything after the first `=` is the value verbatim.

```
# task.env
STRIPE_API_KEY=sk_test_...
export API_BASE="https://sandbox.example.test"
```

A file you name but that cannot be read is an error, not "no variables" —
launching the agent without the token it was meant to have fails much later and
much more confusingly, as an unexplained 401 inside the container.

## Runner support

Both runners are covered:

- **Docker/Podman** — passed as `-e KEY=VALUE` on `docker run`, before the image
  name.
- **Host process** (`dangerously-host-process-without-any-isolation`) — merged
  into the supervisor process's spawn environment.

## Troubleshooting

**The agent says the variable is not set.** Check `lazy env list <task>` for the
name, then check whether the task was already running when you set it (see
[above](#a-running-agent-keeps-the-environment-it-launched-with)) — the change
lands at the next launch.

**`lazy env set` says the name is reserved.** Pick another name; the reserved
ones are listed above. If you are trying to point a task at a different model
endpoint, that is an [agent
profile](./lazy-toml.md#agentsname--named-agent-profiles) in `lazy.toml` —
declare one with the `endpoint` you want and select it with
`lazy edit --agent <name>` — not this.

**I lost the value.** Lazy cannot give it back to you — by design, nothing reads
a value back out. Re-run `lazy env set`.
