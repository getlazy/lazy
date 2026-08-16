# Troubleshooting

Start here when a lazy command fails before it does any work. Most of these
have a one-line fix, and `lazy doctor` diagnoses all of them in one pass:

```
lazy doctor
```

`lazy doctor` is the single diagnosis surface — every check prints what failed,
why, and the command that fixes it. The sections below expand on the failures
users hit most often.

## The daemon won't start

Lazy needs its daemon: it owns task state, storage and the agent runner, and
every CLI command is a client of it. The CLI auto-starts one when it isn't
already running, and reports the failure rather than proceeding when it can't:

```
Error: <what the daemon reported>
```

The daemon writes the same message, with a timestamp, to its log. Find the log
path with `lazy daemon status`, and read it with:

```
lazy daemon logs
```

The common causes, in rough order of frequency:

- **`lazy.toml` doesn't parse or has an invalid value.** See
  [lazy.toml won't parse](#lazytoml-wont-parse) below.
- **No model credential in the daemon's environment.** See
  [No model credential](#no-model-credential) below.
- **The runner isn't available** — Docker or Podman isn't installed or isn't
  running. `lazy doctor` names which, and
  [the agent container guide](./agent-container.md) covers the image itself.
- **A port is already taken** — usually a previous daemon that didn't exit.
  `lazy daemon list` shows every daemon on the host and
  `lazy daemon kill-stray` reaps the ones that no longer belong to a project.
- **The proxy can't bind or reach its upstream.** The audit/policy proxy is on
  by default; the daemon fails loudly rather than silently sending traffic
  direct. Fix the `[proxy]` settings, or set `[proxy] enabled = false` to go
  back to direct connections.

`lazy doctor` deliberately keeps working when the daemon does not — it is the
one command that must never die of the problem it exists to diagnose.

## "Daemon is not running" while a daemon clearly is

Every so often the daemon is up — the web dashboard answers, agents keep
working — but `lazy daemon status` insists it isn't running, and
`lazy daemon start` then fails because the running daemon still holds the
storage lock. There is a specific cause: the daemon's PID and socket files
(`lazy.pid`, `lazy.sock` in the daemon's state directory) were deleted while it
was running.

That mattered because a unix socket file exists only while its listener holds
it, so you cannot put one back by hand. The daemon now notices and repairs both
files itself within a few seconds. `lazy doctor` reports the state in these
terms — naming the live daemon's PID, recovered from the lock file — instead of
repeating "daemon is not running":

```
lazy doctor
```

If the report persists across re-runs, that daemon is running code from before
the self-repair existed, and `lazy daemon restart` clears it — bearing in mind
that a restart interrupts running agent and pair sessions.

Deleting those files is not something lazy does to itself any more: cleanup of
daemon state files now refuses to run while a live process holds the daemon
lock, so a `lazy daemon start` that loses the race can no longer take the
incumbent's files with it.

## What stopping the daemon costs

`lazy daemon stop` and `lazy daemon restart` list what is live before they act,
and — at a terminal — ask before going ahead. The three classes are affected
differently, so they are reported separately rather than as one count:

- **Working task agents** are stopped with the daemon. The in-flight turn is
  lost (committed work is kept) and the task resumes from its last checkpoint
  once a daemon is running again.
- **Builder sessions** (`lazy builder`) are *not* stopped and *not* resumed.
  They keep running, but they reach the model through the daemon's proxy, which
  dies with it — and a restart binds a new proxy port a live builder never picks
  up. Exit and relaunch each builder afterwards.
- **Pair sessions** are not stopped either, and nothing resumes them: the task
  stays locked in `pairing` until you exit the session.

Two things cannot be enumerated yet and are named as such in the warning rather
than silently omitted: a `lazy pair` started outside a task (on main), and
builder sessions on the host-process runner, which have no pidfile.

A daemon that has wedged is the most common reason to stop one, so the warning
is built to survive it: each lookup is bounded separately, one that fails or
hangs never hides the others, and the report says which part it could not read
and why — an unreachable daemon, an error it replied with, or a lookup that
timed out. The proxy consequence is stated from your `[proxy]` setting rather
than from asking the daemon, so it still appears when the daemon cannot answer.

`--yes` — and any non-interactive invocation, where there is no TTY to ask —
still prints the warning but never blocks; scripts are not held up. Nothing
about what stopping *does* changed; this is only the courtesy of saying so
first, the same one `lazy upgrade` already had.

## lazy.toml won't parse

A `lazy.toml` that exists but cannot be read is always a hard error, never a
silent fallback to defaults: running with settings you didn't write is worse
than not running. The message names the file and the parse error.

The same applies to a value that parses as TOML but isn't usable — an unknown
effort level, a port outside 1–65535, a malformed `[docs] url`. Each is
reported with the section, the key, and the accepted values.

`lazy doctor` also lists **unknown** sections and keys — typos and options left
over from older versions. Those are warnings, not errors: lazy ignores them.

The full key-by-key reference is [lazy.toml](./lazy-toml.md).

## No model credential

The daemon — not your shell — is what launches agents, so the credential has to
be in the **daemon's** environment. Set one and restart it:

```
claude setup-token
export CLAUDE_CODE_OAUTH_TOKEN=…      # or ANTHROPIC_API_KEY
lazy daemon restart
```

`lazy doctor` reports which credential it found and whose environment it came
from, saying so explicitly when it had to fall back to your shell's because the
daemon couldn't be asked.

## `lazy pair` or `lazy chat` asks me to `/login`

Interactive sessions take their credential from the **daemon**, exactly like
task agents do — not from the shell you typed the command in. If you see a
`/login` prompt, the daemon is the thing to look at:

```
lazy daemon status
lazy doctor
```

Restart the daemon from a shell that has the credential exported
(`lazy daemon restart`) and the next `lazy pair` picks it up.

Your shell is deliberately not consulted, even when it does export a token. That
used to be the fallback, and it was the cause of this symptom rather than a cure:
a terminal opened after the daemon started — which is what an upgrade leaves you
with — exports nothing, so pairing handed Claude Code no credential at all and
Claude Code fell through to your host login or to a `/login` prompt, while task
agents kept running fine on the daemon's token. Sourcing both from one place
makes pairing behave like the rest of lazy.

If you *want* a session on your own login instead of the daemon's, type `/login`
inside it. That override still works and still persists — it is now the explicit
way to get the behavior that used to happen invisibly.

When no credential can be resolved at all, `lazy pair` and `lazy chat` now fail
**before** launching Claude Code, naming what they checked — rather than opening
a session that looks fine until a `/login` prompt appears minutes later.

## `gh` isn't logged into my GitHub Enterprise Server host

```
✗ GitHub authentication (github.mycorp.com)
  gh is not authenticated to github.mycorp.com, the host of remote 'origin'. Run: gh auth login --hostname github.mycorp.com
```

`gh` keeps a **separate login per host**. Being logged into github.com tells it
nothing about an Enterprise install, so lazy would push and open PRs against a
host `gh` has no token for — surfacing much later as an opaque `gh` error in the
middle of an accept.

`lazy doctor` names the host the check ran against, taken from the git remote
lazy is configured to use (`[remote] git_remote`, default `origin`). Log in to
exactly that host:

```
gh auth login --hostname github.mycorp.com
lazy doctor
```

Scoping carries down to the token as well: the token-scope warning below the
auth check reports on *that host's* token, so a broad github.com token no
longer taints a minimal Enterprise one, or the reverse.

If the check names a host that is **not** a GitHub install at all, doctor says so
on the next line —

```
✓ Git remote origin
  ! Remote points to git@gitlab.mycorp.com:team/app.git, which does not appear to be GitHub
```

— and no amount of `gh auth login` will help: `[remote] driver` is set to
`"github"` for a remote that belongs to another forge. Fix the driver (or the
remote) instead. See
[GitHub Enterprise Server](./lazy-toml.md#github-enterprise-server).

This works in both directions. A `github.com` remote is pinned to `github.com`
just as an Enterprise remote is pinned to its own host, so being logged into an
Enterprise install no longer makes a `github.com` remote read green either. A
dot-com report is worded exactly as it always has been — no host in the label,
and the terse `Run: gh auth login` — since there is only one host it could
mean:

```
✗ GitHub authentication
  Run: gh auth login
```

## Every command fails to acquire the storage lock

```
Error: Failed to acquire storage lock after 50 attempts. Lock file: …/.storage-lock
       — held by process pid 1433 since … (/System/…/postersyncd)
```

Lazy serialises writes to its store with a lock file that records who holds it.
If the holder dies without releasing it — a crash, a `kill -9`, an upgrade
mid-write — the file is left behind, and the next command reclaims it once it
can see the holder is gone.

The holder is identified by more than its pid: lazy records the process's start
time when it takes the lock and compares it before believing anyone still holds
it. Pids get recycled, and a recycled pid used to read as a live holder forever
— which is what the message above shows, an unrelated system daemon that
inherited the dead holder's pid. Lazy now reclaims such a lock automatically,
and says plainly when a holder cannot be a lazy process.

If a lock is left that lazy cannot judge on its own, `lazy doctor` reports it
and offers to clear it — it does this before any of its other checks, so it
still works when every other command is blocked:

```
lazy doctor            # asks first
lazy doctor --yes      # clears it without asking
lazy doctor --dry-run  # only says what it would remove
```

Removing the lock by hand (`rm …/.storage-lock`) is safe **only** when no lazy
process is running. If one is, wait for it instead — the path in the message is
the store's, so a shared or misconfigured `[storage] external_path` can also
mean two projects are contending for one lock.

### When the daemon holds the lock

This is the normal state of every healthy install, not a problem. The daemon is
the store's single writer: it takes the storage lock when it starts and holds it
until it stops. Doctor says so and runs every check as usual — it reads task
state *through* the daemon, so the lock is no obstacle:

```
✓ Storage lock held by the daemon (pid 5294, as designed)
```

Doctor confirms two things before it says that: the holder pid is the daemon's
own (from its lock and PID files), and the daemon actually answers a real
storage read within a few seconds. A daemon that holds the lock but does not
answer is a failure, and doctor reports it as one:

```
✗ Daemon holds the storage lock but is not serving storage
  … it did not answer a storage read within 3000ms.
```

Then the checks that read task state are named as skipped, and the remedy is
`lazy daemon status` / `lazy daemon restart` — never deleting the lock file,
which would admit a second writer while the daemon still lives.

### When the holder is alive but never lets go

A lock whose holder verifies as the process that took it is *not* stale, so
lazy will not reclaim it — that would corrupt the store. A hung lazy process
therefore blocks every command in the project for as long as it lives.

`lazy doctor` looks at the lock instead of queueing behind it, and always
finishes:

```
✓ Storage lock available
  ! The storage lock is held by pid 5294 (…), taken 3s ago … — the store is busy.

✗ Storage lock is wedged
  The storage lock has been held by pid 5294 (…), taken 14m ago — one storage
  operation, for longer than any real one takes.
```

Both of those describe a holder that is *not* the daemon — some other lazy
process taking the lock for one operation. Such a lock is normally held for
milliseconds, so doctor warns while it is fresh and calls it *wedged* once one
acquire has outlived a minute. The checks that read task state are reported as
skipped rather than run, and every other check in the report is unaffected.

The remedy is aimed at the process, not the file: find out what pid it names
(`lazy daemon status`, `ps -p <pid>`) and stop it if it is hung, then re-run
`lazy doctor`. Deleting the lock file while its holder is alive lets a second
writer into the store.

If the lock file does not record a readable acquire time — it was truncated
mid-write, or written by a lazy old enough not to record one — doctor cannot
tell busy from wedged, so it fails rather than warns:

```
✗ Storage lock age is unreadable
  The storage lock is held by pid 5294 (…), unchanged for the whole 1500ms probe,
  but …/.storage-lock does not record a readable acquired_at.
```

A warning would be the wrong call there: the damaged timestamp is on disk, so
every later run would read the same unreadable value and stay quiet while the
lock is held forever. The remedy is the same — go look at the process the
message names.

Only `lazy doctor` fails fast like this. Every other command keeps queueing on
a contended lock, which is what you want from a command that has work to do.

## "Could not register the lazy MCP tools … refusing to run it"

A turn failed before the agent started, with something like:

```
Could not register the lazy MCP tools for task 0c4623c0, so this turn would have
run with NO lazy_* tools at all — refusing to run it.
  Container/host: 2ab3ca200fdf
  Turn scope: write
  Cause: LAZY_DAEMON_CONFIG not set. The daemon must provide MCP config when launching containers.
```

That is deliberate. An agent without `lazy_*` tools cannot read task history,
record follow-ups, commit through lazy, or reach any lazy state — it would do
the work with the wrong picture and no way to say so. Until v0.21 this was
swallowed and the turn ran anyway; the only trace was a warn line inside the
container, which is why one such turn went undiagnosed for days.

The message names everything you need:

- **Container/host** — inside a container this is the container id, so
  `docker logs <id>` reaches the right one.
- **Cause** — `LAZY_DAEMON_CONFIG not set` means the container was launched
  without daemon config. `LAZY_DAEMON_CONFIG` comes from the launch argv, so it
  cannot be repaired inside a running container: the next relaunch supplies it.

Check the daemon is up (`lazy daemon status`), then resume the task — the
relaunch fixes the common case. `lazy doctor` reports launch-path problems.
Any other cause (`EACCES`, `EISDIR`, `ENOSPC`) is a filesystem problem where the
agent's `~/.claude.json` is written.

## `claude mcp list` says "✔ Connected" but the agent has no tools

You bashed into the agent container, ran `claude mcp list`, and got:

```
lazy: lazy-agent mcp --daemon-config /…/daemon-mcp-lazy-my-task.json --task-id … - ✔ Connected
```

…while the agent in that same container was failing every call with
`No such tool available: lazy_status`.

Both things are true at once, because **`mcp list` does not check what you think
it checks**. It starts the server, sends `initialize`, and prints "✔ Connected"
if it gets an answer. It never prints a tool count, and it never looks at the
agent's own process. Three quite different states all render identically:

- the server is healthy and the agent has every tool (the normal case);
- the server starts, answers `initialize`, and registers **zero** tools;
- the server is fine and **Claude Code never loaded it** into the agent process.

So "✔ Connected" is not evidence that the wiring works, and it should never end
an investigation.

### Run `lazy doctor <task-id>` from the host

`lazy doctor <task-id>` runs its usual task checks and then runs `lazy-agent
doctor` inside that task's container, passing the output straight through — so
you never have to find the container name yourself:

```bash
lazy doctor my-task
```

The container section is skipped, with the reason printed, when there is no live
container to enter: the agent only exists while a turn is running, and the MCP
config being diagnosed is written per turn. A skip is never counted as a pass.
Add `--probe-agent` to forward that flag to the in-container doctor (see below).

If you are already in the container — or the task's run is gone and you are
inspecting a fresh one — run it directly, with no arguments:

```bash
docker exec -it <container> bash
lazy-agent doctor
```

It walks the whole chain and marks each link, exiting non-zero if any fails:

1. **`LAZY_DAEMON_CONFIG`** — set, mounted, readable, parseable; reports the
   project root, task id and daemon target. The bearer token is never printed.
2. **`~/.claude.json`** — is there a `lazy` server entry, does its command
   resolve on `PATH`, does its `--daemon-config` path exist in this container,
   and does its `--task-id` match this container's task (a mismatch is a stale
   entry from a previous task).
3. **`~/.claude/settings.json`** — how many `mcp__lazy__*` entries are allowed.
4. **Read-only (ask) mode** — on or off, and how many tools that implies. Ask
   turns legitimately get a smaller set; this tells you which count is healthy.
5. **Live MCP self-test** — spawns the server with exactly the argv from
   `~/.claude.json`, drives `initialize` + `tools/list`, and prints the actual
   **tool count and names**. This is the check `mcp list` cannot do.
6. **Daemon round-trip** — calls one read-only tool (`lazy_status`) for real.
   This separates "the server starts" from "the server can reach the daemon",
   and exercises the config mount, the token and the host route end to end.

Add `--probe-agent` to also start a real `claude` process (`claude -p 'ok'`),
read only its first stream-json line, and report which MCP servers and
`mcp__lazy__*` tools **Claude Code itself** loaded, then kill it. That is the
only check that observes the agent's own process, which is why it is opt-in —
it starts a real agent process. `--json` gives machine-readable output.

Reading the result: if the self-test lists tools but `--probe-agent` shows none,
the server is fine and Claude Code is not loading it. If the self-test lists
zero tools, the server itself came up empty. If the round-trip fails with a
401/403, the token or task id is stale (checks 1 and 2); if it fails to connect,
the daemon is down or its target is not routable from the container.

### Turns now catch this by themselves

Since v0.21 you usually will not have to run any of this. Claude Code reports
the MCP servers and tools it loaded on the first line of its own stream, and the
supervisor checks that line: a turn that provably started with **no** lazy tools
is killed immediately and fails with a message naming what was observed, rather
than running blind to completion. Such a turn is never retried — a relaunch with
the same config cannot conjure tools.

Two deliberate limits on that check:

- It fails only on **positive evidence of zero**. An agent that reports nothing
  about its tools (an older or future release, a different agent) leaves the
  turn alone. Absence of evidence is not evidence of absence.
- It asserts **at least one** lazy tool, not the full set, because read-only
  ask turns legitimately receive fewer.

What was observed is recorded on the turn, so `lazy show` can answer "did that
turn have its tools?" long after the container is gone.

## `Script not found "builder"`, or a selfcheck with no output

Both are the same fault: the file at `/usr/local/bin/lazy-agent` inside the
container is **not** the compiled lazy agent. Containers bind-mount
`~/.lazy/bin/lazy-agent` there, so whatever is at that path on your host is what
runs.

The case seen in the field was a bare Bun runtime, which produces two
unrelated-looking errors from one cause:

- `error: Script not found "builder"` — Bun's message for `bun <script>` when no
  such package script exists. The container's entry argv is
  `lazy-agent builder …`, so Bun reads `builder` as a script name.
- `Builder preflight failed: 'lazy-agent selfcheck' did not identify the lazy
  agent (exit 1, stdout: <no output>, …)` — Bun says `Script not found
  "selfcheck"` on stderr and prints nothing on stdout.

Diagnose it on the host:

```bash
lazy doctor          # the "Agent binary" check names what the file actually is
```

Fix it by rebuilding:

```bash
lazy upgrade         # installed build
bun run build        # source checkout, then lazy upgrade
```

Every producer of that file now verifies it before installing it: the extraction
from the compiled `lazy` binary, the dev-mode rebuild, and `lazy upgrade` itself.
A rebuild that produces a non-agent is refused and the previous working binary is
left in place, so a bad build degrades to a stale agent rather than a broken one.

If `lazy upgrade` reports the failure instead of fixing it, the source it is
building *from* is wrong — in a source checkout, check that `./lazy-agent` in the
repo is either the 12-byte placeholder or a real build, and re-run
`bun run build`.

## Documentation links

Messages like *"Check documentation at https://docs.getlazy.dev/…"* point at
this site. Forks and self-hosted mirrors can repoint them, and projects that
would rather not show them can turn them off, with one key:

```toml
[docs]
url = "https://docs.example.com"   # "" disables documentation pointers
```

Every message that carries a pointer is fully actionable without it — the link
is always a supplement, never the instruction.
