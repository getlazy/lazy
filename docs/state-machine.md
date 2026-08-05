# Task State Machine and Crash Recovery

This document describes the task status state machine and the crash/resume lifecycle in Lazy.

## Task Status State Machine

### Status Definitions

Lazy tasks can be in one of the following statuses:

- **`backlog`** — Task created but not yet started. No session exists.
- **`working`** — Agent is actively working. Container/process is running.
- **`blocked`** — Agent completed a turn and is waiting for human review/feedback.
- **`conflict`** — Agent completed a turn but file permission violations were detected. Semantically "blocked with violations" — the task cannot be accepted until violations are resolved.
- **`pairing`** — Human is working interactively with Claude Code in the task worktree.
- **`interrupted`** — Agent crashed or was killed unexpectedly.
- **`merging`** — A merge is in flight. Two shapes, distinguished by the `accept_in_flight_from` task metadata key: without it, the merge lives on the forge (PR/MR submitted, waiting for CI and merge) and a later accept re-enters to ask the forge what happened; with it, a LOCAL merge phase is running right now inside an accept, and the marker records the status to restore if that phase aborts or dies. `merging` is stamped at the START of the merge phase, so a task reads `merging` for the whole time it is being merged — not for the last instant of it.
- **`zombie`** — System-only recovery state for tasks whose branch was merged but status wasn't updated (e.g., `lazy accept` crashed after merge but before status update). Reconciler detects this and transitions through zombie → complete.
- **`complete`** — Task accepted and merged successfully.
- **`abandoned`** — Task rejected (`lazy reject`) or closed (`lazy close`, e.g. "won't do", duplicate) by a human. Both commands resolve to this single terminal status; there is no distinct `closed` status.

### Status Categories

**Terminal statuses** (task is finished, core fields frozen):
- `complete`, `abandoned`

**Blocked statuses** (waiting for human action):
- `blocked`, `conflict`

**Active statuses** (has active worktree that should not be merged into):
- `working`, `interrupted`, `pairing`, `merging`

### Valid State Transitions

```
backlog
  → working       lazy start (creates session, launches agent)
  → abandoned     lazy close (task canceled before starting)

working
  → blocked       reconciler (agent turn completes, response.json processed)
                  | reconciler (supervisor reported an unrecoverable agent failure —
                    see "Agent Failure Classification" below; NOT auto-resumed)
  → conflict      reconciler (agent turn completes with file permission violations)
                  | lazy accept (pre-accept turn ends, task restored to its pre-accept status)
  → submitted     lazy accept (same restore, for a task that was submitted)
  → interrupted   reconciler (container dies without response.json)
  NOTE: working cannot transition to pairing or abandoned — the agent is running.
  NOTE: accept moves the task through `working` for the pre-accept turn and
        restores the status it ACTUALLY had — see the merging note below.

blocked
  → working       lazy unblock (human gives feedback)
  → pairing       lazy pair (human wants to work interactively)
  → merging       lazy accept (begins merge process)
  → abandoned     lazy reject (rejects the work) | lazy close (canceled without accept/reject)
  → backlog       reconciler migration (blocked task with no session → backlog)
  NOTE: blocked cannot go directly to complete — must go through merging first.

conflict
  → working       lazy unblock (human gives feedback to fix violations)
  → pairing       lazy pair (human wants to work interactively on violations)
  → abandoned     lazy reject | lazy close

interrupted
  → working       auto-resume (reconciler, circuit breaker allows) | lazy resume
                  | reconciler stale-completed-response sweep (recovers a response
                    written after the task was marked interrupted; routes through
                    working, then working → blocked)
  → pairing       lazy pair (human investigates interactively)
  → abandoned     lazy reject | lazy close
  NOTE: interrupted cannot go to merging or complete — must unblock/review first.

pairing
  → blocked       pairing ends (Claude Code exits) | reconciler stale pairing sweep

merging
  → complete      lazy accept (checks pass, merge succeeds) | reconciler (merge completed)
  → blocked       lazy accept (checks fail) | reconciler (PR/MR closed externally)
  → conflict      lazy accept (merge phase aborts on a task that was in conflict)
  → submitted     lazy accept (merge phase aborts on a task that was submitted)
  NOTE: merging cannot go to abandoned — merge either succeeds or fails back to
        the status the task held before the accept. A task in `conflict`
        (unresolved violations) or `submitted` (open PR awaiting review) is not
        `blocked`; rewriting it to `blocked` on an aborted accept would destroy
        that signal, so every abort restores the TRUE prior status.

zombie (system-only)
  → complete      reconciler (merged branch sweep completes the task)
  NOTE: any non-terminal → zombie (system actor only). Terminal statuses cannot go to zombie.

complete
  → blocked       lazy reopen --reason "..." (reopen accepted task)
  → backlog       lazy reopen (reopen accepted task with no session)

abandoned
  → backlog       lazy reopen (reopen rejected/closed task with no agent work)
  → blocked       lazy reopen (reopen rejected/closed task with agent work)
```

### Actors (turn & transition provenance)

Every turn and status transition records an **actor** — who caused it. This is
provenance metadata: it never gates behavior (a save is a save regardless of
actor), it only records who did the thing.

There are five actors (`Actor` in `src/types`):

