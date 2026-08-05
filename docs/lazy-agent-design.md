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

## MCP Server (`mcp` subcommand)

```
lazy-agent mcp --task-id <uuid> --worktree <path>
```

The MCP server is spawned by Claude Code (not by the supervisor directly). It:

1. Implements JSON-RPC 2.0 over stdio (no external dependencies)
2. Exposes the agent-facing tools: `lazy_search`, `lazy_show`, `lazy_create`,
   `lazy_start`, `lazy_comment`, `lazy_add_followup`, `lazy_commit`, `lazy_status`
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

### Surviving a daemon restart (401 credential refresh)

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
2. **Clients re-read that file on a 401 and retry exactly once.** This holds for
   the stdio MCP proxy, the supervisor's `DaemonClient` (which re-reads
   `~/.lazy/daemon/<slug>/token`), and the builder's conversation-capture storage,
   whose client lives for the whole session and so *will* outlive a restart.

The refresh never weakens the check: the only credential source is the same trusted
local file, an unreadable or malformed source reports no change so the 401 stands,
unchanged credentials skip the pointless second round trip, and there is no retry
loop. All tools share one config object and one refresher, so healing any tool heals
them all — matching the failure, which was always total. A 401 that survives the
refresh reports the actual cause, using `GET /daemon/status` → `projectRoot`
(unauthenticated on TCP for exactly this diagnosis) to say when the daemon on that
port belongs to a *different* project.

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
model choice, MCP approvals — and lazy merges its own `mcpServers.lazy` entry
into it on every launch. It used to be a per-launch temp file, which discarded
every answer Claude Code wrote during the session and re-prompted on the next
launch.

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

Two rules keep the seeded union honest, and both were bugs before they were rules:

- **Resume never falls back to the shared dir.** The shared dir is a seeding
  *source* but never a *sink*: nothing born under isolation is copied back into
  it. Mounting it for a resume therefore showed a strictly older, disjoint slice
  of history — which `/resume` list you got depended on which session id you
  resumed. Resolution now mounts an isolation dir or nothing.
- **A stale seeded copy is refreshed from the newest copy elsewhere.** Skipping
  any file that already existed let per-dir snapshots drift apart permanently.

What `/resume` shows is bounded by Claude Code's own retention window
(`cleanupPeriodDays` in your `~/.claude/settings.json`, which the `~/.claude` mount
carries into containers) — lazy does not extend it; the full conversation history
lives permanently in lazy's store and is reachable via `lazy builder list`.

Each dir carries a `.lazy-seeded.json` manifest listing the sessions that were
copied in host-side. A session present on disk but *absent* from the manifest is
one Claude wrote from inside the container — the only positive evidence that the
container user can write there, which is what lets a resume mount survive a
transiently failing write-probe.

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
