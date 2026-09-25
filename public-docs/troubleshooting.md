# Troubleshooting

Start here when a lazy command fails before it does any work. Most of these
have a one-line fix, and `lazy doctor` diagnoses all of them in one pass:

```
lazy doctor
```

`lazy doctor` is the single diagnosis surface — every check prints what failed,
why, and the command that fixes it. When a run finds errors, it also files
one alert in the inbox (`lazy messages`, and Inbox on the dashboard) so
people who never run doctor still see the findings. Re-running doctor does
not stack a second alert for the same failures. The same report and the same
cleanup flags are on the dashboard under **Settings → Doctor**. The sections
below expand on the failures users hit most often.

## Doctor's cleanup flags

A plain `lazy doctor` only **reports**. Anything it can clean up for you is a
flag you choose to run, so nothing happens to your worktrees, images,
containers, branches or tasks unless you ask:

```
lazy doctor --clean-worktrees
lazy doctor --clean-docker-images
lazy doctor --clean-orphaned-containers
lazy doctor --unset-upstream-tracking
lazy doctor --resume-interrupted-tasks
lazy doctor --clean-local-command-conversations
```

Every one of them has the same shape:

1. It lists what it would touch — one line per item, with the size on disk
   where that is the point.
2. `--dry-run` stops there.
3. Otherwise it asks before acting. `--yes` skips the question; without a
   terminal and without `--yes` it refuses rather than guessing, so a script
   can never clean up by accident.
4. It then acts and prints one line per item, plus a count.

A failure on one item is printed and the rest still run — one worktree git
refuses to drop shouldn't strand the other four. The count says how many
actually happened (`Removed 2 of 3 worktree(s).`) and the command exits non-zero
whenever anything failed, so a script or `&&` chain sees it.

Run one remedy at a time — doctor refuses two in one invocation, so you always
know which listing you just approved.

What each one does:

- **`--clean-worktrees`** removes the worktrees of finished (complete or
  abandoned) tasks. This is the one that reclaims real disk: a worktree keeps
  its own `node_modules`, `target/`, `build/` and every other dependency and
  build tree, and finished tasks hold onto them indefinitely. **Branches are
  kept** — the work itself is still there, only the checkout goes.
- **`--clean-docker-images`** removes stale lazy runner images. It never
  removes the image your current lazy version uses, an image this machine has
  adopted, or an image pinned on a task — deleting one of those would break the
  next launch.
- **`--clean-orphaned-containers`** removes lazy containers no task references
  any more.
- **`--unset-upstream-tracking`** drops leftover upstream tracking config from
  lazy task branches. Tracking on a task branch is harmless in itself; doctor
  calls out the one case that is not — a branch whose tracking names a
  *different* branch, where a plain `git pull` on it would merge that other
  branch in.
- **`--resume-interrupted-tasks`** starts the next turn of interrupted tasks
  now. An interrupted task is resumable, not broken, and a running daemon offers
  to resume each one every few seconds — but it holds back a task you stopped
  yourself, one that has been interrupted repeatedly in a row, or one that has
  used up its automatic-resume budget for the day. This flag starts them anyway,
  and it is the only way to resume a task the daemon is holding back.