- **`human`** — a real person acting through the **CLI** boundary.
- **`builder`** — the AI builder that drives Lazy through the **MCP** boundary
  (the orchestrator that calls `lazy_start`, `lazy_unblock`, etc.).
- **`agent`** — a task agent driving its OWN subtree through the same MCP
  boundary (creating, starting, unblocking, and accepting its own subtasks).
  Same channel as `builder`, told apart by scope: the tool context carries a
  task id. Without it, an agent-driven subtask accept would read back as the
  builder's — or a human's — decision.
- **`system`** — the daemon acting on its own (reconciler transitions,
  crash auto-resume). Not attributed to whoever happened to trigger the tick.
- **`supervisor`** — the per-task supervisor authoring push-back/maintain
  prompts as human-role turns.

**The discriminator is the channel, not the content source.** A command that
arrives over MCP is `builder`; the same command over the CLI is `human`. This is
deliberate: when the builder relays a human's feedback via `lazy_unblock`, the
turn is still `builder` — the actor records *who submitted* (pressed the
button), not who authored the words. The human's content is persisted as
written either way (modulo control-character escaping, below); the tag is
orthogonal to it.

Mechanically: CLI commands default to `getActor()` (env-var / `human`). MCP tool
handlers set the actor at origination — `MCP_ACTOR` (`builder`) for the builder,
`AGENT_ACTOR` (`agent`) when the tool context carries a task id — and thread it
through the RPC layer, because turn-creating lifecycle ops (start, unblock, ask,
resume, stop, sync) persist their turn in the **daemon** — a shared process that
can't see the caller's channel from its own environment. Read surfaces
(`lazy show`, the web dashboard, the MCP `lazy_show` turns section, fidelity /
report digests) label a human-role turn by its authoring actor so `builder` and
`supervisor` turns are distinguishable from what a person typed.

### Text intake is sanitized at the boundary

Every prompt lazy sends an agent is passed as an **argv element**
(`claude -p <prompt>`). A raw NUL byte in argv is illegal, so a single NUL in
feedback used to kill the spawn instantly, trip crash-loop detection, and — via
an auto-resume that restarts on a generic prompt — silently drop the feedback.

Every text intake (CLI `unblock`/`comment`/`create`, the `$EDITOR` and piped-stdin
paths, every MCP tool argument, the daemon's unblock/ask RPCs, and auto-delivered
comment/CI text) therefore runs through `sanitizeUserText()`
(`src/utils/sanitize-text.ts`) **before persistence**. Non-printable control
characters — C0 except tab/LF/CR, DEL, and C1 — are replaced with their printable
escapes (a NUL becomes the six characters `\u0000`).

For free-text arguments that become prose in a prompt (`feedback`, `message`,
`prompt`, `note`, `reason`, `question`, `goal_context`), a short note is appended
disclosing the substitution, so it is visible rather than a silent rewrite.
Strings that are *not* prose are escaped **without** that note: short single-line
fields like a task goal, and strings nested inside array arguments — `files`,
`approved_files` — whose elements become git argv. Appending an explanatory
paragraph to a file path would corrupt the path.

The policy is **sanitize and deliver, never reject**: rejecting would discard
feedback at exactly the moment the human finished typing it, which the
never-lose-human-feedback invariant forbids. Nothing is dropped — only re-encoded.
Ordinary text is passed through byte-for-byte.

The delivery side is guarded too, as defense in depth: the argv builders escape
(and log loudly) rather than fail, and `spawn()`/`spawnSync()` refuse a
NUL-bearing argv with an actionable error instead of the opaque
`args[N] must be a string without null bytes`.

### Transition Triggers

The CLI commands below are the `human`-channel triggers; each has an MCP
equivalent (`lazy_start`, `lazy_unblock`, …) that drives the same transition but
records the actor as `builder` (or `agent`, when the caller is a task agent
acting inside its own subtree).

#### Human Actions (CLI commands)

- **`lazy start <task>`** — backlog → working
  - Creates session, creates worktree, launches supervisor container
  - Records human turn, transitions to working, launches agent

- **`lazy unblock <task>`** — blocked|interrupted → working
  - Opens $EDITOR for human feedback (or reads from --message/stdin)
  - Merges upstream before agent resumes (INVARIANT: every unblock merges upstream)
  - Records human turn, transitions to working, launches agent

- **`lazy resume <task>`** — interrupted → working
  - Manual recovery after auto-resume circuit breaker fires
  - Same mechanics as unblock but without requiring feedback

- **`lazy pair <task>`** — blocked|conflict|interrupted → pairing
  - Acquires pairing lock, transitions to pairing
  - Launches Claude Code with --resume (if session exists)
  - On exit, synthesizes summary turn, transitions back to blocked

- **`lazy ask <task>`** — blocked|conflict → working → blocked|conflict (status-neutral)
  - Read-only: resumes the agent session in plan mode to answer one question
  - Opens $EDITOR for the question (or reads from --message/stdin)
  - Records the question as a human turn before launching, the answer as an agent turn
  - Restores the **pre-ask** status when the turn completes, so an ask never
    mutates task state — the transient `working` window exists only so the
    reconciler and concurrent callers see the task as busy while the agent runs
  - If the agent crashes mid-ask the task lands in `interrupted` like any other turn

