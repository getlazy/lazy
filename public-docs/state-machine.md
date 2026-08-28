# Task State Machine and Crash Recovery

This document describes the task status state machine and the crash/resume lifecycle in Lazy.

## Task Status State Machine

### Status Definitions

Lazy tasks can be in one of the following statuses:

- **`backlog`** — Task created but not yet started. No session exists.
- **`working`** — Agent is actively working. Container/process is running.
- **`blocked`** — Agent completed a turn and is waiting for human review/feedback.
- **`conflict`** — Agent completed a turn but file permission violations were detected. Semantically "blocked with violations" — the task cannot be accepted until violations are resolved. Leaving `conflict` requires an explicit approve/revert decision on every *pending* violated file; neither `lazy unblock` nor `lazy accept` infers one. A decision already made is sticky: a later unblock decides only what is still pending, so silence never re-reverts an approved file, and re-naming one is always accepted. See [Resolving a conflict task](lazy-toml.md#resolving-a-conflict-task).

  **`conflict` is DERIVED, never asserted.** The pending violation set is the source of truth; `conflict` is the label a paused task wears while that set is non-empty. Every path that parks a task as paused — reconciler turn completion, sync completion, a fatal-failure park, stranded recovery, pairing teardown, auto-deliver rollback, `lazy stop`, `lazy doctor <task>` — goes through `parkTaskPaused` in `src/utils/paused-status.ts` and re-derives the label from the set rather than writing `blocked` directly. Correspondingly, every reviewer-facing guard (the CLI and MCP unblock guards, the daemon's revert) reads violation records, not the status — the PENDING set for what must be decided, and the full record set for whether `approved_files` may be passed at all. Before this was true, a read-only `lazy_ask` could leave a task reading `blocked` with a violation still pending, which made the correct call unexpressible: passing `approved_files` was refused ("no violations") while omitting it silently reverted the agent's committed work.
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
  → conflict      any park that re-derives the label and finds a pending
                  violation set (see "conflict is DERIVED" above)
  → pairing       lazy pair (human wants to work interactively)
  → merging       lazy accept (begins merge process)
  → abandoned     lazy reject (rejects the work) | lazy close (canceled without accept/reject)
  → backlog       reconciler migration (blocked task with no session → backlog)
  NOTE: blocked cannot go directly to complete — must go through merging first.

conflict
  → working       lazy unblock (human gives feedback to fix violations)
  → blocked       any park that re-derives the label after every violation was
                  resolved (approved or rejected)
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
  → conflict      same two paths, when the task still owes a decision on
                  file-permission violations

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
  NOTE: an accept that DIES mid-merge (daemon restart, crash, kill) leaves the
        task in `merging` with no owner. That is recovered, not transitioned
        away: `lazy reject`, `close`, `submit` and `unblock` return the task to a
        resting status first and then do their job, and the reconciler sweeps
        such tasks on every tick — so a stranded merge escapes without anyone
        needing to know an incantation. A merge that is genuinely in flight (an
        accept holding the task's lifecycle lock) is refused instead, and a
        forge-pending merge is left for remote-sync. See
        `src/daemon/stranded-merge.ts`; `lazy doctor` reports anything sitting
        in `merging`.

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
through the RPC layer, because lifecycle ops persist their records in the
**daemon** — a shared process that can't see the caller's channel from its own
environment, and whose `getActor()` therefore reports `human` for every caller.
Everything an operation writes carries that one threaded actor: the turn, every
status transition it makes, and any comment it leaves. That covers the
turn-creating ops (start, unblock, ask, resume, stop, sync) *and* the ones that
never launch an agent (reject, close, submit, reparent), plus task creation —
whose channel lands on the initial `backlog` status-changelog entry — and
journal entries. Read surfaces
(`lazy show`, the web dashboard, the MCP `lazy_show` turns section, fidelity /
report digests) label a human-role turn by its authoring actor so `builder` and
`supervisor` turns are distinguishable from what a person typed.

**An absent actor is not a bug — it means one of two things.** On a
**`role: 'agent'`** turn, an actor is never written: the field records who
submitted a *command*, and an agent's own reply is not one (`lazy show` labels
those by role). On a **human-role** turn or a status change, absent means the
default channel — a CLI/human action, or a record written before the actor was
populated. Only the non-default channels (`builder`, `agent`, `system`,
`supervisor`) are stamped, so legacy records and new CLI records read the same
way. Turn-creating commands are the exception: they always write an explicit
actor on the human-role turn, `human` included.

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
(and log loudly) rather than fail, and the `src/utils/spawn.ts` wrappers refuse a
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
  - Refuses while file-permission violations are pending: resume has no channel
    to express an approve/revert decision, and starting a turn without one piles
    more work onto files the eventual unblock may revert. Use `lazy unblock` with
    `--approve-file` / `--no-approve-files` (or `approved_files` over MCP).
    Auto-resume (reconciler and the auto-resume queue) skips such tasks for the
    same reason

- **`lazy pair <task>`** — blocked|conflict|interrupted → pairing
  - Acquires pairing lock, transitions to pairing
  - Launches Claude Code with --resume (if session exists)
  - On exit, synthesizes summary turn, transitions back to blocked (or `conflict`,
    if violations are still pending)

- **`lazy ask <task>`** — blocked|conflict → working → blocked|conflict (status-neutral)
  - Read-only and reflective: resumes the agent session (Claude Code plan mode plus
    hard tool denials) to answer one question
  - Opens $EDITOR for the question (or reads from --message/stdin)
  - Records the question as a human turn before launching, the answer as an agent turn
  - Restores the **pre-ask** status when the turn ends — on success, on an agent
    error, and on any other throw — so an ask never mutates task state. The
    transient `working` window exists only so the reconciler and concurrent
    callers see the task as busy while the agent runs
  - The one exception is a timeout: the task deliberately stays `working` so the
    reconciler can still finalize an answer the supervisor may yet write. The
    reconciler's park re-derives `blocked` vs `conflict`, so the label survives
  - If the agent crashes mid-ask the task lands in `interrupted` like any other turn

- **`lazy chat <task>`** — no transition at all (status-neutral)
  - On a `blocked`/`conflict` task: resumes the live agent session interactively in the
    worktree, read-only and reflective (same denials as ask). No status change, no turn,
    no commits — the only durable effect is the session log captured to storage on exit
  - Holds the worktree lock (`.lazy-lock`, command `lazy chat`) for the chat's duration,
    so start/unblock/sync/resume refuse while a chat is open rather than starting a turn
    underneath it
  - On a terminal task: rehydrates the captured session JSONL and resumes it in the
    project root (no worktree exists)

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
  - While it waits for the pre-accept turn, lazy also watches whether the
    agent's run is still alive. If the run disappears without answering, the
    accept aborts within seconds — reporting the run's exit code and last
    output, restoring the task's prior status, and recording the reason on the
    task — instead of waiting out the turn's full timeout. A brief grace period
    covers the normal ending, where the agent answers and then exits.
  - The merge only proceeds on a validation result that actually came from the
    pre-accept turn. While the accept waits, the task is marked as having a turn
    in flight, so an auto-resume or an auto-delivered comment holds off instead
    of starting a turn on top of it — and the marker lives with the task, so it
    still holds if the daemon restarts mid-accept. If a result nonetheless
    arrives that did not come from the pre-accept turn, the accept stops and says
    so rather than treating it as a pass. Re-accept once the task is idle and a
    fresh pre-accept turn runs. `lazy ask` claims the same marker, so a second
    `lazy ask` on a task that is already answering one is refused rather than
    racing it.
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
  - If the response has file permission violations, or the session still carries
    an unresolved pending set from an earlier turn → transitions to conflict
  - Otherwise → transitions to blocked
  - A turn that ran no permission check (an ask, a sync) reports nothing, and
    "reported nothing" never clears a pending set

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

## Waiting on subtasks

An agent that decomposes its work into subtasks drives them with blocking lazy
tools — `lazy_wait` (long-poll until a subtask finishes its turn) and `lazy_ask`
(resume a subtask's agent and wait for its answer). For that whole stretch the
parent agent is doing nothing, yet every read surface showed it as
`working(agent)`: indistinguishable from an agent thinking hard for twenty
minutes.

**The signal is the call itself, not the agent's output.** Every agent tool call
— container runner and host-process runner alike — is forwarded by
`src/daemon/mcp-proxy.ts` to the daemon's `POST /mcp/:taskId/:toolName` route and
authenticates with a per-session MCP token. So `handleMcpToolCall` already knows
which task is blocked, on what, and since when. Nothing here parses agent stdout.

| Piece | Where |
| --- | --- |
| Which tools park the caller | `BLOCKING_WAIT_TOOLS` in `src/daemon/wait-registry.ts` (`lazy_wait`, `lazy_ask`) |
| Wrapping a blocking call | `trackWait()`, called from `handleMcpToolCall` |
| Live marker readers see | `waiting.json` in the task's protocol dir (`src/protocol/waiting.ts`) |
| Substate derivation + label | `src/utils/working-substate.ts` (`{ kind: 'waiting' }`) |
| Durable intervals | `Storage.recordWaitStart/recordWaitEnd/readWaitIntervals` |

**Rendering.** `working(waiting on fix-foo (2m10s))` across `lazy list`,
`lazy active`, `lazy status`, `lazy show`, `lazy watch`, and the MCP `substate`
field — all of them go through the shared derivation, so they cannot drift. Two
concurrent waits list both labels; a larger fan-out summarizes
(`waiting on a, b +2`).

**Precedence.** Within an agent phase, `waiting` outranks `agent:answering` and
`agent:pre-accept`: those say what the turn *is*, `waiting` says what it is doing
this second. A harness phase outranks `waiting` — there the supervisor, not the
agent, is the active thing. A dead run still reads `not-alive`; a wait marker
never resurrects a stranded task.

**Clearing is on settle, not on response delivery.** `trackWait` clears from a
`finally`, so a call whose MCP client already disconnected — which the daemon
finishes anyway (complete-anyway semantics) — still clears. The marker also
carries the writing daemon's pid: a reader that finds that pid dead treats the
whole file as stale and reports no waits, so a SIGKILLed daemon degrades to the
pre-existing `working(agent)` rather than to a lie. `cleanProtocol` removes the
file at turn teardown, and a clean daemon stop clears every marker it owns.

### Persisted wait intervals

The same bookkeeping writes a durable record, because waited time is not the
agent's time: a turn that spent two hours blocked on a subtask must not bill
those two hours to the agent in duration or economics reports.

Intervals live in `<storagePath>/waits/intervals.jsonl` — shared JSONL used by
every backend (the same reasoning as trace spans: telemetry-shaped, append-only
data earns no table and no migration, and the cross-backend row shape is
byte-identical by construction).

The file is **event-structured**: a wait writes one `start` line when it begins
and one `end` line when it settles, folded on read. That is what makes a crash
readable — an interval whose `end` never arrived reads back with
`ended_at: null` and `outcome: null`, the documented "died mid-wait" shape,
rather than vanishing. Consumers should treat such an interval as open, bounded
above by the turn's end.

`turn_sequence` is **best-effort by construction**: agent turns are only written
when the turn ends, so at wait time the only thing available is the next unused
sequence. A consumer that needs certainty should attribute by time overlap with
the turn's own window and use the field as a hint.

Every write is wrapped in a catch: a wait that cannot be recorded still waits.
An agent must never lose `lazy_wait` because an observability write failed.

## Agent-reported progress

The working substate answers *who is active* — agent, harness, a wait, nothing.
It cannot answer *doing what*: `working(agent)` looks identical for an agent
reproducing a bug, running a migration, and re-reading the same file for the
ninth time. `lazy_update_progress` is the complementary channel — the agent
posts a short human-readable line and every surface that already renders the
substate folds it in.

**Ephemeral, latest-wins, never history.** A progress line is worthless five
minutes after it was written, so it never reaches Storage: permanent storage of a
self-reported status blurb would be a second, worse turn log. Each call replaces
the previous message; there is no history and there must not be one. What *is*
durable about a turn (rationale, decisions, deferrals) belongs in the journal.

| Piece | Where |
| --- | --- |
| The tool | `lazy_update_progress` (`src/mcp/tools.ts`) — agent-only, requires a task context |
| Daemon-side writer | `recordProgress()` in `src/daemon/progress-registry.ts` |
| Live marker readers see | `progress.json` in the task's protocol dir (`src/protocol/progress.ts`) |
| Substate decoration + label | `src/utils/working-substate.ts` (`WorkingSubstate.progress`) |

**Who writes it.** The daemon, for the same reason it writes `waiting.json`:
every agent tool call authenticates with a per-session MCP token, so
`handleMcpToolCall` already knows which task is reporting. Nothing parses agent
stdout, and no client writes the marker directly.

**Rendering.** `working(agent: running migration 3/7)` across `lazy list`,
`lazy active`, `lazy status`, `lazy show`, `lazy watch`, and the MCP `substate`
field — one shared derivation, so the surfaces cannot drift. The line is
whitespace-collapsed and capped at 120 characters at the write boundary (and
again on read, so a foreign file cannot break a table cell). Over-length messages
are **truncated, never rejected**, and the truncation is echoed back to the agent
rather than being silent.

**Precedence.** The progress line decorates only the kinds where the *agent* is
the active thing: `agent`, `agent:answering`, `agent:pre-accept`, and
`waiting on …`. It is deliberately absent from `harness:<phase>` — that phase is
the supervisor's work, and showing the agent's last line there would report a
claim about a turn phase that has already ended — and from `not-alive`.

**Clearing is structural, not remembered.** `writeCommand` deletes
`progress.json`, and every turn begins with a command, so a new turn always begins
with no progress: a message from a finished turn cannot linger. Belt and braces
around that: the substate only renders while a live `status.json` exists,
`cleanProtocol` removes the file at turn teardown, a clean daemon stop clears
every marker it owns, and the marker carries the writing process's pid so a
reader that finds it dead disbelieves the file and reports no progress.

**Bookkeeping never breaks the call it observes.** Every write in the registry is
wrapped in a catch. A progress post that cannot be recorded is a lost status
line; losing a status line must never cost an agent its tool call, let alone its
turn.

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
`failure_attempts`). The reconciler treats a set, non-`unknown` `failure_class` as the signal
to move the task to **`blocked`** — not `interrupted` — and records the classified reason as
an interrupt. This matters because `maybeAutoResume` only ever fires on `interrupted` tasks;
`blocked` is what actually stops the reconciler from relaunching into a dead condition, and
puts the task in front of a human with the reason attached.

### The crash-loop backstop reports, it does not judge

The fast-crash-loop detector (3 failures under 10s) throws `CrashLoopError`, which writes the
same three fields. Its class is always `unknown` — the detector runs for no other class (see
`appliesFastFailDetection`) — and `unknown` on the wire is **diagnosis only**: the task still
goes to `interrupted` with auto-resume, because many crash-loop causes are transient. Before
this, the backstop threw a bare `Error` and the whole classification was dropped, so the
recorded turn said only `Crash loop detected: …` with no class or attempt count.

Agent classifiers must therefore keep unrecoverable conditions *out* of `unknown`. Cursor's
`ActionRequiredError` (plan quota spent, spend limit needed) is `fatal_auth` for exactly this
reason; Claude's `usage limit reached` is a self-healing 5-hour window and stays
`transient_overload`. Both live in each agent's own classifier, never in the shared signals.

The Cursor verdict is narrower than the wording alone: quota phrasing is fatal only when
nothing in the message says the wall clears by itself. A rate-limit marker, or a reset horizon
stated as a short duration ("resets in 20 minutes"), falls through to the shared signals and
stays `transient_overload` — a horizon stated as a *date* ("when your monthly cycle ends on
9/19/2026") does not, because no retry ladder outlives it. Ambiguity resolves toward retrying:
a wrong `fatal_*` blocks work that would have finished.

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

This ensures a response the reconciler has not read yet is still processed when the task has already moved to interrupted.

#### Superseded Response Sweep

The sweep above catches a response the reconciler had not looked at yet. It does
not catch a response that was overwritten before anyone read it.

**Problem**: every command the host sends the agent is a file, and so is every
response the agent sends back. Sending a new command used to delete an unread
response first, so that the agent's next turn did not look already-answered. If
the agent had just finished a turn when you ran `lazy unblock`, that finished
turn was deleted unread: it never appeared in `lazy show`, and because the same
step is what records which agent session the turn ran in, `lazy pair` opened an
empty session instead of resuming it.

**Solution**: an unread response is now set aside rather than deleted, and a
reconciler sweep records it. The displaced turn shows up in the task's history
like any other turn, and the session it ran in is recovered, so `lazy pair`
resumes where the agent left off.

A recovered turn is recorded as **history only** — it does not change the task's
status and does not disturb whatever turn is running now; the newer turn owns
the task's current state. If a turn's output genuinely cannot be recovered, the
daemon log says so and names the task, rather than the turn disappearing in
silence.

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
- **`test/e2e/agent-binary-seam.test.ts`** — `working → blocked` and `working → interrupted` driven by a REAL supervisor: watchdog kills (wind-down keeps the summary and blocks; no-progress interrupts), SIGTERM→SIGKILL escalation, in-turn crash retry, and session resume. Uses the fake-`claude`-binary seam (`setupTestLazy({ fakeClaude: true })`) so nothing in `src/` is mocked — the other e2e suites reach these transitions through a module mock that replaces the supervisor entirely. Also covers the sandbox permission posture (`hostPermissionMode: 'sandbox'`), which needs `bwrap` and `socat` on Linux
- **`test/e2e/auto-resume-binary-seam.test.ts`** — `interrupted → working → blocked` closed autonomously after a REAL watchdog kill: the reconciler resumes a genuinely crashed turn, the resumed agent receives the crash-context prefix, and unconsumed feedback is re-delivered verbatim. Assertions are on the argv the fake agent actually received, so they cover the prompt as *delivered*, not as composed — the one step `auto-resume.test.ts` cannot reach, because it fabricates its crash and stops at `command.json`

When modifying state transitions, ensure tests cover:
- Valid transitions (should succeed)
- Invalid transitions (should fail or be prevented)
- Reconciler sweeps (should detect and fix inconsistent states)
- Auto-resume circuit breaker (should stop after 3 consecutive crashes)
- Manual recovery paths (should reset circuit breaker)
