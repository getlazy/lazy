# lazy-agent Design

## Overview

`lazy-agent` is the binary that runs inside Docker containers. It serves two roles:

1. **Supervisor** (default mode) — container entrypoint that manages work phases
2. **MCP server** (`mcp` subcommand) — exposes lazy tools to Claude Code via JSON-RPC over stdio

## Process Architecture

Inside the container, three processes form a parent-child chain:

```
PID 1: lazy-agent --protocol-dir ... --worktree ...  (supervisor)
  └─ claude -p "..."                                  (Claude Code)
       └─ lazy-agent mcp --task-id ... --worktree ... (MCP server)
```

### Why two modes, not one process?

MCP's stdio transport requires the server to be a **child process** of the client
(Claude Code). Claude Code reads `~/.claude.json`, spawns the MCP server process,
and communicates with it via stdin/stdout.

The supervisor is already running as PID 1 — it can't also serve as the MCP server
on Claude Code's stdin/stdout because:

- The supervisor spawns Claude Code (parent → child)
- Claude Code spawns the MCP server (parent → child)
- MCP stdio requires the server's stdin/stdout to be owned by the client
- A process can't be both an ancestor and a child of Claude Code

So the supervisor and MCP server **must** be separate processes. They share the
same binary (`lazy-agent`) but run in different modes.

## Supervisor (default mode)

```
lazy-agent --protocol-dir <path> --worktree <path>
```

The supervisor is the container entrypoint. It:

1. Checks required tools (git, claude, lazy-agent)
2. Recovers worktree state from previous crashes
3. Enters a command loop: waits for `command.json` from the host
4. Executes phases: sync-with-remote → sync-with-upstream → write MCP config → work → post-turn sync
5. Writes `response.json` when done
6. Stays alive between turns (the container is long-lived)

Before spawning Claude Code, the supervisor writes `~/.claude.json` inside the
container so Claude Code discovers the MCP server on startup.

### The MCP config is written per TURN, not once per task

`~/.claude.json` is **not** persisted for a task. The container mounts
`<worktree>/.lazy-task-sandbox/.claude` at `/home/user/.claude`, but
`/home/user/.claude.json` sits beside that mount on the container's own ephemeral
filesystem. A task whose container has been reaped — the normal state for anything
blocked for a while — gets a brand-new container on its next turn, with no MCP
entry at all.

So every supervisor path that runs an agent calls `prepareTurnMcp`
(`src/supervisor/mcp-setup.ts`) first. Ask and pre-accept turns did not, which is
how an agent asked about its own task came to answer *"the lazy MCP tools are
currently disconnected"* — it genuinely had none. A source-scanning coverage test
(`test/unit/supervisor-mcp-setup.test.ts`) fails if a new agent-running handler
forgets the call, since the symptom is otherwise silent and only appears for tasks
whose container had already gone away.

### Ask turns get a read-only toolset

An ask is read-only Q&A, so its MCP config asks the runner for a server started
with `--read-only`: it advertises only the tools that cannot mutate state
(`lazy_show`, `lazy_list`, `lazy_search`, `lazy_status`, `lazy_diff`, `lazy_wait`,
the conversation and memory readers), and a write tool answers with an actionable
refusal rather than "Unknown tool". Only the read-only tools are pre-approved in
`settings.json` for that turn.

The scope has to be applied *in the container*. The older guard — the
`LAZY_MCP_READ_ONLY=1` env var checked inside the tool handlers — is a no-op for a
containerized agent, because under the daemon proxy the handlers execute in the
**daemon**, which never sees the supervisor's environment. The env var still
covers the host-process runner, where tools execute locally; the flag covers the
rest. Which tools are reads is decided in one place, `src/mcp/tool-access.ts`, and
an unclassified tool is treated as a write (fail closed).

## MCP Server (`mcp` subcommand)

```
lazy-agent mcp --task-id <uuid> --worktree <path> [--read-only]
```

The MCP server is spawned by Claude Code (not by the supervisor directly). It:

1. Implements JSON-RPC 2.0 over stdio (no external dependencies)
2. Exposes the agent-facing tools: `lazy_search`, `lazy_show`, `lazy_create`,
   `lazy_start`, `lazy_comment`, `lazy_add_followup`, `lazy_update_progress`, `lazy_commit`,
   `lazy_status`
   (plus read-only conversation tools). `lazy_create`/`lazy_start` are scoped so an
   agent may only create and start subtasks of its OWN task; `lazy_propose` was retired
   (orthogonal work is recorded via `lazy_add_followup` — see below)
3. Opens/closes storage per tool call to avoid stale state
4. Runs as long as Claude Code keeps stdin open
5. **Dispatches requests concurrently.** The read loop parses each line and hands
   the handler off without awaiting it, so a tool call that runs for minutes does
   not stall the next request on the same stdio pipe. This is required, not an
   optimization: `lazy_accept` can run a pre-accept turn (opt-in) plus a merge, and while it
   ran, every other `lazy_*` call from the same builder session used to hang for
   its full duration (misdiagnosed for weeks as "daemon blips", even though the
   daemon answered direct HTTP probes in milliseconds). Ordering is NOT the
   transport's job — conflicting mutations are serialized narrowly by the daemon's
   per-task lifecycle lock (`withTaskLifecycleLock`), and storage writes are
   individually atomic. Clients that need one call to precede another await the
   first reply, which is what the MCP protocol expects.

### Follow-ups: a passive, task-level store for orthogonal discoveries

When an agent notices genuinely **orthogonal** work — a different concern the current task
does not need in order to be correct and mergeable — it records it with `lazy_add_followup`
rather than creating a backlog task or burying it in prose. Follow-ups are stored on the task
(`follow-ups.json` / a `follow_ups` table), so they survive auto-turns and auto-resumes.

The defining invariant is that recording a follow-up is **non-triggering**: it creates no
comment, changes no task status, and writes no signal, so it can never kick off an auto-turn or
auto-resume. This is exactly why follow-ups are a separate store and not comments — comments
feed the comment auto-react loop, which would spuriously resume the agent. Follow-ups are
read and triaged by the builder/human at review time (`lazy_show` surfaces them as `follow_ups`):
each is folded back into the task, promoted to a vetted task, or dropped. The backlog only ever
receives builder-vetted tasks.

The MCP server replaces the old CLI-based agent commands. Instead of the agent
calling `lazy search ...` as shell commands, it uses MCP tool calls which are
type-safe and structured.

### Guardrail: `selfcheck` and the builder preflight

