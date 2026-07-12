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
- **`merging`** — Pull/merge request submitted to remote, waiting for CI checks and merge.
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
  → conflict      reconciler (agent turn completes with file permission violations)
  → interrupted   reconciler (container dies without response.json)
  NOTE: working cannot transition to pairing or abandoned — the agent is running.

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
  NOTE: merging cannot go to abandoned — merge either succeeds or fails back to blocked.

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

There are four actors (`Actor` in `src/types`):

- **`human`** — a real person acting through the **CLI** boundary.
- **`builder`** — the AI builder that drives Lazy through the **MCP** boundary
  (the orchestrator that calls `lazy_start`, `lazy_unblock`, etc.).
- **`system`** — the daemon acting on its own (reconciler transitions,
  crash auto-resume). Not attributed to whoever happened to trigger the tick.
- **`supervisor`** — the per-task supervisor authoring push-back/maintain
  prompts as human-role turns.

**The discriminator is the channel, not the content source.** A command that
arrives over MCP is `builder`; the same command over the CLI is `human`. This is
deliberate: when the builder relays a human's feedback via `lazy_unblock`, the
turn is still `builder` — the actor records *who submitted* (pressed the
button), not who authored the words. The human's content is persisted verbatim
either way; the tag is orthogonal to it.

Mechanically: CLI commands default to `getActor()` (env-var / `human`). MCP tool
handlers set the actor to `MCP_ACTOR` (`builder`) at origination and thread it
through the RPC layer, because turn-creating lifecycle ops (start, unblock, ask,
resume, stop, sync) persist their turn in the **daemon** — a shared process that
can't see the caller's channel from its own environment. Read surfaces
(`lazy show`, the web dashboard, the MCP `lazy_show` turns section, fidelity /
report digests) label a human-role turn by its authoring actor so `builder` and
`supervisor` turns are distinguishable from what a person typed.

### Transition Triggers

The CLI commands below are the `human`-channel triggers; each has an MCP
equivalent (`lazy_start`, `lazy_unblock`, …) that drives the same transition but
records the actor as `builder`.

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

- **`lazy accept <task>`** — blocked|merging → merging → complete
  - Refuses if uncommitted changes exist
  - For remote tasks: creates/updates PR/MR, waits for checks
    - If merge succeeds immediately → merging → complete
    - If checks pending or approval needed → merging
  - For local tasks: transitions to merging, squash-merges into parent/main → complete
  - Ends session, cleans up container/worktree/branch
  - Concurrency: the whole accept orchestration runs under a process-level
    per-task lifecycle lock (`src/daemon/task-lifecycle-lock.ts`). The daemon
    serves RPCs concurrently, so without this a human accept and a builder
    accept on the same task could both clear preflight and both run the merge —
    leaving the task `blocked` while the merge was already applied. With the
    lock the second accept waits, re-runs preflight, sees the accepted session
    outcome, and returns "already accepted"; the merge runs exactly once.

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
- **`src/cli/commands/start.ts`** — backlog → working transition
- **`src/cli/commands/unblock.ts`** — blocked|interrupted → working transition
- **`src/cli/commands/pair.ts`** — blocked|interrupted → pairing transition
- **`src/cli/commands/accept.ts`** — blocked|interrupted|merging → complete|merging transitions
- **`src/cli/commands/reject.ts`** — blocked|interrupted → abandoned transition
- **`src/cli/commands/close.ts`** — blocked|interrupted → abandoned transition
- **`src/cli/commands/reopen.ts`** — terminal → blocked|backlog transition
- **`src/storage/interface.ts`** — Storage methods for status updates, interrupt recording

## Testing

State machine behavior is tested in:

- **`test/unit/task-state-machine.test.ts`** — Centralized transition table, zombie transitions, status classification, reverse lookups
- **`test/e2e/reconcile.test.ts`** — Reconciler sweeps, crash detection, auto-resume
- **`test/unit/merging-status.test.ts`** — Merging status transitions
- **`test/e2e/pair.test.ts`** — Pairing state transitions and stale pairing sweep

When modifying state transitions, ensure tests cover:
- Valid transitions (should succeed)
- Invalid transitions (should fail or be prevented)
- Reconciler sweeps (should detect and fix inconsistent states)
- Auto-resume circuit breaker (should stop after 3 consecutive crashes)
- Manual recovery paths (should reset circuit breaker)