- **`lazy accept <task>`** — blocked|merging → merging → complete
  - Refuses if uncommitted changes exist
  - For remote tasks: creates/updates PR/MR, waits for checks
    - If merge succeeds immediately → merging → complete
    - If checks pending or approval needed → merging
  - For local tasks: transitions to merging, squash-merges into parent/main → complete
  - Ends session, cleans up container/worktree/branch
  - Narrates itself phase by phase — see [Accept observability](#accept-observability)
  - Status tracks the phase in flight: `working` (with the `agent:pre-accept`
    substate) for the pre-accept turn, `merging` for the whole merge phase.
    Every abort restores the status the task actually had before the accept
  - Concurrency: the whole accept orchestration runs under a process-level
    per-task lifecycle lock (`src/daemon/task-lifecycle-lock.ts`). The daemon
    serves RPCs concurrently, so without this a human accept and a builder
    accept on the same task could both clear preflight and both run the merge —
    leaving the task `blocked` while the merge was already applied. With the
    lock the second accept waits, re-runs preflight, sees the accepted session
    outcome, and returns "already accepted"; the merge runs exactly once.
  - Parent must not be active (working/pairing/merging/interrupted) — merging
    into a live worktree would corrupt whatever is running in it. ONE exemption:
    a caller whose own task IS the merge destination, accepting one of its
    subtasks over MCP. The exemption is an identity match on that destination
    (`callerTaskId === parent.id`, set only at the MCP boundary from the tool
    context, never from client input — so CLI callers can never reach it).
    That "never from client input" is now literally true: the caller's task id
    is derived from the per-session bearer token the daemon minted, and a
    request whose URL claims a different task is refused outright. Until then
    the id came from the URL path, which the caller wrote — so an agent could
    name its own parent and take this exemption on a worktree it had no claim
    to. See [Identity comes from the token, not the
    URL](lazy-agent-design.md#identity-comes-from-the-token-not-the-url).
    It covers two parent statuses, both of which mean "exactly one actor is in
    that worktree, and it is the one blocked inside this very call":
      - `working` — the parent's own agent is the caller.
      - `pairing` — a human is driving that session interactively and is the
        sole actor in the worktree, so an accept issued from it is that human's
        decision.
    `merging` and `interrupted` still refuse for everyone. Note that pairing
    sessions are launched as builder-role Claude (`lazy pair` passes no
    `--task-id`), so in practice a pairing session usually reaches MCP as the
    builder with no `callerTaskId` and still gets the refusal; the exemption
    fires only when the session really is task-scoped.
  - A dirty destination worktree does not block the merge and is never lost:
    the accept stashes the uncommitted work, merges, and pops it back. If the
    stash cannot be reapplied the merge still stands and a
    `DestinationRestoreConflict` surfaces with the retained stash SHA and
    recovery steps. This is status-agnostic, so it covers the `pairing` parent —
    the human's in-progress edits survive the accept. (`pairing`, like `working`,
    is not in `UNBLOCKABLE_STATUSES`, so the conflict is surfaced to the human
    as a warning rather than handed to an agent via unblock.)
  - Actor attribution follows the channel: CLI → `human`, builder MCP →
    `builder`, task-agent MCP → `agent`. An agent accepting its own subtask must
    not read back later as a human's decision.
  - Over MCP, a task agent may accept a DIRECT SUBTASK ONLY, never its own task
    (`assertAgentMayTargetChildOnly` in `src/mcp/tools.ts`). Self-accept makes no
    sense at any level of the hierarchy: accepting means "merge upward and mark
    complete", so accepting yourself skips the review the task exists to be
    subject to. Accepting a child merges into the agent's OWN branch, which a
    human still reviews when the agent's task is accepted. Every other
    task-targeting agent tool keeps the looser own-task-or-direct-child gate —
    they merge and complete nothing, which keeps `lazy_unblock` reachable and the
    create → start → wait → review → unblock → accept loop coherent. The builder
    surface is unrestricted, so a builder-mode MCP session can still accept a
    task directly.

- **`lazy reject <task>`** — blocked|interrupted → abandoned
  - Opens $EDITOR for rejection reason
  - Ends session, cleans up container/worktree/branch

- **`lazy close <task>`** — blocked|interrupted → abandoned
  - Opens $EDITOR for close reason
  - Ends session, cleans up container/worktree/branch
  - Resolves to the same `abandoned` terminal status as `lazy reject`; the two differ only in intent/reason, not status

- **`lazy reopen <task>`** — complete|abandoned → blocked|backlog
  - For complete tasks: requires --reason, resets session, transitions to blocked
  - For abandoned tasks: resets session if it exists, transitions to blocked or backlog

#### Agent Actions

- **Agent turn completes** — working → blocked | conflict
  - Supervisor writes response.json with agent output
  - Reconciler reads response.json, records agent turn
  - If response has file permission violations → transitions to conflict
  - Otherwise → transitions to blocked

- **Agent crashes** — working → interrupted
  - Container exits without writing response.json
  - Reconciler detects missing container, transitions to interrupted
  - Auto-resume may kick in (see Crash/Resume Lifecycle below)

#### System Actions (reconciler)

The reconciler runs automatically before `lazy list`, `lazy blocked`, `lazy active` commands. It performs several sweeps:

1. **Working task sweep** — Process tasks in 'working' status:
   - If response.json exists → record turn, transition to blocked
   - If container running and no response → leave as working
   - If container stopped without response → transition to interrupted, maybe auto-resume
   - If no container and no response → transition to interrupted, maybe auto-resume

2. **Interrupted response sweep** — Process stale responses for interrupted tasks:
   - Race condition fix: supervisor may write response.json after reconciler marks task interrupted
   - If interrupted task has response.json → process it, transition to blocked

3. **Terminal container sweep** — Clean up orphaned containers:
   - Tasks in complete/abandoned may have lingering containers if cleanup failed
   - Remove container, clear container_name from session

4. **Merged branch sweep** — Detect zombie tasks (branch merged but status not updated):
   - For non-terminal tasks with sessions: check if branch merged into target
   - If merged → set outcome='accepted', transition to zombie (system only) → complete
   - Uses the `zombie` status as an intermediate state to maintain transition table integrity
   - Prevents orphaned state where `lazy accept` succeeded but crashed before updating task

5. **Stale pairing sweep** — Recover tasks stuck in 'pairing':
   - If pairing PID no longer exists → transition to blocked
   - Cleans up pairing lock file

6. **Blocked-to-backlog migration** — One-time migration:
   - If blocked task has no session → transition to backlog
   - Separates "unstarted" (backlog) from "waiting for review" (blocked)

## Accept observability

An accept can run for minutes — a pre-accept agent turn, remote pushes, an
LLM-written merge description, the merge itself. It used to print nothing for
that whole window, which is indistinguishable from a hang. It now narrates.

**The phase table is the single source of truth.** `src/daemon/progress.ts`
declares every accept phase (id + label + whether it is optional) and the two
plans built from it: the fresh-accept plan (`acceptPhasePlan`, which includes the
pre-accept turn only when that step is enabled) and the remote-merge re-entry
plan (`acceptReentryPhasePlan`: check remote state → finalize → clean up). The
accept path executes phases from that same table, so the announced plan cannot
drift from what actually runs.

**How narration travels.** The daemon's `PhaseReporter` emits `ProgressEvent`s
into the heartbeat envelope described in `src/daemon/heartbeat.ts` — the same
NDJSON framing that already carried liveness, extended with a `{"progress": …}`
line rather than forked:

| Line | Meaning |
| --- | --- |
| `{"lazyEnvelope":1}` | preamble; the response is framed |
| `{"heartbeat":<ms>,"phase":"Merge"}` | still alive, currently in this phase |
| `{"progress":{…}}` | a plan announcement, or a phase start/done/skipped/failed |
| `{"status":…,"body":…}` | the result |

A progress line also feeds the client's liveness callback: the daemon wrote it
because its handler is running *now*, so a phase change resets any client
deadline just as a heartbeat does.

Both client surfaces consume the same events:

| Surface | Rendering |
| --- | --- |
| `lazy accept` | `src/cli/phase-display.ts` — plan header, then one line per phase; on a TTY the open phase repaints with a live elapsed counter, off a TTY it is append-only |
| MCP `lazy_accept` | `src/daemon/mcp-proxy.ts` relays each event as `notifications/progress` |

Narration is strictly observational: a throwing or absent emitter cannot change
the outcome of an accept, and an accept with nobody listening runs identically.

**Pre-flight is a prelude, not a plan entry.** It runs before the plan is known
(it is what decides which plan applies), so it is narrated with no `[n/m]`
position and the plan is announced immediately after it.

**Status during an accept.** The narration answers "what is it doing" for the
caller who is watching; the task's own status answers it for everyone else
(`lazy list`, `lazy show`, MCP):

| Accept phase | Status | Substate |
| --- | --- | --- |
| Pre-accept validation turn | `working` | `agent:pre-accept` |
| Merge phase (description, merge, finalize) | `merging` | — |
| Aborted at any point | the status held before the accept | — |

`agent:pre-accept` (`src/utils/working-substate.ts`, derived from the
supervisor's `command_type`) exists because a bare `working` during an accept is
indistinguishable from a human having unblocked the task by hand.

## Agent Failure Classification

Not every agent failure deserves the same response. A rate limit clears on its own;
a revoked credential never does. The supervisor therefore never inspects error text
itself — it asks the **agent** what went wrong and acts on the class it gets back.

This is the *runtime* half of credential handling. The *start-time* half is the
daemon credential gate (`src/daemon/credential-gate.ts`): a daemon with no
credential at all never comes up in the first place, on any start path, so the
`fatal_auth` class below is about credentials that were present at start and
stopped working — not about a daemon that never had one.

### The taxonomy

Each agent implements `classifyFailure()` (`src/agent/interface.ts`) and maps its own
raw stderr / stdout error / exit code onto the shared vocabulary in
`src/agent/failure-taxonomy.ts`:

| Class | Examples | Supervisor behavior |
|---|---|---|
| `fatal_auth` | 401/403, invalid API key, missing credential, credit balance exhausted | Stop on the first failure |
| `fatal_config` | unknown flag, invalid model, agent binary missing (exit 127) | Stop on the first failure |
| `transient_overload` | 429, 529, 503, "overloaded" | Retry forever, 5s→60s |
| `transient_network` | ECONNRESET, ETIMEDOUT, socket hang up, `fetch failed` | Retry forever, 5s→60s |
| `transient_unreachable` | ECONNREFUSED, ENOTFOUND | Retry 5s→60s, **bounded** at 12 attempts (~9 min), then treated as unrecoverable |
| `unknown` | anything unrecognized | Retry 15s→60s; the crash-loop detector still applies |

A classifier that does not recognize a failure returns `unknown` rather than guessing.
A wrong `fatal_*` blocks a task that would have recovered — the more expensive mistake.

Agent-specific dialects (Claude Code's "Invalid API key · Please run /login", Cursor's
"not logged in") are matched in that agent's implementation; shared HTTP/socket signals
live in `classifyCommonFailureSignals()`.

### Retry pacing

`src/supervisor/retry-policy.ts` is a pure function of `(class, attempt)` and is the only
place cadence is decided. Transients use 5s → 10s → 20s → 40s → 60s (capped) — roughly 60
retries an hour. The previous uniform ladder (30s → 300s) managed about 12, which in a live
incident meant two attempts in five minutes on a condition that could never recover.

The fast-fail crash-loop detector (3 failures under 10s each) is **disabled** for transient
classes: a 429 comes back in milliseconds, so three in a row would abort a turn that was
about to succeed. It remains the bound for `unknown`.

`transient_unreachable` is the deliberate middle ground for the ConnectionRefused case:
a refused connection to a local proxy can heal if the proxy restarts, so it is retried
generously, but a proxy that never returns must not spin forever. After the attempt cap it
escalates to a stop.

### What "stop" means

When the policy says stop, the supervisor throws `FatalAgentError` and writes the class,
reason, and attempt count into `response.json` (`failure_class`, `failure_reason`,
`failure_attempts`). The reconciler treats a set `failure_class` as the signal to move the
task to **`blocked`** — not `interrupted` — and records the classified reason as an
interrupt. This matters because `maybeAutoResume` only ever fires on `interrupted` tasks;
`blocked` is what actually stops the reconciler from relaunching into a dead condition, and
puts the task in front of a human with the reason attached.

Live retry state (class, reason, next delay) is also projected into `status.json`
(`retry_failure_class`, `retry_failure_reason`, `retry_next_delay_ms`) for presentation
surfaces to render.

### Rendering "what is being retried"

`phase=retrying` on its own tells a human nothing — the question in a live stall is always
*retrying what, and why*. `src/utils/retry-summary.ts` is the single formatting seam:
`formatRetrySummary()` turns the `status.json` retry projection into one line
(`attempt 7 (transient_overload): API Error: 529 overloaded`), truncating the error
snippet to a bounded length. Every surface renders through it, so they cannot drift:

| Surface | Where |
| --- | --- |
| `lazy watch` / `lazy status` header | `src/cli/status-header.ts` |
| `lazy list` / `lazy active` substate | `src/utils/working-substate.ts` (harness variant carries `retry`) |
| `lazy show` "Retry State" block | `src/cli/commands/show.ts` |
| Supervisor log (`Phase: retrying …`) | `src/supervisor/retry-status.ts` |
| MCP `lazy_show` → `retry_status` | `src/mcp/tools.ts` (`buildRetryStatus`) |

The MCP field exists because a builder driving tasks over MCP has no host CLI: without it,
a task stuck in the retry loop is indistinguishable from a healthy `working` one.

Surfaces that render both a header and a substate suffix (watch) or a status word and a
detail block (show) strip `retry` from the secondary copy — the detail is printed once per
line, not two or three times.

### Watchdog kills are outside the taxonomy

A no-progress watchdog kill has no error text to classify — lazy killed the process itself,
after `[agent] watchdog_output_timeout_ms` (default **30 minutes**, and the timer resets on
every completed step) passed with no forward progress. So it is not routed through
`classifyFailure()`; it is decided by one question, in `decideWatchdogRetry()`:

| Did the turn capture anything? | Behavior |
|---|---|
| **Yes** — a final result was on the wire, or the turn added commits | Not retried. The work is already on disk, so relaunching would repeat it or wedge the same way; the turn ends and a human reads what was captured |
| **No** — no result, no new commits | Relaunched in-turn with transient-style backoff (5s → 10s), bounded at 3 attempts. Each attempt costs a full no-progress window, so the bound is far tighter than `UNREACHABLE_MAX_ATTEMPTS` |

The zero-work branch exists because the "work is already on disk" rationale is false in the
case that hurts most: during a provider incident a task sat 45 minutes in `working` with its
*first* model call hung — nothing captured, nothing to repeat — and a relaunch is exactly
what heals it. If the commit probe cannot read git, the kill is treated as zero-work
(fail toward retrying).

A watchdog kill carries no `failure_class`, so when it does end the turn the reconciler
routes it to **`interrupted`** with bounded auto-resume, not `blocked`. The recorded turn and
the session's `interrupt_reason` are rendered by `src/utils/watchdog-turn.ts` — one place, shared
by work turns and the ask path — and say which guard fired, what its limit was, that
keep-alives are not progress, and whether lazy already relaunched.

## Crash/Resume Lifecycle

When an agent crashes mid-turn, Lazy automatically detects the failure and attempts to resume the task. This section describes the full lifecycle.

### 1. Detection

The reconciler runs on every `lazy list`, `lazy blocked`, `lazy active` invocation. It scans tasks in 'working' status and checks:

- Does the supervisor container/process still exist?
- Has it written a response.json file?
- How long has it been since the task transitioned to 'working'?

**Grace period**: Newly-working tasks (last_interaction_at within 30 seconds) are skipped to give the container time to start. This prevents a race where reconciliation runs before the container finishes launching.

If a working task has:
- No response.json
- No running container
- Grace period expired

Then the task is marked as interrupted.

### 2. Classification: Clean vs Dirty Worktree

Once a crash is detected, the reconciler checks `hasUncommittedChanges(worktreePath)` to classify the crash:

- **Clean worktree**: Agent crashed before making edits, or successfully committed all changes before crashing
- **Dirty worktree**: Agent was mid-edit when it crashed, leaving uncommitted changes

This classification determines the auto-resume strategy.

### 3. Recording the Interrupt

The reconciler transitions the task to 'interrupted' and records diagnostics:

```typescript
await storage.updateTaskStatus(taskId, 'interrupted', 'system');
await storage.recordInterrupt(session.id, {
  reason: exitCodeToReason(exitCode),  // e.g., "OOM killed or SIGKILL (exit code 137)"
  exit_code: exitCode,
  logs: runner.getRunLogs(containerName, 50),  // Last 50 lines
});
```

The `recordInterrupt` call increments the `consecutive_interruptions` counter, which is used by the circuit breaker.

### 4. Circuit Breaker Check

Before attempting auto-resume, the reconciler checks:

```typescript
if (session.consecutive_interruptions >= MAX_CONSECUTIVE_INTERRUPTIONS) {
  // MAX_CONSECUTIVE_INTERRUPTIONS = 3
  logger.warn('Circuit breaker triggered, not auto-resuming');
  return;
}
```

If the circuit breaker fires, the task stays in 'interrupted' state until a human manually intervenes with `lazy resume` or `lazy unblock`.

**Rationale**: Prevents infinite crash loops. If an agent crashes 3 times in a row without completing a turn, something is fundamentally wrong (OOM, broken dependencies, infinite loop, etc.). A human needs to investigate.

### 5. Auto-Resume: Clean Worktree Path

If the worktree is clean (no uncommitted changes), the auto-resume flow is:

1. **Resolve parent branch** (same logic as normal unblock):
   - For child tasks: parent's branch (`lazy/<parent-ref>`)
   - For root tasks: `task.metadata.remote_target_branch` or 'main'

2. **Merge upstream** (INVARIANT: every unblock merges upstream):
   - Set `sync_before_work: true` in the UnblockCommand
   - Supervisor merges parent/main into task branch before agent resumes
   - Prevents branch drift (see CLAUDE.md architectural invariants)

3. **Build crash context prompt**:
   ```
   You are being resumed after a crash. Upstream has been merged into your branch
   since your last turn. Don't assume your previous state is intact — verify before
   continuing.
   ```

4. **Write UnblockCommand** to protocol directory with:
   - `parent_branch` set (for upstream merge)
   - `sync_before_work: true`
   - Crash context prepended to the resume prompt

5. **Record synthetic human turn**:
   ```typescript
   await storage.createTurn({
     sessionId: session.id,
     sequence: nextSeq,
     role: 'human',
     content: '[system] Session interrupted and auto-resumed',
     actor: 'system',
   });
   ```

6. **Transition to working**:
   ```typescript
   await storage.setAutoResumed(session.id, true);
   await storage.updateTaskStatus(task.id, 'working', 'system');
   ```

7. **Launch supervisor** (or write command if already running):
   - If container exists: just write UnblockCommand, supervisor picks it up
   - If container gone: launch new supervisor container

The agent resumes with full Claude Code `/resume` context (conversation history), but filesystem state reflects the crash — it must verify assumptions before continuing.

### 6. Auto-Resume: Dirty Worktree Path

If the worktree has uncommitted changes, the auto-resume flow is:

1. **Skip upstream merge**:
   - Set `sync_before_work: false`
   - Merging upstream on a dirty worktree would fail (`git merge` refuses) or create confusing state (stashed changes, lost edits)

2. **Build crash context prompt**:
   ```
   You are being resumed after a crash. There are uncommitted changes in your worktree
   from your interrupted turn. Review them, decide what to keep, commit or discard,
   then continue your work.
   ```

3. **Write UnblockCommand** with:
   - No `parent_branch` (skip merge)
   - `sync_before_work: false`
   - Crash context prepended to resume prompt

4. **Record synthetic human turn**, transition to working, launch supervisor** (same as clean path)

The agent resumes and sees uncommitted changes. It must decide what to do with them (commit, discard, edit further) before making progress.

### 7. Session Resume and Conversation Context

When the supervisor launches, it:

1. Looks for the Claude session ID in the sandbox's `.claude/projects/` directory
2. Passes `agent_session_id` to the capture layer
3. Claude Code's `/resume` functionality restores the full conversation history

**Filesystem state depends on crash timing**:

- **Crash before any edits**: Worktree clean, no conversation context lost
- **Crash mid-edit**: Worktree dirty, conversation context intact, but file edits partially complete
- **Crash after commit but before response.json**: Worktree clean (changes committed), conversation context intact, agent picks up from last commit

The conversation transcript is preserved, but the agent must verify filesystem state — the crash may have interrupted file writes, git operations, or tool calls.

### 7b. Feedback Redelivery (never lose human feedback)

**INVARIANT (CLAUDE.md)**: a turn whose feedback was recorded but never consumed is
re-delivered **verbatim** when the task resumes — for **any** crash cause.

The gap this closes: feedback is persisted *before* the container launches (save first,
act second). If the work phase then crashes, the feedback exists in the store but the
agent never read it. Resuming with the generic "your previous session was interrupted,
carry on" prompt leaves that feedback available only *implicitly* via turn-history
injection — and in practice the agent does not act on it.

**Tracking.** Delivery state lives explicitly on the turn (`Turn.feedback_delivery`):

| Value | Meaning |
| --- | --- |
| absent | The turn carries no redeliverable feedback (system resume notices, supervisor `sync`/`nudge` turns, stop reasons). Never triggers redelivery. |
| `pending` | Feedback is persisted but no agent response has consumed it. |
| `consumed` | An agent response completed after this feedback was delivered. |

Turns created with `carriesFeedback: true` start as `pending`: the initial task prompt
(`task-launcher`), `lazy unblock`, `lazy ask`, and auto-delivered comments/CI output
(`auto-deliver` — actor `system`, but the *content* is human).

**Why an explicit marker and not "is there an agent turn after it?"** Because a crash
records an agent *error* turn. That turn consumed nothing, so the positional proxy would
mask exactly the case redelivery exists for.

**Marking consumed.** `storage.markFeedbackConsumed(sessionId)` flips every `pending`
turn in the session to `consumed`. It is called wherever an agent response completes
normally — `handleCompletedResponse`, the stranded-session recovery, and the ask
recorder — and deliberately **not** in the error paths. Clearing the whole backlog at
once is what makes redelivery idempotent: a turn that *did* consume its feedback can
never be re-delivered into.

**Redelivering.** Both resume paths (`autoResumeTask` and `lazy resume`) call
`findPendingFeedback()`; when it returns a turn, the redelivery block **replaces** the
generic resume context in the prompt. The newest pending turn is reproduced verbatim
(never summarized or truncated); if older pending turns exist, the prompt says how many
so a queue is never silently collapsed. The synthetic resume turn itself does *not*
carry feedback, so a crash during the resume re-delivers the same feedback again.

Rows written before this field existed read as "carries no feedback" — the correct
reading, since resurrecting them now would be a stale redelivery.

### 8. Three Crash Scenarios in Detail

#### Scenario A: Crash Before Any Edits

```
Agent starts turn → reads files → analyzes → CRASH
```

**State**:
- Worktree clean (no edits made)
- No commits made this turn
- Conversation history intact (agent read messages, maybe sent partial response)

**Auto-resume flow**:
- Clean worktree path
- Merge upstream
- Agent resumes: "You crashed before making changes. Upstream was merged. Verify assumptions and continue."

#### Scenario B: Crash Mid-Edit with Uncommitted Changes

```
Agent starts turn → edits file A → edits file B → CRASH (file B half-written)
```

**State**:
- Worktree dirty (file A fully edited, file B partially edited)
- No commits made
- Conversation history intact (agent may have sent tool calls for edits)

**Auto-resume flow**:
- Dirty worktree path
- Skip upstream merge
- Agent resumes: "You crashed with uncommitted changes. Review them (file A done, file B partial). Commit, fix, or discard."

#### Scenario C: Crash After Commit But Before response.json

```
Agent starts turn → edits files → commits → CRASH (before writing response.json)
```

**State**:
- Worktree clean (changes committed)
- Commits exist on branch
- Conversation history intact but response may be incomplete
- No response.json written → reconciler doesn't know about the commit yet

**Auto-resume flow**:
- Clean worktree path
- Merge upstream
- Agent resumes: "You crashed after committing. Upstream was merged. Your commit is on the branch. Verify and continue."

**Reconciler behavior**: On next successful turn, the reconciler will detect the "new" commit (it compares session.git_start_sha with current HEAD) and record it.

### 9. Special Cases and Edge Cases

#### Merge-and-Fix Failures

If the supervisor crashes during the `merge_and_fix` phase (upstream merge failed with conflicts), auto-resume is **disabled**:

```typescript
if (response.phase === 'merge_and_fix') {
  logger.warn('merge-and-fix failed, not auto-resuming (task needs human investigation)');
  // Task stays interrupted
}
```

**Rationale**: The task cannot make progress without a successful upstream merge. Auto-resuming would start a new turn on a stale branch, diverging further from upstream. A human must investigate the merge conflict.

#### Error Responses

The supervisor can write an error response.json (instead of a completed response):

```json
{
  "status": "error",
  "phase": "capture" | "merge_and_fix" | "supervisor",
  "error": "...",
  "exit_code": 137,
  "stderr": "..."
}
```

When the reconciler sees an error response:

1. Record agent error turn (visible in `lazy show`)
2. Transition to interrupted
3. Record interrupt diagnostics
4. Auto-resume if allowed (unless merge-and-fix failure)

This gives visibility into crash details while still attempting recovery.

#### Interrupted Response Sweep (Race Condition Fix)

**Problem**: The reconciler moves a task to 'interrupted' due to a supervisor error, but the supervisor may have already picked up the next command (written by `lazy resume` or `lazy unblock`) and completed it. The new response.json sits unconsumed because the reconciler only looked at working tasks.

**Solution**: After the primary working task sweep, the reconciler runs a secondary sweep over interrupted tasks:

```typescript
const interruptedTasks = await storage.listTasksWithOptions({ interruptedOnly: true });
for (const task of interruptedTasks) {
  const response = readResponse(protoDir);
  if (response?.status === 'completed') {
    // Stale response found — process it, transition to blocked
    await handleCompletedResponse(...);
  }
}
```

This ensures responses are never lost, even when races occur between reconciler and supervisor.

#### Consecutive Interruptions Counter Reset

The `consecutive_interruptions` counter is reset to 0 when:

- A turn completes successfully (agent writes response.json, reconciler processes it)
- A human manually runs `lazy resume` or `lazy unblock` (considered human intervention)

This means the circuit breaker is lenient: if the agent succeeds once, the counter resets. Only sustained consecutive crashes trigger the breaker.

### 10. Manual Recovery

If auto-resume fails or the circuit breaker fires, humans can recover manually:

- **`lazy resume <task>`** — Same as unblock, but without requiring feedback. Resets the consecutive_interruptions counter.
- **`lazy unblock <task> --message "..."`** — Give feedback and resume. Resets the counter.
- **`lazy pair <task>`** — Jump into pairing mode to debug interactively.
- **`lazy show <task>`** — View interrupt diagnostics (exit code, logs, crash reason).

Interrupt diagnostics are stored in the session:

```typescript
interface Session {
  interrupt_reason: string | null;        // "OOM killed or SIGKILL (exit code 137)"
  interrupt_exit_code: number | null;     // 137
  interrupt_at: number | null;            // timestamp
  interrupt_logs: string | null;          // last 50 lines of container logs
  consecutive_interruptions: number;      // circuit breaker counter
  auto_resumed: boolean;                  // was this session auto-resumed?
}
```

This gives humans full visibility into what went wrong.

## Code References

Key files implementing the state machine and crash recovery:

- **`src/task-state-machine.ts`** — Centralized state machine: transition table, validation, status classification
- **`src/types/index.ts`** — TaskStatus type definition, status classification functions (isTerminalStatus, isActiveStatus, isBlockedStatus)
- **`src/utils/reconcile.ts`** — Main reconciler loop, state transitions, crash detection
- **`src/utils/auto-resume.ts`** — Auto-resume logic (shared by reconciler and `lazy resume`)
- **`src/utils/feedback-redelivery.ts`** — Selecting and rendering unconsumed feedback for redelivery on resume
- **`src/cli/commands/start.ts`** — backlog → working transition
- **`src/cli/commands/unblock.ts`** — blocked|interrupted → working transition
- **`src/cli/commands/pair.ts`** — blocked|conflict|interrupted → pairing transition
- **`src/cli/commands/accept.ts`** — blocked|interrupted|merging → complete|merging transitions
- **`src/cli/commands/reject.ts`** — blocked|interrupted → abandoned transition
- **`src/cli/commands/close.ts`** — blocked|interrupted → abandoned transition
- **`src/cli/commands/reopen.ts`** — terminal → blocked|backlog transition
- **`src/daemon/progress.ts`** — Accept phase table, the two phase plans, and the `PhaseReporter` that emits them
- **`src/cli/phase-display.ts`** — Renders phase events in the terminal (TTY and plain)
- **`src/storage/interface.ts`** — Storage methods for status updates, interrupt recording

## Testing

State machine behavior is tested in:

- **`test/unit/task-state-machine.test.ts`** — Centralized transition table, zombie transitions, status classification, reverse lookups
- **`test/e2e/reconcile.test.ts`** — Reconciler sweeps, crash detection, auto-resume
- **`test/unit/feedback-redelivery.test.ts`** — Unconsumed-feedback selection and the resume-prompt seam
- **`test/e2e/auto-resume.test.ts`** — Crash diagnostics, circuit breaker, and feedback redelivery on auto/manual resume
- **`test/unit/merging-status.test.ts`** — Merging status transitions
- **`test/e2e/pair.test.ts`** — Pairing state transitions and stale pairing sweep
- **`test/e2e/agent-binary-seam.test.ts`** — `working → blocked` and `working → interrupted` driven by a REAL supervisor: watchdog kills (wind-down keeps the summary and blocks; no-progress interrupts), SIGTERM→SIGKILL escalation, in-turn crash retry, and session resume. Uses the fake-`claude`-binary seam (`setupTestLazy({ fakeClaude: true })`) so nothing in `src/` is mocked — the other e2e suites reach these transitions through a module mock that replaces the supervisor entirely

When modifying state transitions, ensure tests cover:
- Valid transitions (should succeed)
- Invalid transitions (should fail or be prevented)
- Reconciler sweeps (should detect and fix inconsistent states)
- Auto-resume circuit breaker (should stop after 3 consecutive crashes)
- Manual recovery paths (should reset circuit breaker)