`lazy-agent` is not built into any image — it is compiled on the host and
bind-mounted read-only into `/usr/local/bin/lazy-agent` at `docker run` time
(see [Container Setup](#container-setup)). If the wrong file ever lands at that
path — a bare Bun runtime, a stale/placeholder build, a wrong-arch binary — then
Claude Code's MCP child (`lazy-agent mcp …`) exits immediately, and the builder
silently loses **every** `lazy_*` tool. The only visible symptom is an opaque
`Failed to reconnect to lazy: -32000` buried in Claude's own logs.

Two mechanisms make that failure loud:

1. **`lazy-agent selfcheck`** (and `--version` / `--revision`) prints a stable
   sentinel, `lazy-agent ok <version>`, and exits 0. A bare Bun binary instead
   prints Bun's own version or errors `Script not found "selfcheck"`, so both the
   sentinel and the exit code distinguish the real compiled agent from bare Bun.
2. The **builder supervisor preflight** (`preflightAgentBinary`) execs
   `lazy-agent selfcheck` before launching Claude Code and aborts with an
   actionable "rebuild/reinstall the agent binary" error when the sentinel is
   missing — instead of handing off into a session that will silently `-32000`.

Neither catches a binary that is *valid but stale*, which is the more insidious
failure: it passes `selfcheck`, speaks MCP, and only misbehaves where its code
has since diverged from the daemon's. In a compiled install the mounted binary is
extracted from the executable's embedded copy on demand
(`extractEmbeddedAgentBinary`), and that extraction used to skip the write when
the on-disk file merely *matched in size* — which two builds of a ~100MB Bun
executable routinely do. The check is now byte-exact (length **and** content
hash), and the replacement goes through a temp file plus `rename()` rather than
rewriting the destination in place, because running containers bind-mount that
exact inode and an in-place rewrite mutates a live session's agent binary.

### Daemon staleness (`codeSha`)

Tool calls in daemon-proxy mode are forwarded to the long-lived daemon, which
serves whatever code it was **started** with — it does not hot-reload when the
source changes. During lazy's own development this masks merged fixes: the daemon
keeps running the old handlers, so a bug that is fixed on disk still misbehaves at
runtime with no visible signal. The daemon captures the git short SHA of the
source it is running (`GET /daemon/status` → `codeSha`), and `lazy daemon status`
compares it against the working tree's current HEAD, printing a `⚠ Daemon is
STALE` warning pointing at `lazy daemon restart` when they diverge. `codeSha` is
absent for compiled/installed binaries (no source tree), where the `version` and
`Built` timestamp already convey staleness.

### Surviving a daemon restart (credential refresh)

In daemon-proxy mode the container reaches the daemon using a small config file
minted at launch and bind-mounted in: the caller's own MCP token (see
[Identity comes from the token](#identity-comes-from-the-token-not-the-url) below)
plus a target of `http://host.docker.internal:<web port>`. Both values are frozen
at launch, so a daemon restart used to strand the session — **every** `lazy_*` tool, read-only
ones included, returned a bare `Unauthorized` until the session was relaunched.

MCP tokens are persisted (`~/.lazy/daemon/<slug>/mcp-tokens.json`) and the daemon
prefers its last-bound port, but the port part is best-effort: the `26024+` window
is shared by *every* project on the host, so another project's daemon can take ours
while ours is down. When that happens the token is still correct and the *daemon* is
wrong — the old port now answers with a foreign daemon that rightly refuses us. Two
mechanisms recover a live session:

1. **The daemon rewrites the configs it already minted** on every start, to its
   current target. It never rewrites the token: that is bound to one identity
   server-side and outlives the restart on purpose, so overwriting it would hand a
   live container an identity that is not its own. The rewrite is **in place** — a
   single-file bind mount
   pins the inode, so a write-temp-then-rename would be invisible inside the
   container. `test/unit/daemon-mcp-config-refresh.test.ts` asserts the inode
   precisely so this is never "hardened" into an atomic replace.
2. **Clients re-read that file when a call fails to reach the daemon, and retry
   exactly once.** This holds for the stdio MCP proxy, the supervisor's
   `DaemonClient` (which re-reads `~/.lazy/daemon/<slug>/token`), and the builder's
   conversation-capture storage, whose client lives for the whole session and so
   *will* outlive a restart.

**A moved port usually produces no 401 at all.** This healing was originally wired
to the 401 branch alone, which only covers the case where a *foreign* daemon took
the old port. The commoner outcome is that nothing took it: `fetch` then fails at
the transport layer with ECONNREFUSED, the corrected address sits unread in the
mounted file, and every `lazy_*` tool reports "the daemon appears to be down" for
the rest of the turn. So the proxy now refreshes on a transport failure too, on
exactly the same terms as a 401 — same trusted file, one retry, no loop.

That retry is restricted to a connection that was **never established**. A call
lost mid-flight may already have run on the daemon, and lazy tools are not
idempotent — a replayed `lazy_commit` would commit twice — so those are reported,
never retried (`isMidFlightTransportFailure`).

Because the rewrite is an in-place truncate, a reader can legitimately land
mid-write. Both the refresher and the MCP server's startup read
(`readDaemonMcpConfigWithRetry`) retry a torn file rather than treat one bad parse
as "nothing changed"; a torn read at startup used to kill the server process, and
Claude Code does not respawn one, costing the agent every lazy tool for the whole
turn. For the same reason the `mcp` subcommand installs `uncaughtException` /
`unhandledRejection` guards that keep the server up — scoped to that subcommand, so
the supervisor and builder paths keep failing loudly.

The refresh never weakens the check: the only credential source is the same trusted
local file, an unreadable or malformed source reports no change so the failure
stands, unchanged credentials skip the pointless second round trip, and there is no
retry loop. All tools share one config object and one refresher, so healing any tool
heals them all — matching the failure, which was always total. A 401 that survives
the refresh reports the actual cause, using `GET /daemon/status` → `projectRoot`
(unauthenticated on TCP for exactly this diagnosis) to say when the daemon on that
port belongs to a *different* project.

Covered by `test/unit/daemon-mcp-transport-refresh.test.ts`. A real mid-turn daemon
restart can only be verified live — see "How to verify" in the task.

### A rebuild is a gap, not a move

Re-reading once heals a daemon that has *already* come back somewhere else. A
rebuild-and-restart is different: for seconds to minutes there is no daemon at all.
A call landing in that gap re-read an unchanged file, found nothing listening, and
died with "the daemon appears to be down … exit and relaunch this builder" — losing
a whole builder conversation for a routine restart, and ending task-agent turns as
`MCP error -32000: Connection closed`.

So a connection that was **never established** now waits for the daemon to come
back, instead of giving up on the first attempt:

- The wait is bounded (`RECONNECT_WINDOW_MS`, 90s) with exponential backoff, and
  when it runs out the call fails with the same actionable message as before.
- The mounted config is re-read on **every** round, so a daemon that came back on a
  different address is picked up mid-wait.
- A call lost **mid-flight** is still never replayed — the window does not change
  that, for the same non-idempotency reason as above.
- The proxy reports progress while it waits (`notifications/progress`), so the human
  sees "the daemon is not answering — waiting for it to come back" rather than a
  silent hang. These frames state something the proxy is observably doing; they are
  not an invented keepalive, and both waits are capped well below the client's idle
  budget.

The second gap is a daemon that comes back **without this session's token record** —
registry moved by an upgrade, cleared by a repair, label evicted by the 50-entry
builder cap. Re-reading the file then finds the same dead token forever, and nothing
container-side can mint a new one. The fix is owner-driven, not daemon-driven:

- `lazy builder` runs a watcher (`src/builder/mcp-reissue.ts`) that polls
  `GET /daemon/status` and, when it sees a *different* daemon instance (pid /
  buildTime / codeSha) or one that had been away, asks the daemon for a config under
  **its own label** — the same `queryDaemonMcpConfig` call it makes at launch, which
  reuses the existing token when the registry still has it and mints a fresh one when
  it does not, and rewrites the same mounted path in place.
- Container-side, a 401 that a re-read cannot immediately fix waits briefly
  (`REAUTH_WINDOW_MS`, 20s) for exactly that file to change, then gives up.

Deliberately *not* done: having the daemon re-mint tokens for every MCP config file
it finds lying around at startup. That would resurrect credentials whose sessions are
gone — including ones deliberately revoked — and break "a builder token dies with its
builder session". Every security property holds unchanged: one identity per session,
credentials only ever read from the trusted local 0600 file, nothing adopted from the
wire, revoke still final, and the watcher stops (awaiting any in-flight re-issue)
before the session's revoke runs.

The same machinery covers task agents: they share this proxy, so a mid-turn restart
is waited out there too. Covered by `test/unit/daemon-mcp-reconnect.test.ts`,
`test/unit/builder-mcp-reissue.test.ts`, and `test/e2e/daemon-restart-mcp.test.ts`
(a real daemon stopped and started under a live session).

### When the tools are gone anyway: the end-of-turn handoff file

Healing is best-effort; the channel can still be down when a turn ends. What an
agent holds at that moment — its journal entry and its follow-ups — is the most
expensive thing in the turn to lose, and agents improvised: they ran the lazy CLI
in the container (which fails with EROFS, and would bypass the daemon's storage
ownership even if it could write), then pasted the journal text into the summary
for the human to re-enter by hand.

The fallback is deliberately dumber than MCP and shares no failure mode with it.
The agent appends NDJSON to `<worktree>/.lazy-task-sandbox/turn-handoff.jsonl` —
a directory that is already mounted read-write in every runner and gitignored:

```
{"kind":"journal","content":"Chose X over Y because …"}
{"kind":"followup","content":"The retry path in foo.ts swallows errors."}
```

The supervisor clears any stale file before the agent runs, then collects it after
(`src/supervisor/turn-handoff.ts`) and puts the entries on the protocol response —
on the success path *and* the error path, because a watchdog kill is exactly when
an agent's own account of the turn is most worth keeping. The reconciler persists
them through Storage like every other write, so ownership is preserved and the
container never needs a credential.

Collection is non-fatal by construction (no file is the normal case; a truncated
or junk line is skipped individually) and capped at 50 entries / 20 000 characters
each. Persistence is idempotent **by content**: the reconciler re-runs, and an
agent whose tools came back may have both written the file and made the call.
Ask turns are excluded — they are read-only. Covered by
`test/unit/agent-turn-handoff.test.ts`.

### Surviving a daemon restart (proxy address re-resolve)

The MCP config is not the only value frozen at launch. With the proxy on — the
default — a builder is launched with `ANTHROPIC_BASE_URL` pointing at the
daemon's local audit/policy proxy, and that port is **OS-assigned**
(`[proxy] port` is optional precisely so per-project daemons don't collide), so
a restarted daemon almost always serves the proxy somewhere else.

For a command that launches and exits this is invisible: the address is resolved
in `createRunner`, used once, and the process ends. `lazy builder` is the
exception — it holds one runner across a `lazy upgrade`, which stops the builder
container, rebuilds, and **restarts the daemon**, and then relaunches the child
into the same terminal (`src/builder/relaunch.ts`). The credential and the MCP
config are re-fetched from the daemon on every launch, and storage is re-resolved
per access, so those healed themselves. The proxy address did not: it was
stamped onto the runner's role targets at startup, and an already-set `proxyUrl`
is treated as authoritative everywhere downstream (`needsLiveProxyUrl`,
`resolveAuthEnvFromDaemon`). The relaunched builder therefore came back pointed
at a **dead port** and every model call failed until the human relaunched by hand.

The relaunch loop now re-resolves it (`refreshRunnerProxyTargets`, `src/runner/index.ts`)
at the one correct moment: after the wait has confirmed the new daemon is
serving, and before the child is launched with it. Two properties are
load-bearing:

- **It fails loud rather than degrading.** An unresolvable address throws
  `ProxyUnavailableError`; the loop reports it and does not relaunch. Coming back
  on the stale address means a dead endpoint, and coming back with no address
  means an unaudited direct connection to `api.anthropic.com` — both are worse
  than saying why the session was not resumed.
- **It runs before the resume intent is consumed**, so a failure leaves the
  session recoverable with the `lazy builder --resume <id>` the loop prints.

### Knowing WHICH conversation to resume (session-id recovery)

Re-resolving the proxy gets the relaunched builder a working endpoint. It still
has to come back into the *same conversation*, and that turned out to be a
separate, independently broken problem: the relaunch resumed nothing, or resumed
the wrong session.

The id was only ever produced on an exit path that did not run. In docker mode
`launchBuilderInteractive` returns `sessionId: null` — only the in-container
supervisor diffs the JSONL files and learns the id — and it stamped that id onto
the builder-resume-intent *after* its Claude child exited. `lazy upgrade` stopped
builder containers with `docker kill`, i.e. SIGKILL: the supervisor was not
signalled, never reached the stamp, and the intent went to the relaunch loop with
no `sessionId`. The loop then fell through to its last-resort fallback — the
newest captured conversation anywhere in the project — which is not necessarily
this builder's session at all.

Three changes, in order of how much they carry:

- **The host detects the id itself** (`src/builder/session-detect.ts`, called from
  `launchOnce`). Claude writes `<projects>/<encoded-cwd>/<sessionId>.jsonl` into a
  directory the host bind-mounted into the container, so the evidence is host-side
  the entire time the session runs. After the container exits, the host takes the
  newest session file modified at-or-after the launch instant — per-builder
  isolation dir first (unambiguous), then the shared `~/.claude/projects` (where
  sessions land when the isolation mount was dropped). This needs no cooperation
  from the thing that died, which is the property exit-time stamping lacked: it
  works under SIGKILL, an OOM, a crashed supervisor, or a sleeping machine. The
  launch-instant cut is what keeps host-*seeded* history out — seeding preserves
  the originals' mtimes, so seeded copies always sort as pre-launch.
- **`lazy upgrade` stops builders gracefully** (`docker stop --time 10`, via
  `stopRun`'s opt-in `gracefulTimeoutSeconds`) so the supervisor's signal handler
  actually runs. That matters beyond the id: the handler performs the final
  conversation capture, so the last stretch of the human's session is not lost
  from lazy's store. Task supervisors are still killed immediately — they have no
  exit work, and a grace period there is pure latency in the daemon's hot path.
- **The supervisor's stamp moved onto the signal path.** It now hangs off the
  capture monitor's memoized `stop()` (`onFinalSession`), so the graceful exit and
  the SIGTERM handler converge on the same stamp, exactly once, instead of it
  living after `await proc.exited` where a signalled supervisor never reaches it.

The last two are belt-and-braces; the host-side detection is the one that holds
when nothing in the container gets to run.

### Whose credential the builder uses (the `/login` loop)

Every container lazy launches is handed the daemon's credential as an env var
(`CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY`; `src/daemon/auth-env.ts`). The
builder is no exception — it authenticates exactly like a task agent and like
pairing. What went wrong was never *which* credential it started with; it was
that the builder could be talked out of it mid-session.

Two facts about Claude Code, both read off the shipped binary rather than
inferred. First, the env var wins outright, and the record it synthesises from
the env var has no refresh token:

```js
TU = memo(async () => {
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return fs();   // env wins, unconditionally
  ... otherwise read ~/.claude/.credentials.json
});
fs = () => ({ accessToken: env.CLAUDE_CODE_OAUTH_TOKEN, refreshToken: null, ... });
```

Second, `refreshToken: null` selects a specific branch of 401 recovery — read the
credential store off disk, and if it holds a *different* access token, adopt it
by overwriting the process env:

```js
let stored = (await store.readAsync())?.claudeAiOauth;
if (stored?.accessToken && stored.accessToken !== failedToken) {
  if (env.CLAUDE_CODE_OAUTH_TOKEN) process.env.CLAUDE_CODE_OAUTH_TOKEN = stored.accessToken;
  return true;   // tengu_oauth_401_recovered_from_disk
}
```

The builder mounted the human's real `~/.claude`, credential store included. On a
host that authenticates by env var, the `claudeAiOauth` record in that store is a
short-lived OAuth token nothing has refreshed in weeks. So **one** transient 401
was enough: recovery swapped the builder's good daemon credential for the host's
stale one and reported success. Every request after that failed with `401 OAuth
access token has expired`, and the *next* 401 found nothing new on disk and fell
through to `Please run /login`. A login inside the container wrote back to the
human's real store — a hidden side effect of running a container — and the next
launch re-injected the daemon token anyway, so it never appeared to stick.

This explains the shape of the bug exactly: **occasional** (needs a transient 401
to trigger), **builder-only** (a task agent's sandbox `.claude` has no credential
store, so the same branch finds nothing and there is nothing to adopt),
**concurrent agents unaffected**, and **the daemon token valid throughout** — the
builder had simply stopped using it.

**The rule** (`src/builder/claude-home.ts`): the builder always receives the
daemon credential, and the container's `~/.claude/.credentials.json` is shadowed
with an empty store — a deeper, more-specific bind over the `~/.claude` mount,
the same trick `projects-isolation.ts` uses for `~/.claude/projects`. Settings,
commands, agents and plugins stay shared. Nothing is lost: with the env var set
the host store was never read for authentication in the first place, and an
in-container `/login` still works for that container's lifetime — it just can no
longer reach through to the human's real record. Agents are untouched.

The builder's `~/.claude.json` is a separate, *persisted* file
(`.lazy/builder-claude-config.json`), seeded once from the human's and thereafter
authoritative. It holds no credentials — onboarding state, theme, folder trust,
model choice, MCP approvals. It used to be a per-launch temp file, which
discarded every answer Claude Code wrote during the session and re-prompted on
the next launch.

That persisted file is **not** the file mounted into the container. Lazy merges
its own `mcpServers.lazy` entry — carrying this launch's `--daemon-config <path>`
— into a *per-launch* copy, `.lazy/tmp/builder-claude-<builderId>.json`, and
mounts that at `/home/user/.claude.json`; on exit the copy is folded back into
the persisted file with the `lazy` entry stripped, since that path is minted
fresh and revoked each launch. Mounting the persisted file directly was a real
bug: a single-file bind mount pins the inode, so a second launch of the same
project rewrote the running container's config in place, pointing its MCP server
at a credential file that container never had mounted. The builder then ran the
whole session with no `lazy_*` tools and nothing said why. `lazy upgrade` made it
routine rather than rare — it stops every builder of a project at once and each
host wrapper relaunches off the same daemon-healthy poll, milliseconds apart.

The MCP identity label — the key the daemon binds the token to, and the key the
builder revokes on exit — is `builder-<builderId>`, drawn per launch, never
`builder-<timestamp>`. The clock-derived spelling was the same bug through a
third door: two builders starting in the same millisecond shared a label, so the
registry (which reuses a token per identity key) handed them one token, and the
first to exit revoked it out from under the one still running. Same silent,
tool-less symptom, a ~1 ms window instead of a ~150 ms one. The label is computed
once, from the id that already names the container, and handed to mint, to the
reissue watcher and to revoke.

Three checks make any recurrence loud instead of silent
(`src/builder/mcp-config-check.ts`). The host refuses to `docker run` unless the
credential exists and the config names that exact file. The in-container builder
supervisor re-checks both against the mount it actually got. Then it **starts the
MCP server the config names** and requires a real `initialize` response — the
general net, catching causes nobody enumerated rather than the two we know. Each
failure names expected vs actual, and the probe quotes the server's own stderr.

That last point is why the probe spawns its own child. Claude Code's MCP child is
a *grandchild* of the supervisor whose stderr Claude owns: it drains it into
`~/.cache/claude-cli-nodejs/<cwd-slug>/mcp-logs-lazy/<ts>.jsonl` as
`{"error":"Server stderr: …"}` and re-emits only an opaque `-32000: Connection
closed`. Nothing in the supervisor's process tree can read that stream, so the
only way to hold the server's own words is to start the server ourselves. For the
mid-session case a launch probe structurally cannot see — a daemon restart, an
evicted token, a crash on the tenth tool call — the supervisor scans that same
log after Claude exits and prints anything it finds. That scan is deliberately
tolerant: the format is Claude Code's, so a change to it degrades to today's
silence rather than to a false alarm.

It is also deliberately narrow. Claude Code writes tool-call error *results* into
that same file as `{"error": …}` lines, so a raw scan reports a healthy server —
one answering `lazy_accept` with its confirmation-code gate, or rejecting an
over-long memory description — as a connectivity failure, which is how the banner
came to fire on nearly every v0.21 beta session. Those entries are recognised
structurally, by Claude's own framing rather than by matching lazy's error text:
a tool result is echoed a second time as
`{"debug":"Tool '<name>' failed after <d>: <same text>"}`, while the availability
paths (`Server stderr: …`, `Connection failed …`, `Error during reconnection: …`)
have no tool in scope and no such echo. Entries that pair with a tool-failure
debug line are dropped; everything else, recognised or not, is still reported.

Task agents cannot hit this by construction and deliberately share none of the
machinery: no host `~/.claude.json` is mounted into an agent container at all.
Each agent writes its own at the start of every turn, on the container's own
ephemeral filesystem, from the `LAZY_DAEMON_CONFIG` path that container was
launched with (`src/supervisor/mcp-setup.ts`). There is no shared host file for a
concurrent launch to clobber.

The reason this was hard to find is that nothing could tell the human their
credential was dead. The daemon gate checks presence, not validity, and says so
(`src/daemon/credential-gate.ts`), closing with the note that the authoritative
signal is the upstream 401 the audit proxy already sees. Nothing read it. `lazy
doctor` now does (`src/proxy/auth-verdict.ts`): a 401/403 in the audit trail with
no later success is reported as "the model API rejected lazy's credential", with
the re-mint steps. The verdict is derived purely from the order of statuses, so
it clears itself the moment a good token succeeds — no stored flag to go stale.

### One `/resume` list per project (builder session isolation)

Every `lazy builder` launch under a sandbox runner gets its own Claude projects
dir, `<data>/builder-projects/<id>/`, bind-mounted over `~/.claude/projects` in
the container (`src/builder/projects-isolation.ts`). That is what stops two
builders running side by side from capturing each other's session JSONLs. The
cost is that history is now spread across N dirs, so each launch is **seeded**
from the union of the shared `~/.claude/projects` dir and every other isolation
dir before the container starts — mtimes preserved, so a copy never looks newer
than the line it came from.

Four rules keep the seeded union honest, and each was a bug before it was a rule:

- **Resume never falls back to the shared dir.** The shared dir is a seeding
  *source* but never a *sink*: nothing born under isolation is copied back into
  it. Mounting it for a resume therefore showed a strictly older, disjoint slice
  of history — which `/resume` list you got depended on which session id you
  resumed. Resolution now mounts an isolation dir or nothing.
- **A stale seeded copy is refreshed from the newest copy elsewhere.** Skipping
  any file that already existed let per-dir snapshots drift apart permanently.
  Refresh never runs backwards, though: a copy that is *longer* than the source,
  or that has grown past its seed-time size, is left alone.
- **Length measures history, not recency.** Session JSONLs are append-only, so a
  copy's size is evidence and its mtime is not — merely mounting a dir bumps the
  file's mtime without adding a byte. Resume picks the largest copy and uses
  mtime only to break a size tie. Ranking by mtime once resumed a two-hour-old
  copy over the complete transcript sitting in another dir.
- **A seeded copy Claude appended to is no longer a seeded copy.** Growth past
  the recorded seed-time size can only have come from Claude writing inside the
  container, so such a copy is reclassified as container-written: resumable, and
  write-trusted like any other container-written copy.

What `/resume` shows is bounded by Claude Code's own retention window
(`cleanupPeriodDays` in your `~/.claude/settings.json`, which the `~/.claude` mount
carries into containers) — lazy does not extend it; the full conversation history
lives permanently in lazy's store and is reachable via `lazy builder list`.

Each dir carries a `.lazy-seeded.json` manifest listing the sessions that were
copied in host-side (`seededSessionIds`), the ones adopted with `--import`
(`adoptedSessionIds`), and each seeded file's size and mtime *at seed time*
(`seededFileStats`). A session present on disk but *absent* from
`seededSessionIds` is one Claude wrote from inside the container — the only
positive evidence that the container user can write there, which is what lets a
resume mount survive a transiently failing write-probe. A seeded session whose
file is now *larger* than its `seededFileStats` baseline counts as the same
evidence, for the same reason: nothing on the host appends to a seeded copy.

Manifests written before `seededFileStats` existed have no baseline, so growth
is undecidable there. For those, a longer seeded copy is still promoted over a
shorter usable one when it is a byte-exact *extension* of it — the same
conversation carried further. That promotion makes the dir resumable but grants
no write trust: a host re-seed extends a copy too, so it is not proof the
container can write there. If the longer copy is not an extension, the two
copies genuinely diverged; resume keeps the container-written one and logs a
warning naming both dirs and sizes rather than guessing.

#### Adopting a session that never ran under isolation: `--import`

A session whose every copy is host-seeded (or that lives only in the shared dir)
has never run under builder isolation. Resuming it means *choosing* an overlay to
make authoritative for it — an adoption, not a resume. `lazy builder --resume <id>`
used to do that silently; it now errors and names the remedy:

```
Session <id> exists, but has never run under lazy's builder isolation.
Resuming it here would adopt it into this project's builder session history.

Adopt it deliberately:  lazy builder --resume <id> --import
```

`--import` performs exactly the same overlay selection and seeding, just opted
into, and records the id in the manifest's `adoptedSessionIds` so later plain
resumes of that session land in the same dir without asking again. Adoption
records *intent* only: the copy is still host-written, so it earns no write
trust and the write-probe still gates the mount. A session with a
container-written copy anywhere is unaffected — it resumes silently, and the
error can never fire for it. An id that exists nowhere is also unaffected: it
falls through to Claude's own "no conversation found" report rather than being
mislabelled as importable. (This is unrelated to `lazy import-conversation`,
which brings history into lazy's *store*; `--import` only decides which projects
dir a builder mounts.)

### Long operations: the heartbeat envelope

A daemon request can legitimately run for minutes — `lazy_wait` long-polls for up
to 600s, and a large `accept` holds the request across a merge, fast-forward and
push. `Bun.serve` reaps a connection whose handler has produced no bytes after
`idleTimeout`, and a handler that has not returned a `Response` yet produces
none. With both listeners on `idleTimeout: 120`, *every* operation past two
minutes died mid-flight: the client saw a socket close or "operation timed out"
while the daemon itself kept answering short RPCs normally.

Nothing about the timeout configuration can fix that. `Bun.serve` refuses
`idleTimeout > 255`, so no value covers a 600s wait, and `server.timeout(req, n)`
extends the deadline on the TCP listener but is ignored on the unix socket.

What does work is writing bytes, so long routes reply with a streamed
newline-delimited JSON **envelope** (`src/daemon/heartbeat.ts`):

```
{"lazyEnvelope":1}                <- immediately, on request receipt
{"heartbeat":5000}                <- every 5s while the handler runs
{"status":200,"body":{...}}       <- once, when the handler settles
```

Each line resets the idle timer. The HTTP status of an enveloped reply is always
200 — headers must go out before the outcome is known — and the real status
travels in the final line, which `DaemonClient.rpc` and the in-container MCP
proxy reconstruct before applying their normal success/failure logic.

Two properties are load-bearing:

- **Opt-in per request** (`X-Lazy-Heartbeat: 1`). A container launched before
  this framing existed holds a client that would choke on NDJSON, so a daemon it
  upgrades under must keep replying in plain JSON to requests without the header.
- **A truncated stream is diagnosable.** A stream that ends without its result
  line means the connection died while the operation ran — reported as
  `DaemonConnectionLostError` ("the operation may have completed on the host,
  re-check state"), never as an unreachable daemon. The old code reported every
  transport throw as "the daemon appears to be down, relaunch this builder",
  which sent an engineer down a recovery path that could not help.
- **"Down" is a claim that gets checked.** A transport failure whose wording
  matches neither list (never-connected vs lost-mid-flight) is no longer guessed
  at: the proxy probes `GET /daemon/status` (3s budget) and lets the answer
  decide. Answering ⇒ `DaemonConnectionLostError`, with the probe result stated
  in the message; answering for a *different* `projectRoot` ⇒ a foreign-daemon
  diagnosis naming both roots; no answer ⇒ the unreachable message, which now
  also says the probe was made. Cost is one 3s HTTP GET on a path that has
  already failed. This closes the field case where two `lazy_wait` calls reported
  "the daemon appears to be down" against a daemon answering `/daemon/status` in
  5ms and serving every other tool call from the same session.

In-flight work is deliberately **not** cancelled when the client hangs up: a
half-applied merge is worse than an unread result. Stated as a rule — **the
daemon always finishes; the client's abort only decides whether the answer is
delivered.** That holds at both hops: `Bun.serve` runs the handler to completion
after a client abort (only the writes are discarded), and an MCP
`notifications/cancelled` is logged without touching the running call. It is
pinned by tests rather than assumed, in `test/unit/daemon-heartbeat.test.ts` and
`test/unit/mcp-server-progress.test.ts`.

The corollary is that an aborted client must not leave the task *unexplained*.
Accept's abort paths (a pre-accept turn that times out, a supervisor that fails
to launch) record a `system` comment on the task before throwing, so the reason
survives even when the RPC error reaches nobody — the field symptom was a task
that fell back to `blocked` with no trace of why.

`test/unit/daemon-heartbeat.test.ts` proves the mechanism against a real
`Bun.serve` with a shrunken idle timeout (including a control case that must
still fail), and `test/e2e/daemon-responsiveness.test.ts` asserts against a real
daemon that heartbeats reach the wire during a real long RPC and that short RPCs
still answer within 2s while it is in flight.

### The second hop: heartbeats become MCP progress

Framing keeps the HTTP hop alive, but the agent's client is one hop further out,
and it runs its own idle clock. Claude Code (measured against 2.1.220) arms a
per-call watchdog that is reset **only** by the tool result or by a
`notifications/progress` message — "sent no response or progress for 1800s;
aborting" — with a 30-minute default for stdio servers. The stdio MCP server
(`src/mcp/server.ts`) emitted neither for the whole duration of a call, and the
daemon proxy (`src/daemon/mcp-proxy.ts`) parsed the heartbeat lines only to skip
them. So the heartbeats stopped dead in the process that read them.

That is a guaranteed failure for accept, not a rare one: an accept runs a
pre-accept validation turn bounded at `PRE_ACCEPT_TIMEOUT_MS` — 30 minutes, the
same number as the client's idle budget. The field case: `lazy_accept` entered
pre-accept, the client aborted at 1800s, the daemon kept working, and the merge
never ran.

The fix relays what already exists. `readHeartbeatEnvelope` takes an
`onHeartbeat` callback, the proxy handler receives a per-call
`McpToolCallContext` (`{ reportProgress }`), and each relayed heartbeat becomes a
`notifications/progress` line on stdout:

```
{"lazyEnvelope":1}          (HTTP)  ->  notifications/progress  progress:1
{"heartbeat":5000}          (HTTP)  ->  notifications/progress  progress:2
{"status":200,"body":{...}} (HTTP)  ->  the tool result
```

Three rules hold it in place:

- **Progress comes from evidence, never from a clock of our own.** A locally
  driven keepalive would make a wedged handler look healthy forever and defeat
  the very watchdog it satisfies. A handler that reports nothing emits nothing,
  and the client is right to abort it.
- **No token, no notifications.** MCP permits progress only for a request that
  carried `_meta.progressToken`; an unsolicited notification is a protocol
  violation some clients drop the connection over.
- **A failure to report is never a failure of the call.** The relay is wrapped:
  a throwing progress channel is logged, not propagated.

`notifications/cancelled` is logged and otherwise ignored — see the in-flight
rule below. The **local** (no-daemon) MCP mode has no heartbeat stream to relay
and so has no progress; that gap is stated on `startMcpServer` rather than left
implicit, and every production agent and builder uses the daemon proxy.

Covered by `test/unit/mcp-server-progress.test.ts` (the protocol rules, driven
in-process), `test/unit/daemon-mcp-proxy.test.ts` (heartbeats relayed mid-call),
and `test/e2e/mcp-long-wait.test.ts`, which drives a real `lazy-agent mcp`
subprocess and asserts progress lines land on stdout *before* the result.

### Every route has an answer

The envelope only helps the routes that use it, so "which routes are exposed to
the idle timer?" must have no unknowns. Every route is classified as **framed**
(the envelope keeps it alive) or **bounded** (an argument for why it cannot
approach the timeout), and the classification lives next to the routes as a table
in `src/daemon/server.ts` that is meant to be extended whenever a route is added:

| Route | | |
| --- | --- | --- |
| `POST /rpc/{command}` | framed | `wait` long-polls up to 600s |
| `POST /mcp/:taskId/:toolName` | framed | tool calls run for minutes (accept, sync) |
| `POST /builder/storage` | framed | a `saveConversation` of a long session is a large write |
| `GET /daemon/status` | bounded | see below |
| `POST /daemon/shutdown` | bounded | schedules a 50ms timer, returns at once |
| no match → 404 | bounded | constant body, no I/O |

`/daemon/status` carries two separable claims. It *cannot* approach the timeout:
it makes no Storage call, takes no lock, touches no network, and does nothing
proportional to project size — only small file reads and one memoised
`git rev-parse`, which is why storage pressure does not reach it. And it *must
not* be framed even if that ever stopped holding, because it is the liveness
probe and its callers include curl, browsers, and user-written health checks that
cannot read NDJSON — a probe that answers "still working on it" for two minutes
has already failed. If it ever grows expensive work, the fix is a cache.

### Every error keeps its status

`/rpc/{command}` and `/mcp/:taskId/:toolName` answer with the status the error
itself carries — `RpcError(400)` from a handler that rejected its arguments,
`RpcError(404)` for a task that does not exist, `RpcApplicationError` relayed
from another daemon call. 500 is reserved for errors that carry no status at
all. Both routes get it from one helper (`httpStatusForError` in
`src/daemon/mcp-routes.ts`) so they cannot drift, and because the status is
computed once inside `produce()`, the heartbeat envelope's final
`{"status":N}` line carries the same value as the plain reply.

This is not cosmetic. Flattening a 400 to a 500 makes a caller's argument
mistake indistinguishable from a daemon crash: the operator debugs the daemon,
and the client-side classifier in `src/daemon/mcp-proxy.ts` is trained on the
lie. The historical leak was on the way out of the handler rather than in the
route — `queryWait` re-wrapped its `RpcError` as a plain `Error`, so the route's
status test never matched. Any RPC fallback that catches an `RpcError` must
re-throw it intact.

The `:taskId` path segment is validated before task resolution
(`validateMcpTaskSegment`): the builder segment `_`, a task id, a short id, or a
code. Anything else — most usefully a daemon bearer token pasted into the path
instead of the `Authorization` header — is a 400 naming the mistake, not a
`Task not found: <garbage>` from the store.

### Every request is parsed before it is dispatched

A route may not assume a well-behaved client. **Every external surface parses its
inputs and confirms them; no surface may rely on *not* being the surface someone
hand-rolls a request against.**

`POST /mcp/:taskId/:toolName` used to take `body.arguments ?? {}` and dispatch.
Each tool already ships an `inputSchema` — the same one advertised to the agent —
and the route ignored it, so a declared `required` field was documentation
rather than a check. A body that omitted the `{"arguments": {...}}` envelope,
which is exactly what an agent writing its own HTTP fallback sends, therefore
dispatched with *no* arguments: `lazy_commit` ran `git commit -m undefined` and
produced a real commit whose message was the literal string `undefined`, and
`lazy_journal` wrote an empty entry the same way. A corrupt write, from a
request that never should have reached a handler.

Validation now happens at the boundary, before any handler runs:

- **Body shape.** A body that is present but unparsable, or that parses to
  something other than an object, is a 400 quoting what arrived
  (`src/daemon/http-body.ts`). It used to be `req.json().catch(() => ({}))` — a
  truncated payload silently became a different, emptier request.
- **Envelope.** A body with no `arguments` key but with top-level keys that *are*
  parameters of the tool gets a 400 that names the mistake — "did you forget the
  arguments envelope?" — rather than "missing required parameter 'message'",
  which would send the caller looking for a value sitting right there in their
  body.
- **Schema.** Arguments are checked against the tool's declared `inputSchema` —
  required fields, `type` (including unions), `enum`, `minLength`/`maxLength`,
  `pattern`, and array element types — by a small dependency-free validator
  (`src/mcp/validate-args.ts`). A violation names the field and shows the
  expected envelope.

The validator covers a deliberately closed subset of JSON Schema: the keywords
lazy's own tool definitions use. A unit test walks every dispatchable tool schema
and fails if one uses a keyword the validator does not implement, because an
unenforced keyword is the original bug wearing a different hat. Extend the
validator when you extend a schema.

The same check guards the other two surfaces onto the same handlers: the stdio
MCP server (`src/mcp/server.ts`, as JSON-RPC `-32602`) and the builder's
`POST /tool/:name` (`src/builder/server.ts`, which had the identical
`body.arguments ?? {}`). On `/rpc/{command}`, handlers read their parameters
through typed accessors (`src/daemon/rpc-params.ts`) instead of
`params.taskId as string` — a cast satisfies the compiler and checks nothing at
runtime, so a wrong-typed value used to pass the presence check and reach the
lifecycle code, where it surfaced as a 500.

Rejection is total: a request that fails validation performs no work at all. A
400 that still wrote something would be the same corruption with better manners.

### Identity comes from the token, not the URL

The `:taskId` segment is a **claim** made by the caller; it proves nothing. While
every agent presented the same shared daemon token, any agent could claim any task
id and act as that task — pose as its own parent and accept itself, unblock a
sibling, close someone else's work. Every server-side ownership gate was therefore
advisory against a deliberately malicious agent.

Identity is now cryptographic. Each task session and each builder session gets its
**own** random token, bound server-side to exactly one identity
(`src/daemon/mcp-tokens.ts`). On every `/mcp` request `authorizeMcpCall` derives the
caller from the presented token and compares it against the claim:

| presented token | claimed segment | result |
| --- | --- | --- |
| task A's | `A` (id, short id or code) | executes as A |
| task A's | another task | **403** naming both ids |
| task A's | `_` (builder) | **403** |
| builder's | `_` | executes project-wide |
| builder's | any task | **403** |
| unknown / revoked / the shared daemon token | anything | **401** |

A mismatch is **refused**, never silently retargeted to the token's identity: a
caller acting on task B while believing it acts on task A is a worse failure than a
hard error, and a silent override would hide a real impersonation attempt. There is
deliberately no fallback to the shared daemon token on `/mcp` — keeping one would
restore the single shared identity this exists to remove. Other surfaces (the CLI
over the unix socket, `/rpc/*`) still use the shared token; they are host-side
callers, not agents in containers.

Where the tokens live is load-bearing: `~/.lazy/daemon/<slug>/mcp-tokens.json`
(mode 0600), the daemon's own state directory, and **never** under the project
root. Task containers bind-mount the whole repo read-only, so a per-task token
stored in-repo would be readable by exactly the agents it is meant to separate.
The minted config files moved to `~/.lazy/daemon/<slug>/mcp/` for the same reason.

Lifecycle: one live token per identity (a task is unblocked many times and its
container is reused — minting per turn would invalidate a live session or pile up
equally-valid tokens). The registry is on disk, so tokens survive a daemon restart,
matching the shared token's deliberate reuse. They do **not** survive their
session: `accept`, `reject` and `close` revoke the task's token, after which the
agent gets a 401 that says the session ended. A builder session has no lifecycle
event of its own — the human just closes the terminal — so `lazy builder` brackets
it: it revokes the token by the label it minted with once the builder supervisor
exits (`src/builder/mcp-session.ts`, called from the launch path's `finally`, so a
crash or an upgrade relaunch revokes too). That revoke goes through the daemon
(`/rpc/revokeDaemonMcpToken`), never by editing the registry file: the daemon caches
the registry in memory and only re-reads on a token miss, so a file edited behind
its back would leave the revoked token still accepted. It is best effort — a daemon
that is down must not break builder exit, so a failure warns and exits. The
registry's 50-entry builder cap now bounds only that residue (a SIGKILLed builder,
a daemon that was down at exit).

That cap evicts **residue before live sessions**. Dropping a builder's token costs
that session every `lazy_*` tool for the rest of its life, silently — so eviction
order matters as much as the cap does, and oldest-created-first (the original rule)
picked the worst victim available: the oldest record is the likeliest long-running
live builder. `lazy builder` now reports its own pid when it asks for a config
(`ownerPid`, refreshed on every re-issue), the daemon records it, and eviction takes
records whose owner is not provably alive first — oldest first within each group.
The signal is a `kill(pid, 0)`: no file I/O, so the hot verify path stays I/O-free,
and no daemon→runner dependency (the alternative was enumerating builder
containers). It works because `lazy builder` runs on the host, in the daemon's own
pid namespace. Costs: a record with no pid (minted before this, or by a caller that
sends none) is treated as residue exactly as before, and a recycled pid makes a dead
record merely *look* live — which only demotes it in the order. The cap stays hard:
when every retained builder is live, the oldest live one is still dropped.

### Builder conversation capture has its own surface: `POST /builder/storage`

The builder supervisor runs **inside** the builder container, and the project's
store is not mounted there, so its incremental conversation capture must write
through the daemon. It built that Storage from the same mounted daemon MCP config
the agent uses — and posted to `/rpc/storage`, which takes the **shared** token.
The result was a 401 on the very first capture tick of every containerized builder
session and every 30 seconds thereafter, for the whole session, visible only in a
log file inside the container.

The daemon-side capture sweep (`src/import/capture-sweep.ts`) covers the builder
isolation dirs, so the conversations themselves were still landing — but the
**resume-intent stamp** rides the same storage handle (`onFinalSession` →
`stampSessionIdOnStorage`), and the sweep does not replicate it. So the 401 was
also silently costing `lazy upgrade` its deterministic builder resume. Deleting the
supervisor's capture instead of repairing it was therefore not an option.

Neither existing surface could take the write:

- **Shared token in the container.** That credential also unlocks every
  `/rpc/<command>` CLI pass-through and the unrestricted Storage interface, to a
  container whose agent can read its own mounted config. Trading full CLI and
  store authority for a capture path is not a trade.
- **`/rpc/*` accepting MCP tokens.** That is the split the section above exists to
  establish; collapsing it re-creates the single shared identity.
- **A new MCP tool.** Tools are listed to the agent; capture is the supervisor's
  business, not something to hand the builder as a callable write.

So capture got a fourth surface, strictly narrower than any of them:

| | `/rpc/*` | `/mcp/:taskId/:tool` | `/builder/storage` |
| --- | --- | --- | --- |
| credential | shared daemon token | any MCP token, identity-matched | **builder**-kind MCP token only |
| exposes | every CLI command + all of Storage | the MCP toolset | 4 Storage methods |
| caller | host-side CLI | agent in a container | builder **supervisor** in a container |

The allowlist is `BUILDER_STORAGE_METHODS` in `src/daemon/rpc-handlers.ts`:
`getStoragePath` (probe + `getTaskDir`), `saveConversation`,
`listBuilderResumeIntents`, `saveBuilderResumeIntent`. Anything else is a **403**,
refused before storage is even opened. A task-kind token, the shared token, and an
unknown token are all **401** — the surface is defined by credential *kind*, not by
"at least as privileged as". Client-side, the route family is a property of the
credential: `DaemonClient.fromTarget(..., 'builder')` sends `client.rpc('storage')`
to `/builder/storage`, so `RemoteStorage` is unchanged.

Adding an entry to that allowlist widens what a compromised builder container can
do to the store. Give a new caller its own surface instead.

Both halves of the original failure are now loud. `preflightBuilderCapture`
(`src/supervisor/builder.ts`) proves capture can reach the store **before** Claude
Code launches and throws with an actionable message if it cannot — a session whose
history cannot be saved is not one to start. And the capture monitor accumulates
the distinct failure reasons it hits (`createCaptureFailureRecorder`) and the
supervisor prints them to stderr once Claude exits, next to the MCP-error report.
Every occurrence still logs; the summary is additional. Printing mid-session would
corrupt Claude Code's TUI, which is why the report waits for the exit.

### The daemon state dir is never mounted into a container

`/rpc/*` still authenticates with the single **shared** daemon token, and the token
registry sits in the same directory. Both are safe only because no container can
read that directory: an agent that could would not need to impersonate anyone over
`/mcp` — it would lift the shared token and call `/rpc/acceptTask` directly, or copy
another task's MCP token straight out of the registry.

Rather than rebuild `/rpc` auth, that is an **asserted invariant**:
`test/unit/daemon-dir-never-mounted.test.ts` derives the forbidden directory
structurally from `src/daemon/paths.ts` and checks the constructed container argv of
every launch path lazy has — docker and podman × one-shot agent, agent supervisor,
interactive builder — for a `-v` mount source inside it or an ancestor of it. The
one permitted exception is a container's **own** MCP config: a single regular file
under `<daemonDir>/mcp/`, bind-mounted read-only by absolute path. Mounting the
`mcp/` directory would let a container read every other identity's config. The three
arg builders (`buildDockerArgs`, `buildSupervisorDockerArgs`,
`buildBuilderDockerArgs`) are pure and exported so the check needs no Docker.

User-authored `[[mounts]]` entries were the one remaining way that directory
could reach a container, since they flow straight into the same argv. A bind
`source` inside the daemon base dir — or one that *contains* it, like `~/.lazy`
or `$HOME`, which exposes it just as completely — is now refused
(`src/capture/mounts.ts`), with the path derived from `src/daemon/paths.ts` and
an error naming the entry and the reason. Absolute sources are caught at
config-load time; a relative or `{repo}`-placeholder source that only *resolves*
into the dir is caught at launch, where `buildMountArgs` has the final host path.
The base dir rather than one project's slug dir is the boundary: another
project's daemon dir is someone else's shared token.

### The dashboard: a deadline instead of an envelope

The web dashboard (`src/server/index.ts`) is the genuinely unbounded surface —
the dashboard page and `/api/activity` walk every task and every turn, and a
commit page spawns `git diff`. None of it can be framed: the client is a browser,
which cannot opt in via `X-Lazy-Heartbeat` and cannot parse NDJSON.

So it gets the other half of the same guarantee — a deadline derived from the
listener's idle timeout (not written as a literal, which would silently drift if
the timeout were retuned). A request that overruns it ends as a real HTTP 503 the
user can read: JSON for `/api/*`, an error page otherwise. Without it the same
request is reaped by the idle timer with no status, no body, and nothing in the
log — indistinguishable, from the browser, from the daemon being dead.

The deadline wraps the whole route table, including the 404 and the error path,
so a route added later is bounded whether or not its author thought about this.
It is a backstop, not a performance budget: a dashboard render that takes that
long is already broken, and this only decides whether the user finds out.

## Naming: lazy vs lazy-agent

The binary is named `lazy-agent` (not `lazy`) because eventually both will be
separate MCP servers:

- **`lazy-agent`** — runs inside containers, exposes tools for the coding agent
- **`lazy`** (future) — runs on the host, allows the lazy builder to talk to lazy directly

These have similar but different APIs. The agent-facing tools (search, commit,
and the agent's own-subtree create/start/show/diff/wait/unblock/accept) are
ownership-scoped, whereas the builder's host-facing tools are unrestricted.

## Container Setup

The host mounts the agent binary into the container:

```
-v ${agentBinaryPath}:/usr/local/bin/lazy-agent:ro
```

The container's entrypoint runs `lazy-agent --protocol-dir ... --worktree ...`
which starts the supervisor loop.

### Git containment: the split `.git` mount

The repository is mounted read-only and the task's worktree read-write on top of
it — but the worktree is a *linked* git worktree, so all the state that matters
(refs, config, hooks) lives in the main repo's `.git`. That directory used to be
mounted read-write as well, which made the read-only repo mount cosmetic: an
agent could move any ref including `main`, rewrite its own branch history, or
merge a sibling task's branch. One did.

Interception cannot fix this — an agent has a shell, and `git` is not the only
way to write a file. The boundary is the mount table:

```
-v ${commonDir}:${commonDir}:ro                  # <repo>/.git — refs, packed-refs, config, hooks, logs/refs
-v ${objectsDir}:${objectsDir}                   # append-only, content-addressed
-v ${worktreeGitDir}:${worktreeGitDir}           # <common>/worktrees/<this task> — index, HEAD, MERGE_HEAD
```

Docker and Podman both resolve overlapping binds by longest container-path
match, so the two carve-outs win over the `:ro` parent regardless of argument
order (the same rule `[[mounts]]` relies on). Paths come from
`git rev-parse --git-common-dir --git-dir --git-path objects`, never from string
composition; a path that is not a linked worktree is refused outright, because
there is no split that keeps its index writable while its refs stay read-only.
See `src/capture/git-mounts.ts`.

What this costs inside the container: `git commit`, `merge`, `rebase`, `branch`,
`tag`, `update-ref`, `reset --hard` and `stash` all fail with EROFS. (`stash` is
collateral — it writes `refs/stash` in the shared dir.) Reads, `git add`,
`git diff`, checkout of a file and conflict resolution all work normally. Agents
commit through the `lazy_commit` MCP tool, which executes host-side in the
daemon. The sandbox `.gitconfig` also sets `gc.auto = 0`: an auto-gc inside the
container could only fail (it repacks objects and rewrites `packed-refs`), and
would surface as a confusing error on some unrelated git command.

The mount is the wall; the prompt tells the agent where the wall is. Agents were
discovering the boundary by trial and error and improvising around it — one used
`git stash` in a shared-git-dir worktree and popped a foreign stash from another
task, and one, having lost its MCP tools mid-turn, hand-rolled a daemon HTTP call
with a malformed body and produced a real commit whose message was the literal
string `undefined`. So both system-instruction prompts
(`src/prompts/system-instructions.md` and `…-resume.md`) now carry a "Git and
transport discipline" section stating the rules as design rather than as missing
capability: read/stage/`lazy_commit`/resolve-conflicts is the whole allowed set;
history rewriting, ref moves and `git stash` are out; the `lazy_*` tools are the
only channel to lazy state, and losing that channel is a reportable condition —
stop, commit nothing by another route, hand back what is uncommitted.
`test/unit/agent-git-discipline.test.ts` pins the two variants to identical
section text and asserts no agent-facing prompt points at a daemon HTTP endpoint
(the HTTP fallback is builder-only).

The supervisor runs in that same container and legitimately needs to move refs
during sync. Those operations moved host-side behind an internal MCP tool,
`lazy_internal_git` (`src/mcp/internal-git.ts`) — merge, merge-abort,
reset-to-HEAD, and turn tags. It is registered as a handler but deliberately
**not** in `allTools`: it is never advertised to an agent. Because the
supervisor reads its merge target from the protocol dir, which *is* writable in
the container, the daemon does not trust the requested target: a merge is
allowed only if the target commit is already reachable from one of this task's
own upstreams (its parent branch, or its own branch on the remote), and tag
names must match `turn/<taskid8>/<phase>/<sha>`. Merging a sibling branch is
therefore impossible even with a valid container token.

Whether a supervisor operation elevates is decided by the repository, not by
configuration: `src/supervisor/elevated-git.ts` probes the worktree's git common
dir for writability and runs git locally when it can (host-process runner, unit
tests, any repo outside the split mount), elevating only when the mount says it
must. Routing on `LAZY_DAEMON_CONFIG` instead would misfire, because that
variable is inherited by every child process of a supervisor's environment,
including ones operating on a different, writable repository.

Conflicted merges are now started host-side and **left in place** for the agent,
which resolves and stages, then calls `lazy_commit` to conclude them — the
merge-conflict prompts say so explicitly.

### A sync ends in one of three states, all loud

Leaving a conflicted merge in place is only safe if every exit from the merge
phase is accounted for. A sync therefore ends in exactly one of:

1. **merged and committed** — clean merge, or conflicts resolved and concluded;
2. **conflicted with resolution in flight** — the conflicted merge is on disk
   *and* a resolution agent turn was launched and recorded;
3. **aborted** — the merge is rolled back and the caller gets an error naming
   what happened to the files on disk.

A worktree with unmerged files and no resolution in flight is not a valid
outcome. `settleConflictedWorktree` (`src/supervisor/merge.ts`) enforces it:
every failure path in the merge phase goes through it, and its verdict is
attached to the error the supervisor reports (`merge_state` on the error
response) so the human sees whether their files are still conflicted. A failed
abort is reported as `settled: false` with the one command to run by hand — it
is never swallowed. The sync success path re-reads the worktree before reporting
success, and turns a still-mid-merge tree into a loud failure rather than a
`blocked` task that looks settled.

A **fully resolved but uncommitted** merge is concluded, not discarded. The
agent cannot create a merge commit from inside the container, so the supervisor
asks the daemon to do it (`merge_commit` on `lazy_internal_git`), which refuses
unless MERGE_HEAD exists and no path is unmerged. Aborting instead threw away a
complete resolution and asked for it again from scratch.

### Rolling back a half-merged worktree is loud and attributed

A rollback destroys work — possibly a human's or an agent's in-progress
resolution. Before aborting, the supervisor saves what it found to
`.lazy/recovery/merge-rollback-<timestamp>.patch`, reports it on the protocol
response (`worktree_recovery`), and the reconciler writes it to the task journal
attributed to the supervisor. The journal is the right home: durable, visible in
`lazy show`, and never fed back into a prompt.

Supervisor **startup** deliberately does not roll back. It is the one moment
with no command to attribute a rollback to, and a supervisor starts for every
turn — so rolling back there consumed the evidence before any recovery record
could be written. Startup reports the mid-merge worktree; the next command
recovers it and says what it discarded.

### Every status surface reports a mid-merge worktree

`lazy show` (text and `--json`), `lazy wait`, `lazy status`, and the MCP
`lazy_show` / `lazy_status` / `lazy_wait` tools all read the same probe
(`readWorktreeMergeState` / `describeMergeState` in `src/git/operations.ts`) and
say "unresolved merge — …" next to the status. `blocked` on its own reads as
"settled, waiting for you", which is a lie over conflicted files.

`accept` and `reject` distinguish the two cases before refusing: a mid-merge
worktree gets "unresolved merge … run `lazy sync <task>`", not "uncommitted
changes. Commit or stash" — advice that cannot work, since stashing a conflicted
merge fails and committing one records conflict markers.

Residuals, accepted: an agent can still write arbitrary *content* into its own
worktree and have it committed (content smuggling is out of scope — review is
the control), and the host-process runner enforces none of this (nothing is
enforceable there). The split mount also governs LOCAL refs only: `git push`
containment comes from credentials and network posture (a container holds no
push credentials and the remote is not a writable local path), not from this
mount.

`test/unit/git-mount-split.test.ts` pins the mount args;
`scripts/verify-container-git-containment.sh` runs the live WORK/FAIL matrix in
a real container against a throwaway repo, and skips (exit 77) when no container
runtime is available.

## MCP Config (~/.claude.json)

The supervisor writes this config before spawning Claude Code:

```json
{
  "mcpServers": {
    "lazy-agent": {
      "command": "lazy-agent",
      "args": ["mcp", "--task-id", "<uuid>", "--worktree", "<path>"]
    }
  }
}
```

Claude Code reads this on startup and spawns the MCP server as a child process.