- **`--clean-local-command-conversations`** drops Claude Code's local-command
  boilerplate (the caveat, a built-in slash command such as `/clear`, and its
  output) out of conversations that were stored before lazy started filtering it,
  so each conversation's summary is the first thing you actually said. On its
  own it deletes nothing: a stored row that holds nothing but boilerplate is
  listed and then left alone. Add
  `--delete-empty-local-command-conversations` to delete exactly those rows —
  it asks separately, `--yes` alone never implies it, and deletion is
  permanent. See
  [Conversation import](conversation-import.md#local-command-transcripts).

The two that need Docker (or Podman) say so and stop if the runtime isn't
running: an empty listing would look like a clean bill of health when in fact
nothing was inspected.

## Sessions start with a lot of the context window already used

Every session — the builder and every task agent — begins with a fixed block of
text already in its context: the `CLAUDE.md` files the agent harness loads,
lazy's own system prompt, your shared memory index, and the schemas for lazy's
tools. None of it is wasted, but on a mature project it adds up, and the first
place most people notice is a startup line from the agent harness about
`CLAUDE.md` being over its size limit.

`lazy doctor` prints the whole breakdown, so you never have to go looking for
it:

```
lazy doctor
```

Under **Context budget** you get one block per role, because a builder session
and a task agent session are not the same:

```
Context budget (injected into every session, before the first message):
  Builder session
    ≥10,412 tok  41,903 chars  CLAUDE.md (project)
      ! over the 40,000-char per-file limit Claude Code 2.1.266 warns at
        It is still injected in full — nothing is truncated — but the harness
        warns at every startup and re-reads the whole file every turn. …
    ≥12,829 tok  55,002 chars  lazy system prompt
      ≥4,001 tok  16,004 chars  of which shared memory index
    ≥14,442 tok  64,389 chars  MCP tool schemas (52 tools)
     ≥3,059 tok  13,172 chars  MCP server instructions
    174,466 chars, ≥40,742 tokens before the first message (≥4% of a 1M-token window)
    Context window: 1M tokens — claude-opus-5 is a 1M-window model and this launch presents a first-party base URL
  Task agent session
    …
```

Reading it:

- **Character counts are exact; token figures are a floor.** They come from an
  offline tokenizer that undercounts Claude's own by roughly 15–20% on prose and
  more on code, which is why they are printed as `≥`. The real cost is higher,
  never lower — so a total that already looks large is worth acting on, and one
  that looks comfortable has less headroom than it says.
- **Indented lines break down the line above them** and are not added again to
  the total. The shared memory index is part of the system prompt, so it is
  shown inside it.
- **Nothing here is ever truncated.** The per-file `CLAUDE.md` limit is a
  warning from the agent harness, not a cut-off — an oversized file is still
  loaded in full, it just costs you that much of every session and gets re-read
  on every turn. The limit is per file, not a budget across all of them: two
  30,000-character files draw no warning even though they total 60,000.
- **The warning names the Claude Code release the limit was read from.** The
  limit is not published as an API; it was read out of the harness bundle, and a
  later release could move it. If your harness is much newer than the release
  named on that line and the numbers look wrong, trust your harness.
- **The two roles differ for real reasons**: different system prompts,
  different memory templates, an extra preamble that introduces a task agent to
  its own task, and the builder additionally loads your personal
  `~/.claude/CLAUDE.md`, which a task agent never sees. The tool schemas are the
  same for both.
- **This is what *lazy* costs, not the whole session.** The agent harness has
  its own system prompt and built-in tools on top, and everything specific to a
  turn — the task's goal and prompt, previous turns, your comments — arrives
  afterwards. Expect the harness's own `/context` screen to show a bigger
  number; the gap is the harness's, and not something lazy can shrink for you.
- **The window is the one this role's next launch will actually get**, not a
  fixed 200k. A 1M-window Anthropic model through lazy's proxy gets 1M; a 200k
  model stays 200k. Doctor prints that number under each role, and names a
  remedy if the project's upstream is pointed somewhere that would cap a 1M
  model. The CLAUDE.md per-file warning uses the same window, so a 1M session
  is allowed a larger file before the harness complains.

When a role's total goes past a fifth of the window, doctor adds one line naming
the largest thing *you* can shrink. There are only two:

- **A `CLAUDE.md` that has grown into a manual.** Move the parts only some tasks
  need into a separate document they can read when it is relevant. Instructions
  every task must follow belong in `CLAUDE.md`; reference material does not.
- **The shared memory index.** Shrink it with `lazy memory compact`, or curate
  the records directly with `lazy memory save` and `lazy memory rm`. See
  [memory.md](memory.md).

Lazy's own system prompt and tool schemas are not something a project can trim,
so doctor never suggests it — if they are the whole of your total, it says so
and leaves you alone.

Measuring a session means assembling the prompt a launch would send, which needs
a working runner. When there isn't one — the daemon is down, typically — the
section prints `Could not measure` and points at the check that explains why,
rather than quietly disappearing and leaving you to conclude lazy injects
nothing.

## The daemon won't start

Lazy needs its daemon: it owns task state, storage and the agent runner, and
every CLI command is a client of it. The CLI auto-starts one when it isn't
already running, and reports the failure rather than proceeding when it can't:

```
Error: <what the daemon reported>
```

The daemon writes the same message, with a timestamp, to its log — as the last
thing it writes before giving up, so the end of the log is where to look. Find
the log path with `lazy daemon status`, and read it with:

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
- **The proxy can't bind or reach its upstream.** The audit/policy proxy is
  always on and has no off switch; the daemon fails loudly rather than silently
  sending traffic direct. Fix the `[proxy]` settings (`port`, `bind`,
  `upstream`) — `lazy daemon logs` says which one failed.

`lazy doctor` deliberately keeps working when the daemon does not — it is the
one command that must never die of the problem it exists to diagnose.

## "Daemon is not running" while a daemon clearly is

Every so often the daemon is up — the web dashboard answers, agents keep
working — but `lazy daemon status` insists it isn't running, and
`lazy daemon start` then fails because the running daemon still holds the
storage lock. There is a specific cause: the daemon's PID file (`lazy.pid` in
the daemon's state directory) was deleted while it was running.

The daemon now notices and rewrites the file itself within a few seconds.
`lazy doctor` reports the state in these terms — naming the live daemon's PID,
recovered from the lock file — instead of repeating "daemon is not running":

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

## The daemon is alive but nothing is happening

A daemon whose event loop is stuck is the hardest failure to recognise, because
it looks exactly like a healthy idle one: the process is there, the socket is
still listening, and nothing errors. Tasks simply stop progressing.

`lazy daemon status` names this state directly:

```
Daemon is ALIVE but UNRESPONSIVE (PID 41287).
  Socket:  /home/you/.lazy/daemon/<slug>/lazy.sock
  Probe:   connected, but no reply within 3s
```

The probe is bounded on purpose. A frozen daemon still has its kernel listener,
so connecting succeeds and the request is queued to a process that will never
read it — an unbounded status check would wait forever on the very daemon it was
run to investigate. `lazy daemon status` and `lazy daemon stop` both give up
after a few seconds and say so.

Recovery is one command:

```
lazy daemon restart
```

No hand-rolled `kill` is needed. `lazy daemon stop` (which `restart` runs first)
escalates on its own and narrates each step: bounded shutdown request → SIGTERM →
SIGKILL. The escalation exists because a polite signal may not finish the job:
a frozen daemon cannot act on it at all, and a busy one may still be shutting
down when the clock runs out. Either way, until the process is gone it holds the
daemon lock, so no replacement can start — which is why stop finishes the job
itself rather than telling you to reach for `kill -9`.

The grace period before the SIGKILL depends on what the daemon did with the
shutdown request. One that *accepted* it is winding down deliberately (closing
storage, waiting on child processes) and gets 15 seconds; one that never answered
has already failed to behave and gets 5. That asymmetry is deliberate: a single
short clock would force-kill a healthy daemon in the middle of a slow but correct
shutdown.

A process that survives SIGKILL is stuck in the kernel — uninterruptible I/O,
usually a hung network mount. `lazy daemon stop` says so explicitly instead of
reporting a clean stop; nothing in user space can clear it.

To see whether the daemon's reconcile loop is the thing stuck, run
`lazy daemon health` (next section): its **Reconcile loop** row says when the
last tick finished and, if one has been running too long, which phase it is in.
For the full story, run the daemon with debug logging: each tick logs a line when
it starts and another when it completes, so a start with no matching completion is
the wedge, and the last phase logged before it points at the cause.

## The daemon answers, but work has stopped: `lazy daemon health`

Most things that go wrong inside a running daemon do not crash it — by design. A
background loop that hangs, a recovery step that fails on every pass, a proxy that
stopped answering, a task left saying `working` with nothing running: each is
caught and logged, and the daemon keeps serving. `lazy daemon status` then says
"running", and it is, while the work it exists for has quietly stopped.

`lazy daemon health` asks the daemon about each of its moving parts and prints one
row per check, **OK**, **WARN** or **FAIL**, with a one-line reason. Rows that are
not OK say what to do:

```
$ lazy daemon health
Daemon health — /home/you/src/my-project

Daemon
  ✓ Version and uptime — lazy 0.23.1, pid 41287, up 3h12m04s, source 5d1e… (computed)
  ✓ Daemon runs the CLI's build — same build (5d1e…)

Loops
  ✗ Reconcile loop — last tick finished 7m02s ago (took 180ms); 2210 ticks since start,
    every 5s; the current tick has been running 7m01s, in 'runAutoReact'
      → `lazy daemon logs` shows what the tick is waiting on …
  ✓ Sync retry loop — last tick finished 2s ago (took 3ms); …
  ✓ Remote sync loop — last tick finished 41s ago (took 2.1s); …

Reconciler sweeps
  ✓ 25 sweeps healthy (--verbose lists each)

Proxy
  ✓ Proxy answering — listening on 127.0.0.1:52811; self-check answered in 1ms
  ✓ Proxy audit log writable — /home/you/src/my-project/.lazy/logs; last record 12s ago
…
14 OK, 0 WARN, 1 FAIL
```

What it checks:

| Section | Rows |
|---|---|
| Daemon | Version, pid and uptime; whether the daemon runs the same build as the CLI you typed the command in |
| Loops | The reconcile, sync-retry and remote-sync loops: when each last completed a tick, how long it took, how many ticks since start. A loop whose last completed tick is far older than its interval is a WARN, then a FAIL, and the row names the phase the running tick is stuck in |
| Reconciler sweeps | Each recovery sweep and reconcile phase: last run, duration and last error. A sweep that just failed is a WARN; one that has failed on every run for five minutes is a FAIL. Healthy sweeps are folded into one line unless you pass `--verbose` |
| Proxy | Where the proxy listens, and a real request to its own health path with the round-trip time — that request carries no credential and reaches no model, so it costs nothing. Also whether the proxy's audit log can be written |
| Storage | Who holds the storage lock (the daemon itself is the only healthy answer; a dead holder, or a pid that now belongs to a different process, is called out) and whether writes are completing |
| Runner | Docker or Podman reachable (or, for the host runner, the agent binary), and whether the container image is built |
| Tasks | Tasks that say `working` but have no live run, and for how long; tasks with queued syncs and where their retries stand; interrupted tasks that nothing will resume on its own (auto-resume gave up, or is turned off) |
| Dashboard | Whether the web dashboard is bound, on which addresses, and why an extra address for containers could not be bound |

Each check runs under its own time limit, so a part that hangs shows up as a FAIL
row naming it rather than a command that never returns. Rows print as each check
completes. The command never starts a daemon: with none running, it reports that
as its one row.

It exits 1 when any row FAILs, and 0 otherwise, so it can gate a script. `--json`
prints the whole report for tools:

```
lazy daemon health --json | jq '.rows[] | select(.state != "ok")'
```

`lazy doctor` includes a single **Daemon health** line summarising this report and
pointing here; the rows and their remedies live only in `lazy daemon health`.

## What stopping the daemon costs

`lazy daemon stop` and `lazy daemon restart` list what is live before they act,
and — at a terminal — ask before going ahead. The three classes are affected
differently, so they are reported separately rather than as one count:

- **Working task agents** are stopped with the daemon. The in-flight turn is
  lost (committed work is kept) and the task resumes from its last checkpoint
  once a daemon is running again. This is not special to `lazy daemon stop`:
  a daemon told to quit any other way — a service manager stopping it, a plain
  `kill`, or closing the terminal it is running in — stops its agents the same
  way and records why each turn ended, which is why it takes a moment to exit
  rather than vanishing instantly.
- **Builder sessions** (`lazy builder`) are *not* stopped with the daemon.
  They keep running and reconnect in place when the daemon comes back — the
  in-container supervisor refreshes the proxy address and relaunches Claude with
  `--resume`. While the daemon is down they cannot reach the model through the
  audit proxy; restart the daemon and wait for the one-line reconnect notice
  rather than relaunching by hand.
- **Pair sessions** are not stopped either, and nothing resumes them: the task
  stays locked in `pairing` until you exit the session.

One thing cannot be enumerated yet and is named as such in the warning rather
than silently omitted: a `lazy pair` started outside a task (on main).

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

## Where one task's pieces live

Troubleshooting a single task means knowing four locations, and none of them is
guessable from the outside: the worktree depends on the project's data dir *and*
on the task's ref, and the store root is wherever `[storage] external_path`
points.

- **Worktree** — `<project root>/<data dir>/worktrees/<task ref>`. Removed when
  the task ends, so its absence is ordinary for a finished task and a real
  finding for a working one. `lazy doctor <task-id>` prints it and says whether
  it is there.
- **Store root** and **task data dir** — where the task's own records live,
  under `[storage] external_path` when one is set.
- **Container / run name** — on the task's session, next to `runner_type`. A
  docker session is found by container name, a host one by pidfile.
- **Daemon log** — `daemon.log` under the daemon's own dir; `lazy daemon logs`
  tails it and prints the path it is tailing.

The daemon reports the worktree, the store root and the task data dir as a
`paths` block on its `show` RPC, for clients that are not a shell on this host;
the container name and runner are already on the session there.

A browser client can render all of these on the task page for an operator,
alongside the task's full id, its session id and the session's
`interrupt_reason`. Locations only — a path to a token file is shown so an
operator can read it with their own credentials; no value ever is.

When the daemon itself is down there is no task page to read: every task read
fails and the browser lands back on the project page. That page carries a
**Diagnostics** control in its header for an elevated admin — and, when the
project is not answering, says so and points at the same place — so the project
diagnostics (supervisor state, restart history, daemon log tail) stay one click
away in the state they exist for. Members see none of it; a daemon is not
theirs to operate.

## lazy.toml won't parse

A `lazy.toml` that exists but cannot be read is always a hard error, never a
silent fallback to defaults: running with settings you didn't write is worse
than not running. The message names the file, the line that failed and its
text, and what the parser objected to — so a 300-line config does not turn into
a hunt:

```
Failed to parse /path/to/lazy.toml: line 8: port = = 26024 — TOML Parse error: Expected a value but found '='
```

The daemon applies the same rule before it starts anything at all, so a broken
`lazy.toml` never gets as far as a daemon running on guessed values.

The same applies to a value that parses as TOML but isn't usable — an unknown
effort level, a port outside 1–65535, a malformed `[docs] url`. Each is
reported with the section, the key, and the accepted values.

`lazy doctor` also lists **unknown** sections and keys — typos and options left
over from older versions. Those are warnings, not errors: lazy ignores them.

The full key-by-key reference is [lazy.toml](./lazy-toml.md).

## No model credential

The daemon — not your shell — is what launches agents, so the credential has to
reach the **daemon**. The durable fix is to store it, which takes the shell out
of the picture entirely:

```
claude setup-token | lazy auth set anthropic
lazy daemon restart
```

The daemon reads the store at startup, so it no longer matters which terminal
started it. This is also what stops `lazy upgrade` aborting with "no
authentication credential found in the environment" when you run it from a shell
that never exported a token. See [Credentials](./credentials.md).

Exporting still works and still wins over the store, if you prefer it:

```
export CLAUDE_CODE_OAUTH_TOKEN=…      # or ANTHROPIC_API_KEY
lazy daemon restart
```

`lazy doctor` prints one line per credential your [agent
profiles](./lazy-toml.md#agentsname--named-agent-profiles) bill — the profiles
the **builder** and **agent** roles default to, plus every `[agents.<name>]`
block in your lazy.toml — naming the credential, where it was found, and which
profiles need it:

```
✓ Anthropic credential present (daemon env: ANTHROPIC_API_KEY; needed by claude-code)
✓ OpenAI credential present (credential store: keychain; needed by openai-pi)
✗ OpenRouter credential present (needed by openrouter-codex)
```

A missing credential fails the check by name, with the profiles it strands, how
to obtain one, and the `lazy auth set <name>` command that stores it. The source
is the daemon's environment, the credential store (naming its backend), or the
agent key file written by `lazy system agent set-key`. When the daemon cannot be
asked, doctor falls back to your shell's environment and the store and says so
on every line — that answer may not be what lazy actually uses, so check the
daemon and run it again.

Doctor is deliberately stricter than the daemon's startup check. The daemon
starts as long as the two **role defaults** have their credentials, so a profile
you declared but never selected never blocks it; a task that selects such a
profile fails at launch, naming the profile and the credential. Doctor reports
that credential as missing up front, so you learn it before a task does.

If every profile your configuration uses points at an upstream that takes no
credential — `credential = "none"`, the default for a local model server — no
credential is required at all, the daemon starts without one, and doctor says
so:

```
✓ Model credential present (none needed — every configured profile uses an upstream that takes no credential)
```

## A Codex task answers, then can't touch any file

Symptom: a Codex task authenticates, the model clearly replies, and then the
turn stops without changing anything — reporting something like
`failed to spawn code-mode host …/codex-code-mode-host: No such file or
directory`.

Cause: the task image is older than this fix. Codex ships its tool runner as a
second binary next to the CLI, and some models route every tool call through it.
An image built without that binary gives you an agent that can talk and nothing
else.

Fix: rebuild the task image.

```
lazy upgrade --images
```

`lazy doctor` reports this one directly — look for "Codex code-mode host
installed" — so you can check before starting a task rather than after losing a
turn.

## Cursor review says "MCP calls were rejected"

Symptom: a formal `lazy review` (or `lazy ask`) on a Cursor task produces a
turn that says MCP calls were rejected / Shell is blocked, skips
`lazy_show` / `lazy_raise`, and dumps findings only in the verdict JSON. Claude
reviews on the same project keep their lazy tools.

Cause (fixed in current lazy): Cursor's `--mode plan` refused MCP tool calls.
Read-only Cursor turns now exclude write tools by name and leave lazy MCP
available, the same way Claude Code excludes `Bash` / `Write` / `Edit`.

If you still see the rejection on an older binary, upgrade lazy and re-run the
review. Findings from a review that already lost MCP can still land as Raises
via the turn handoff / verdict recovery path.

## One Cursor task fails auth while others work

Symptom: most Cursor tasks run fine, but one task dies immediately with
`fatal_auth` / "Cursor CLI is not authenticated" / "set CURSOR_API_KEY", and
resuming it fails the same way. It can also look like the task "switched to
Claude" — the container was built with Claude credentials while the task still
says Cursor.

Cause: that task's container was created without the Cursor key in its
environment. Credentials are fixed at container create time, so resume keeps
reusing the broken container.

Fix: recreate that task's container, then resume or unblock:

```
lazy shell <task> --restart
lazy resume <task>
```

## `lazy pair` refuses to run on my machine

Expected. Pairing runs **inside the task's container**, where the task's own
turns run — not as a host process against the worktree. **Branchless pairing**
(`lazy pair` on a non-task branch: no task, no worktree) has no container and
requires an explicit `lazy pair --host`, which says what it is doing before it
launches. There is no automatic fallback: if the container path fails, pairing
fails loudly. See [Pairing](pairing.md).

Cursor tasks now pair too — the refusal that used to apply to them was about
host pairing needing to copy container-written chat history onto your host, and
in-container pairing does not copy anything. Conversation capture and the
end-of-session AI summary remain Claude Code only, and pairing says so when it
starts.

`--host` itself is claude-code-only, and refuses on a task running any other
agent. The host launcher runs Claude Code whatever the task's agent is, so
`--host` on a Cursor task would open the wrong agent against that task's work.
Pair it in its container instead.

## `lazy pair` or `lazy chat` asks me to `/login`

Interactive sessions take their credential from the **daemon**, exactly like
task agents do — not from the shell you typed the command in. If you see a
`/login` prompt, the daemon is the thing to look at:

```
lazy daemon status
lazy doctor
```

Store a credential (`claude setup-token | lazy auth set anthropic`) or restart
the daemon from a shell that has one exported — either way, `lazy daemon restart`
and the next `lazy pair` picks it up.

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

## Accept fails with `index.lock: File exists`

```
Accept failed: git could not update the index because a lock file already exists at
…/.git/worktrees/<task>/index.lock. …
```

Git creates an `index.lock` while it updates a worktree's index, then renames
it into place. If that git process is killed mid-write — a crash, a forced
daemon stop, a container teardown — the lock file is left behind, and every
later accept whose merge target is that worktree fails until the lock is gone.

Lazy checks whether any process still has the lock open before removing it. When
nothing holds it, accept clears the lock, says so, and continues. When a live
process still has it open, accept refuses and names the process — deleting a
lock out from under a live git corrupts the repository.

If lazy cannot check (no way to list open files in that environment) it also
refuses, and tells you the exact `rm` path to use only when you are sure no git
is using that worktree:

```
rm …/.git/worktrees/<task>/index.lock
```

Then retry the accept. The task is left as it was — the merge did not start.

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
raise items, commit through lazy, or reach any lazy state — it would do
the work with the wrong picture and no way to say so, so lazy refuses the turn
loudly rather than letting it run blind.

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

## "Refusing to serve lazy MCP tools: … configured for a different task"

A turn's agent has no `lazy_*` tools, and the MCP server's output says:

```
Refusing to serve lazy MCP tools: this server was configured for a different task
than the turn it was spawned in.
  This turn expects: task 6148d734-… in /repo/.lazy/worktrees/my-task
  The MCP entry says: task 91290431-… in /repo/.lazy/worktrees/old-task
```

Claude Code discovers MCP servers in exactly one place — `$HOME/.claude.json` —
and every lazy supervisor rewrites the single `mcpServers.lazy` entry there
before each turn, stamping in that turn's task and worktree. Containerized tasks
each have their own HOME, so supervisors for different tasks do not share an MCP
config file on the host.

A stray `lazy supervise` process left behind by an earlier run can keep
rewriting that entry while a real agent works, so the agent's tools would be
served against the stray's (possibly already deleted) worktree. The server
compares its own `--task-id`/`--worktree` against what the supervisor exported
for this turn and exits instead, so an agent gets its own task's tools or none —
never another task's.

The remedy is in the message: find the stray supervisor and kill it.

```bash
ps ax | grep "lazy supervise"
kill <pid>
```

Then re-run the turn. If the process it names belongs to a live task you care
about, that task is the one to stop cleanly (`lazy stop <task>`) rather than
kill. Note that "no tools" is itself fatal and visible — the turn is aborted, not
run blind.


## A lazy tool fails, then every later tool says "Connection closed"

What it looks like in an agent's transcript:

```
lazy_commit → git commit failed: fatal: cannot change to
              '/repo/.lazy/worktrees/482b10cc': No such file or directory
lazy_status → Connection closed
```

Two separate faults, one after the other.

**The dead directory** is the shared-`~/.claude.json` hijack described in the
section above: the MCP server this agent was talking to had been spawned from an
entry another supervisor overwrote, so it was bound to a worktree that had
already been cleaned up. The agent's own worktree was never involved. That entry
can now only be served by the task it names, and if a bound worktree does go
missing anyway the tool says so itself — naming the path, the task, the likely
cause and the remedy — rather than passing git's wording through.

**"Connection closed" is not a network problem.** It is what an MCP client reports
when the server process is simply gone. The `lazy_status` that followed could not
reach the daemon, and older versions treated that the way a one-shot `lazy`
command does — print the error and quit. Quitting is right for a command that was
about to finish anyway, and wrong for a server in the middle of a session: it took
the whole tool channel down, so the agent lost every remaining `lazy_*` tool for
the rest of the turn, including the ones it would have used to report the problem.

An unreachable daemon now comes back as an ordinary tool error and the session
keeps working, so a single failing tool no longer costs you the rest of them. If
you see "Connection closed" today, the server really did die: look at the
supervisor log for a `[lazy-mcp]` line, which reports the reason.

If a tool ever answers with the missing-worktree message, do what it says — report
it and stop. Every tool on that connection is bound to the same dead path, so
retrying, or reaching for a different lazy tool, will only produce the same
failure. Nothing was read or written in the missing directory, and your own
worktree is untouched.


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

## `<redacted>` in logs and audit records

Lazy scrubs live credential values out of anything it writes for a human to
read, so a log you paste into a bug report cannot carry your token. You will see
`<redacted>` in place of the value at four places:

- the `[session] debug = true` command echo
- lazy's log files and console output
- the supervisor and builder logs
- `lazy stats audit` records — including the agent's own Bash command strings
  and tool results, which is where an agent that runs `env` or reads a
  credentials file would otherwise land a live value on disk

Only the *value* is replaced. Env var names, mounts, image tags, commands, file
paths and everything else stay intact, so the output is still diagnosable.

Redaction is driven by env var **key names** (anything matching `*_TOKEN`,
`*_KEY`, `*_SECRET`, `*_PASSWORD`, `*_CREDENTIAL(S)`, `*_AUTH`), never by
guessing which values look secret. Two consequences worth knowing:

- A credential lazy does not have in its own environment is not scrubbed —
  redaction covers what lazy launches agents with, not arbitrary secrets in your
  repo.
- Values shorter than 12 characters are left alone on purpose. Ollama sets
  `ANTHROPIC_API_KEY=ollama` and the QA agent uses `none`; substring-replacing
  words that short would corrupt unrelated log lines while protecting nothing.

## `Script not found "builder"`, or a selfcheck with no output

Both are the same fault: the file at `/usr/local/bin/lazy-agent` inside the
container is **not** the compiled lazy agent. Containers bind-mount an agent
binary from `~/.lazy/bin` there, so whatever that host file is is what runs.

Each install lives under a name derived from its own bytes
(`~/.lazy/bin/lazy-agent-<id>`) and is never written to again once installed;
`~/.lazy/bin/lazy-agent-current` is a symlink pointing at the current one. That is
why `lazy upgrade` no longer disturbs containers that are already running — they
keep mounting the file they started with. (`~/.lazy/bin/lazy-agent`, if you still
have one, is from an older layout: lazy leaves it alone for containers that
mount it and removes it once none do.)

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

Every producer of that file now verifies it before installing it: `bun run build`
(before embedding the agent into the compiled `lazy` binary), extraction from that
embedded copy, the dev-mode rebuild, container image tagging (a throwaway
container runs `lazy-agent selfcheck` with the mount path), and `lazy upgrade`
itself. A rebuild that produces a non-agent is refused and the previous working
binary is left in place, so a bad build degrades to a stale agent rather than a
broken one.

If `lazy upgrade` reports the failure instead of fixing it, the source it is
building *from* is wrong — in a source checkout, check that `./lazy-agent` in the
repo is either the 12-byte placeholder or a real build, and re-run
`bun run build`.

## `lazy sync` / `lazy unblock` sits silent for minutes after an upgrade

Launching a turn builds the container image if one is missing, so a command that
starts a turn can block for as long as a build takes. That is expected the first
time you use a project on a new machine. It is **not** expected right after an
upgrade that already built the image.

Look at `lazy daemon logs`. Every container build lazy runs now announces itself
on one line before any build output, and one line after:

```
Building container image lazy-runner:0.23 from the embedded default Dockerfile
  — missing on this host — first build for lazy 0.23.1670 (this can take several minutes).
Built container image lazy-runner:0.23 from the embedded default Dockerfile in 4m12s.
```

The build's own progress output is streamed between the two, tagged with the
image name (`[build lazy-runner:0.23]`). Two things to read off it:

- **Which image, and from which Dockerfile.** If the Dockerfile path is not one
  you recognise — or the image name is not one of yours — the build belongs to a
  different project's daemon on the same machine.
- **Why.** The reason is on the first line: `missing on this host`,
  `too old: built N days ago`, or the name of the input file whose content
  changed.

If the reason says `missing on this host` immediately after an upgrade, the
upgrade built one image and the daemon then resolved a different one. The usual
cause is a worktree Dockerfile adoption that was cleared: adoption is scoped to
lazy's `major.minor`, so a genuine minor-version bump expires it and the daemon
falls back to the project root Dockerfile. `lazy doctor` reports the adoption's
state and why it was cleared.

## The fix isn't working after `lazy upgrade`

When you rebuild from a source checkout, `lazy upgrade` prints which checkout
produced the agent binary — path, branch, short commit, and whether the tree was
clean or dirty — on the `rebuilt agent binary (verified)` line. If you ran upgrade
from the wrong branch, that line is the first place to look.

After the fact, the same metadata is embedded in the binary:

```bash
lazy --version
lazy-agent selfcheck
```

Both append branch, commit, clean/dirty, and source path when the binary was built
from a checkout (dev-mode `bun run ./src/index.ts` runs show `dev` instead).
`lazy daemon status` includes branch and path on its **Built:** line for compiled
daemons.

Building from `main` while fixes live on a release branch is fine — the failure
mode is when that choice is invisible. Check the provenance lines before chasing
behavior that simply is not in the binary you installed.

## `detected dubious ownership in repository at …`

git refuses a repository whose directory belongs to a different user than the one
running git, and it suggests you fix that with:

```
git config --global --add safe.directory /path/to/the/worktree
```

**Do not run that for a lazy worktree.** The path in the message is a worktree
lazy created and manages, and in almost every case the git that refused it was
running inside the agent container — where your host's `~/.gitconfig` is never
read, so the suggested command would change nothing while quietly widening trust
on your machine.

Lazy marks its own worktree and git directories as trusted in the gitconfig it
generates for each task at `<worktree>/.lazy-task-sandbox/.gitconfig`, which the
container uses as its global git config. Nothing else is trusted: every other
repository visible inside the container still gets git's ownership check in full,
and your real `~/.gitconfig` is never touched.

If you see this anyway, that generated file did not reach the container. Relaunch
the task to regenerate it:

```bash
lazy stop <task>
lazy unblock <task>
```

If it survives a relaunch, the failure is on the host side rather than in the
container — check who owns the path (`ls -ld <worktree>`). It should be the same
user that runs lazy and its daemon; a worktree owned by `root` usually means some
command was run under `sudo` that should not have been.

## `lazy sync` warns that the local and remote parent branch differ

When a subtask syncs, lazy merges its parent branch in. If your project has a
remote, that branch can exist in two places at once — locally, and as
`origin/<branch>` — and they do not always agree. When they do not, sync says so:

```
Local `lazy/parent-task` and `origin/lazy/parent-task` differ: 2 commit(s) only
local, 0 only on the remote. Used `lazy/parent-task` — `lazy/parent-task` is
unprotected, so `lazy accept` merges into the LOCAL branch.
```

This is information, not an error: the sync succeeded. Lazy always merges from
the ref `lazy accept` will actually merge into, so the two commands agree about
what your task is built on.

Which ref that is depends on the parent branch:

- **A parent task's branch, or any other unprotected branch** — accept merges it
  locally, so sync uses the local branch. A parent task's own commits live only
  on your machine: agents cannot push, by design.
- **A protected branch such as `main`** — accept merges on the forge, so sync
  uses `origin/<branch>`. Any local commits on that branch are not part of the
  merge until they are pushed, and the warning says so.

**Sync never pushes a parent branch.** If a branch of your own is ahead of the
remote and you want the remote to carry those commits, push it yourself —
the warning names the exact command. Lazy leaves it alone because you may be
part-way through work on that branch.

If you see this warning and the outcome still surprises you, `lazy diff <task>`
shows what the task is actually built on.

## A colleague pushed to my task's branch

Run `lazy sync <task>`. Before it merges the parent branch, sync checks the
task's OWN branch on origin, and merges `origin/<task-branch>` into the worktree
when it has commits your copy lacks — a fast-forward when the branch is only
behind, a real merge when both sides moved. Conflicts are handed to the task's
agent to resolve, so you do not have to pair into the worktree and run `git
merge` by hand.

The step names itself in the output, including when it does nothing:

```
✓ [1/5] Check task branch on origin — origin/lazy/my-task has new commits
– [1/5] Check task branch on origin skipped — origin/lazy/my-task has no new commits
```

It is also skipped, with the reason on that line, when your remote driver is
`local`, when lazy is offline, or when the branch has never been pushed. Sync
does not push the result back — the push after the next turn, or `lazy accept`,
does that.

## A task lists hundreds of commits it never made

A task's Commits tab — in `lazy show`, in the web review, in search — should
list what its own branch carries. Before v0.23, a task that merged its upstream
branch also recorded everything that branch brought along, and the error grew
every turn: long-running tasks ended up listing hundreds of other people's
commits, going back months. Only the stored list was wrong; the branch, the
diff and the review were never affected.

Turns started on v0.23 or later record correctly. Lists already stored that way
do not fix themselves, because nothing else ever deletes a commit record — clean
them up explicitly:

```
lazy system repair-commits --all
```

That reports what it would change and writes nothing. It lists the records it
would remove, with their commit subjects, so you can see what is about to go
rather than approving a number. On a large project the scan takes a while, so
it prints each task as it checks it.

When the report looks right, apply it:

```
lazy system repair-commits --all --apply
```

Name a single task instead of `--all` to check just that one. Add `--json` for
machine-readable output; with `--apply` it also needs `--yes`, since there is
nobody to confirm with.

Some tasks are reported as **skipped** and left exactly as they are. That
happens when the correct list can no longer be computed with confidence, and in
every case the records are kept rather than guessed at:

- The task's branch is gone entirely — accepted long ago, worktree removed, no
  remaining ref.
- The branch survives only as a ref, and that ref does not contain some of the
  recorded commits. Usually this means the worktree was removed while its last
  commits had never been pushed, so the ref is behind the work: those records
  may well be real, and deleting them would destroy the only trace of them.

A skipped task is not a failure, and re-running later can resolve it — for the
second case, restoring or re-fetching the branch is what gives the command
something trustworthy to compare against.

## The daemon can't fetch from the remote

The daemon polls your remote about once a minute so it can notice branches that
were merged or closed elsewhere. If it cannot authenticate, `daemon.log` says
so once, with what to do:

```
Fetch from 'origin' failed for /path/to/project: fatal: could not read Username for 'https://github.com': terminal prompts disabled
  The remote needs credentials this machine does not have. Authenticate git for it
  (a credential helper, `gh auth login`, or an SSH key), or set `sync_interval = 0`
  under [server] in lazy.toml to stop syncing this project.
```

The daemon keeps retrying on its normal schedule — a network blip should heal
by itself — but it only writes that message again when the reason changes, so a
remote you have no credentials for does not fill the log.

**Git never prompts here, on purpose.** The daemon runs in the background,
often sharing a terminal with whatever started it, and a background `git` asking
`Username for 'https://github.com':` takes over that terminal with nothing to
say which process wants an answer. A fetch without credentials fails
immediately instead. Everything else — your own `lazy` commands, agents in their
containers — is unaffected.

Fix it the same way you would for any other git on the machine: log in with
`gh auth login`, configure a credential helper, or use an SSH remote with a key
the daemon's user can read.

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
