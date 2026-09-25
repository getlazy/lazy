# Task State Machine and Crash Recovery

This page describes the statuses a lazy task moves through, which commands and
events move it, and what lazy does when an agent crashes mid-turn.

## How a turn ends

A task's status says where the task IS. It cannot say whether the agent thought
it was finished: `blocked` reads exactly the same whether the agent delivered
the whole task or simply ran out of budget halfway through. So an agent says
which, and a turn ends in one of three ways.

Nothing asks the agent which of the three it was — lazy reads the ending off
what the turn did.

- **Declared done.** The agent calls `lazy_final` — pencils down. The claim
  names the branch head at the moment it was made and is recorded on that turn,
  along with an optional one-line note. It is not a turn-end signal: the turn
  still ends when the agent stops, and an agent may keep working after declaring.
  Declaring is what starts an automatic review; it does not gate acceptance.
- **Needs input.** The agent raised a blocking item (see
  [Raised items](raised-items.md)). The task parks for a human decision.
- **Neither.** The turn simply stopped — budget, watchdog, crash, or the agent
  said nothing. The task parks `blocked`.

The last two look the same in the status: blocked is blocked whether or not
anything was raised. What differs is the record — a blocking item, or none —
and lazy labels the task from that.

**You can accept from any of the three.** A human-facing task gets its
walkthrough whichever way the turn ended, precisely so the decision you are
being asked to make has something to go on.

The first two are exclusive. `lazy_final` refuses while a blocking item is open
on the task, and names the item, because filing one is the agent having already
chosen the other ending. The task's journal records which items parked it.

### Work left uncommitted when the turn ends

A task is reviewed and merged from its **commits**. Anything an agent edits and
never commits is in no diff, in no walkthrough, and in nothing `lazy accept`
would carry — and it disappears with the worktree. The end of a turn is where
this happens most: the checks that close a turn ask the agent to update docs or
a changelog, and writing the file and forgetting the commit is an easy miss.

Three things make that visible rather than silent.

- **The agent is asked, once, before the turn closes.** When a turn that
  declared itself done still has uncommitted paths, lazy puts them to the agent
  by name and asks it to commit them or discard them. It is a question, not a
  sweep: lazy never commits on an agent's behalf, because that would put content
  nobody reviewed — scratch output, a half-finished edit, a key someone pasted
  into the worktree — into the merge under the agent's name. A turn that parks
  for input is not asked: an unfinished edit is normal there, the worktree
  survives, and the next turn continues in it.
- **The paths are on the turn record.** `lazy show` puts the count on the turn
  and lists the paths in `--full`; the web review page shows the same count on
  the turn, with the paths in the tooltip.
- **Accept refuses, and says which files.** A task whose worktree still holds
  uncommitted changes cannot be accepted, and the refusal names the paths and
  states that none of them is on the branch. Commit what belongs to the task,
  discard the rest, then accept.

### A declaration is about a SHA, and it can go stale

Because a final names the head it was made at, the head can move afterwards — a
sync merge, a commit made while pairing, a subtask accepted into a parent. None
of those cancel the declaration; every surface that shows a final instead says
so:

```
declared final at 9f3c1a2b; head has since moved (a sync)
```

What DOES cancel it is an agent going back to work: a later agent work turn that
produces commits clears the declaration, and whoever did that work declares
again when they are finished. A turn that committed nothing, a sync, a review, a
question and the automated follow-ups all leave it standing.

`lazy show` prints the declaration (or `not declared`) next to the task's status,
`lazy show --json` carries it as `final`, and the web review page leads with it.

## Task Status State Machine

### Status Definitions

Lazy tasks can be in one of the following statuses:

- **`backlog`** — Task created but not yet started. No session exists.
- **`working`** — Agent is actively working. Container/process is running.
- **`blocked`** — Agent completed a turn and is waiting for human review/feedback.
- **`conflict`** — Agent completed a turn but file permission violations were detected. Semantically "blocked with a decision owed at merge time": the task is unblocked, resumed and paired exactly like a `blocked` one, and nothing reverts the violated files. Only `lazy accept` gates on them — every *pending* violated file must be approved there (all-or-nothing) or the accept is refused. A decision already made is sticky, and re-naming an approved file is always accepted. See [Resolving a conflict task](lazy-toml.md#resolving-a-conflict-task).

  **`conflict` is derived, never set by hand.** The set of pending violations decides it: a paused task is labelled `conflict` while that set is non-empty and `blocked` once it is empty. Every way a task comes to rest — a turn or sync finishing, a failed turn being parked, crash recovery, a pairing session ending, `lazy stop`, `lazy doctor <task>` — re-checks the set rather than simply writing `blocked`.
- **`submitted`** — The task's branch has an open pull/merge request waiting for review on the forge (`lazy submit`). It is a paused status like `blocked`: you can unblock it, review it, sync it, pair on it or accept it.

  **A sync or review puts `submitted` back when it ends.** Merging upstream into the branch and running a review both move the task through `working` for the duration of the turn, because each needs an agent — but neither changes where the task stands with its reviewer, so each restores the status it found. That keeps the task in the submitted view and keeps PR-comment reactions (which only run on `submitted` tasks) switched on. A sync that fails in a way lazy will not retry — a dead credential, a bad model id, anything it parks for you rather than resuming — restores `submitted` too. A crash lazy *will* retry, or an agent killed outright without reporting, goes to `interrupted` instead and is resumed: the merge may be half applied, so the task is picked back up rather than called done. The other exception is a decision the reviewer still owes on a protected file: pending violations make the task `conflict` regardless, because that label is what `lazy accept` gates on.
- **`pairing`** — Human is working interactively with the task's agent, in the task's container (see [Pairing](pairing.md)). `--host` is an explicit opt-in for tasks that have no container.
- **`interrupted`** — Agent crashed or was killed unexpectedly.
- **`merging`** — A merge is in flight: either an accept is merging the branch locally right now, or the task's PR/MR has been handed to the forge and is waiting for CI and merge (a later `lazy accept` asks the forge what happened). The task reads `merging` for the whole merge phase. If an accept dies partway (daemon restart, crash), the daemon resumes it rather than undoing it — you already said accept.
- **`zombie`** — System-only recovery state for tasks whose branch was merged but whose status was never updated (for example, `lazy accept` crashed after the merge). Lazy detects this and moves the task through `zombie` to `complete`.
- **`complete`** — Task accepted and merged successfully. When the accepted
  task had a parent *task* (a subtask, not a top-level task aimed at a bare
  branch), lazy also leaves a `[Subtask accepted]` comment on that parent with
  the merge commit SHA. The comment does not start a turn or unblock the
  parent; it shows up in the parent's next notes. `lazy wait` reports the same
  SHA as `head_sha` once the child is complete, so a parent that already waited
  can ignore a duplicate note. The same comment is written when a forge merge
  completes the task, and a missed comment is retried by the daemon.
- **`abandoned`** — Task rejected (`lazy reject`) or closed (`lazy close`, e.g. "won't do", duplicate) by a human. Both commands resolve to this single terminal status; there is no distinct `closed` status. When the task had a parent *task*, that parent gets a `[Subtask removed]` comment naming the reason.

### A parent task is told when its subtask list changes

A task whose subtasks come and go gets a one-line comment each time, so its
agent can see what happened on its next turn:

- `[Subtask added] <child> — "<goal>"` when a subtask is created under it
  (`lazy create --parent`, the web New-task form, a clone or redo of a subtask,
  an agent creating one of its own subtasks), reparented into it, or reopened
  after having been closed.
- `[Subtask removed] <child> — "<reason>"` when a subtask is closed, rejected or
  abandoned, and `[Subtask removed] <child> — reparented to <parent>` when it
  moves elsewhere.
- `[Subtask accepted] <child> …` when a subtask is accepted and merged (see
  `complete` above). An accepted subtask is only ever reported this way — never
  also as removed.

The quotes are deliberate: text somebody typed — the subtask's goal, the reason
it was closed — is quoted so it reads as a quotation rather than as instructions
to the parent's agent. Lazy's own wording, like `reparented to <parent>`, is
not.

Like every other lazy comment, these never start a turn and never unblock the
parent: they show up in its next notes. A top-level task has no parent task, so
nothing is written for it, and neither is anything written to a parent that is
already `complete` or `abandoned`.

### Status Categories

**Terminal statuses** (task is finished, core fields frozen):
- `complete`, `abandoned`

**Blocked statuses** (waiting for human action):
- `blocked`, `conflict`, `submitted`

**Active statuses** (has active worktree that should not be merged into):
- `working`, `interrupted`, `pairing`, `merging`

### Valid State Transitions

```
backlog
  → working       lazy start (creates session, launches agent)
  → blocked       daemon (a backlog task whose branch already has commits)
  → abandoned     lazy close (task canceled before starting)

working
  → blocked       daemon (agent turn completes)
                  | daemon (the agent failed in a way retrying cannot fix —
                    see "Agent Failure Classification" below; NOT auto-resumed)
  → conflict      daemon (agent turn completes with file permission violations)
                  | lazy accept (a failed acceptance gate restores the status the task had before)
  → submitted     lazy accept (same restore, for a task that was submitted)
                  | daemon (a sync or review turn ends on a task that was
                    submitted — the turn restores the status it found; a sync
                    that failed in a way lazy will not retry restores it too,
                    while one it will retry goes to `interrupted` instead)
  → interrupted   daemon (the agent's container or process died without finishing the turn)
  → merging       daemon (the task's PR/MR was merged on the forge)
  NOTE: working cannot transition to pairing or abandoned — the agent is running.
  NOTE: accept flips the task to `working` while the acceptance gate runs and
        restores the status it actually had if the gate fails.

blocked
  → working       lazy unblock (human gives feedback)
  → conflict      any park that re-checks the label and finds pending
                  violations (see "conflict is derived" above)
  → pairing       lazy pair (human wants to work interactively)
  → submitted     lazy submit (opens a PR/MR for review)
  → merging       lazy accept (begins merge process)
  → abandoned     lazy reject (rejects the work) | lazy close (canceled without accept/reject)
  → backlog       daemon (a blocked task with no session is moved back to backlog)
  NOTE: blocked cannot go directly to complete — must go through merging first.

conflict
  → working       lazy unblock (feedback, like any blocked task) | lazy resume
                  | auto-resume / auto-delivery
  → blocked       any park that re-checks the label after every violation was
                  approved on the review page
  → pairing       lazy pair (human wants to work interactively on violations)
  → submitted     lazy submit
  → merging       lazy accept (once every pending violation is approved)
  → abandoned     lazy reject | lazy close

submitted
  → working       lazy unblock | lazy sync | lazy review
                  (each of these runs a turn; sync and review restore
                  `submitted` when the turn ends, an unblock does not — feedback
                  means the task is being worked on again)
  NOTE: `lazy resume` and `lazy ask` do NOT apply to a submitted task. Resume is
        for picking a task back up where its turn stopped (interrupted, blocked
        or conflict only); a review question runs only on a blocked or conflict
        task. Send feedback with `lazy unblock`, or run `lazy review`.
  → merging       lazy accept (merges the reviewed branch)
  → pairing       lazy pair (human wants to work interactively)
  → abandoned     lazy reject | lazy close
  → blocked       lazy itself, in one case only: the task was re-parented (its
                  parent was accepted or closed, or `lazy reparent`), and its
                  pull/merge request could not be moved to the new target, so
                  lazy closed it — the task no longer awaits a forge review
  NOTE: otherwise submitted does not go directly to blocked or conflict. It
        leaves through a turn (via `working`), an accept, a pairing session, or
        rejection — a finished sync or review puts `submitted` back rather than
        re-labelling the task, unless a protected-file decision is owed.

interrupted
  → working       auto-resume (daemon, circuit breaker allows) | lazy resume
                  | daemon (the agent's answer arrived after the task was
                    marked interrupted; it is recorded via working → blocked)
  → pairing       lazy pair (human investigates interactively)
  → merging       daemon (the task's PR/MR was merged on the forge)
  → abandoned     lazy reject | lazy close
  NOTE: interrupted cannot go to complete directly, and `lazy accept` does not
        take an interrupted task — resume or unblock it first.

pairing
  → blocked       pairing ends (the session exits) | daemon (the pairing process is gone)
  → conflict      same two paths, when the task still owes a decision on
                  file-permission violations

merging
  → complete      lazy accept (checks pass, merge succeeds) | daemon (merge completed)
  → blocked       lazy accept (checks fail) | daemon (PR/MR closed on the forge)
  → conflict      lazy accept (merge phase aborts on a task that was in conflict)
  → submitted     lazy accept (merge phase aborts on a task that was submitted)
  NOTE: merging cannot go to abandoned — merge either succeeds or fails back to
        the status the task held before the accept. A task in `conflict`
        (unresolved violations) or `submitted` (open PR awaiting review) is not
        `blocked`, so every abort restores the true prior status.
  NOTE: the merge is the accept's commit point. The moment it lands the task
        becomes `complete`; fast-forwarding the local branch, pushing the
        parent, tagging, re-parenting children and cleanup happen AFTER, and a
        failure there is reported as a failure (non-zero exit, the step named)
        and retried by the daemon — it never moves the task out of `complete`.
  NOTE: an accept that DIES (daemon restart, crash, kill) leaves the task in
        `merging`. The daemon RESUMES it, whether it died before or after its
        merge landed: a merge that already landed is recognised and not
        repeated. While that resume is pending, `lazy reject`, `close`, `submit`
        and `unblock` refuse (they would undo an accept that may already have
        merged); `lazy accept` resumes it immediately. After three failed
        automatic resumes the daemon stops, files a system message, and those
        commands work again to recover the task to a resting status — except
        when the work has already landed on the target: then they refuse and
        point you at `lazy accept`, which finishes the accept instead of
        undoing it. `lazy doctor` reports anything sitting in `merging`.

zombie (system-only)
  → complete      daemon (the task's branch is found merged)
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
provenance only: it never changes what a command does, it records who did it.

There are five actors:

- **`human`** — a person using the `lazy` CLI.
- **`builder`** — an AI orchestrator driving lazy through its MCP tools
  (`lazy_start`, `lazy_unblock`, etc.).
- **`agent`** — a task's own agent driving its OWN subtree through the same MCP
  tools (creating, starting, unblocking, and accepting its own subtasks). An
  agent accepting its subtask is therefore never recorded as a human's or the
  builder's decision.
- **`system`** — the daemon acting on its own (status changes it detects,
  crash auto-resume).
- **`supervisor`** — lazy's per-task supervisor, for the follow-up prompts it
  sends the agent itself (push-back and maintain checks).

**The actor records the channel, not who wrote the words.** A command that
arrives over MCP is `builder`; the same command over the CLI is `human`. When a
builder relays a human's feedback through `lazy_unblock`, the turn is still
`builder` — the actor records who submitted it, not who authored it. The content
is stored as written either way.

Everything an operation writes carries its one actor: the turn, every status
change it makes, and any comment it leaves — for commands that start a turn
(start, unblock, ask, resume, stop, sync), for those that do not (reject, close,
submit, reparent), for task creation and for journal entries. `lazy show`, the
web dashboard and `lazy_show` label each human-side turn with its actor, so
`builder` and `supervisor` turns are distinguishable from what a person typed.

**An absent actor means the default.** An agent's own reply never carries an
actor (it is labelled by its role instead). On any other turn or status change,
no actor means a CLI/human action. Commands that start a turn always record
their actor explicitly, `human` included.

### Text intake is sanitized at the boundary

Every prompt lazy sends an agent is passed on the agent's command line, where a
raw NUL byte is illegal. So every place lazy takes in text — `lazy unblock`,
`comment` and `create`, the `$EDITOR` and piped-stdin paths, every MCP tool
argument, and auto-delivered PR comment and CI text — sanitizes it **before
saving it**. Non-printable control characters (C0 except tab/LF/CR, DEL, and C1)
are replaced with printable escapes: a NUL becomes the six characters `\u0000`.

For free-text arguments that become prose in a prompt (`feedback`, `message`,
`prompt`, `note`, `reason`, `question`, `goal_context`), a short note is appended
saying a substitution was made, so it is visible rather than silent. Strings
that are *not* prose are escaped **without** that note: short single-line fields
like a task goal, and file-path lists such as `files` and `approved_files`,
where an appended paragraph would corrupt the path.

The policy is **sanitize and deliver, never reject**: rejecting would discard
feedback at exactly the moment you finished typing it. Nothing is dropped — only
re-encoded. Ordinary text passes through byte-for-byte.

### Transition Triggers

The CLI commands below record the `human` actor; each has an MCP equivalent
(`lazy_start`, `lazy_unblock`, …) that makes the same transition but records
`builder` (or `agent`, when the caller is a task agent acting inside its own
subtree).

#### Human Actions (CLI commands)

- **`lazy start <task>`** — backlog → working
  - Creates the session, the worktree and the container, then launches the agent
  - Narrates itself phase by phase — see [Command observability](#command-observability)

- **`lazy unblock <task>`** — blocked|conflict|interrupted|submitted → working
  - Opens $EDITOR for your feedback (or reads from `--message`/stdin)
  - Records your feedback as a turn, then launches the agent
  - To merge upstream first, run `lazy sync <task>` separately — unblock does not
  - Narrates itself phase by phase — see [Command observability](#command-observability)

- **`lazy resume <task>`** — interrupted|blocked|conflict → working
  - Manual recovery, e.g. after the auto-resume circuit breaker fires
  - Same as unblock but without feedback
  - Pending protected-file violations do NOT refuse it: no turn reverts a file,
    so the decision stays owed at `lazy accept` and the work can continue.
    Auto-resume and auto-delivery treat such tasks the same way
  - Narrates itself phase by phase — see [Command observability](#command-observability)

- **`lazy pair <task>`** — blocked|conflict|interrupted|submitted → pairing
  - Launches the task's agent interactively inside the task's container,
    resuming its session if it has one (`--host` runs it on the host instead,
    and is refused unless asked for — see [Pairing](pairing.md))
  - On exit, records a summary turn and returns the task to blocked (or
    `conflict`, if violations are still pending)

- **`lazy ask <task>`** — blocked|conflict → working → blocked|conflict (status-neutral)
  - Read-only: resumes the agent session (plan mode plus hard tool denials) to
    answer one question
  - **Only when the session can be resumed.** For any other task — finished,
    session ended, worktree gone — the question is answered from the task's
    stored record by a throwaway read-only agent instead. That route touches no
    status at all (not even the transient `working` below), takes no worktree
    lock, and records no turn; the answer states where it came from. A task that
    has never run is the one case with nothing to answer from.
  - Opens $EDITOR for the question (or reads from `--message`/stdin)
  - Records the question as a turn before launching, and the answer as an agent turn
  - Restores the status the task had before the ask when the turn ends — on
    success and on error — so an ask never changes task state. The brief
    `working` just marks the task busy while the agent answers
  - The one exception is a timeout: the task stays `working` so an answer that
    still arrives can be recorded; it then parks as `blocked` or `conflict` as usual
  - If the agent crashes mid-ask the task lands in `interrupted` like any other turn
  - A second `lazy ask` on a task that is already answering one is refused
  - Narrates itself phase by phase — see [Command observability](#command-observability).
    The narration goes to stderr, so the answer on stdout stays pipeable, and
    `--json` prints no narration at all

- **`lazy chat <task>`** — no transition at all (status-neutral)
  - On a `blocked`/`conflict` task: resumes the agent session interactively in the
    worktree, read-only (same denials as ask). No status change, no turn, no
    commits — the only lasting effect is the session log saved on exit
  - Holds the worktree lock for the chat's duration, so start/unblock/sync/resume
    refuse while a chat is open rather than starting a turn underneath it
  - On a terminal task: resumes the saved session in the project root (no
    worktree exists)

- **`lazy accept <task>`** — blocked|conflict|submitted → merging → complete
  - Refuses if uncommitted changes exist
  - For remote tasks: creates/updates the PR/MR, waits for checks
    - If the merge succeeds immediately → merging → complete
    - If checks are pending or approval is needed → stays merging
  - For local tasks: squash-merges into the parent branch → complete
  - Ends the session and cleans up container/worktree/branch — after the task
    is already `complete`: a failure there exits non-zero and is retried by the
    daemon, but the accept stands
  - Narrates itself phase by phase — see [Command observability](#command-observability)
  - Status tracks the phase in flight: plain `working` while the opt-in
    acceptance gate runs, `merging` for the whole merge phase. Every abort
    restores the status the task actually had before the accept
  - If the acceptance gate's run disappears without answering, the accept aborts
    within seconds — reporting the run's exit code and last output, restoring
    the task's prior status, and recording the reason on the task — instead of
    waiting out the gate's full budget. The merge only proceeds on a verdict
    that actually came from the gate
  - Two accepts of the same task at once (say, a human and a builder) never
    both merge: the second waits, sees the task already accepted, and says so
  - The parent must not be active (working/pairing/merging/interrupted) —
    merging into a live worktree would corrupt whatever is running in it. ONE
    exemption: a task's own agent accepting one of its direct subtasks over MCP
    while the parent is `working` (the agent asking is the one in that
    worktree), or a human pairing on the parent in its container accepting from
    that session while it is `pairing`. The caller's task identity comes from the token the daemon issued for its session, never
    from anything the caller sends, so a CLI caller or a different task can
    never claim it (see [Identity comes from the token, not the
    URL](lazy-agent-design.md#identity-comes-from-the-token-not-the-url)).
    `merging` and `interrupted` still refuse for everyone. Host pairing
    (`lazy pair --host`) does not get the exemption
  - Uncommitted work in the destination worktree does not block the merge and
    is never lost: the accept sets it aside, merges, and puts it back. If it
    cannot be put back cleanly, the merge still stands and lazy reports where the
    work was kept and how to recover it
  - Over MCP, a task agent may accept a DIRECT SUBTASK ONLY, never its own task:
    accepting means "merge upward and mark complete", so accepting yourself
    would skip the review the task exists for. Accepting a child merges into the
    agent's own branch, which a human still reviews when that task is accepted.
    Other agent tools allow the agent's own task or a direct child. The builder
    is unrestricted

- **`lazy reject <task>`** — blocked|conflict|interrupted|submitted → abandoned
  - On a `working` task, stops the agent first (working → interrupted → abandoned)
  - Opens $EDITOR for the rejection reason
  - Ends the session, cleans up container/worktree/branch
  - Narrates itself phase by phase — see [Command observability](#command-observability)

- **`lazy close <task>`** — backlog|blocked|conflict|interrupted|submitted → abandoned
  - On a `working` task, stops the agent first (working → interrupted → abandoned)
  - Opens $EDITOR for the close reason
  - Ends the session, cleans up container/worktree/branch
  - Resolves to the same `abandoned` status as `lazy reject`; the two differ only in intent/reason
  - Narrates itself phase by phase — see [Command observability](#command-observability)

- **`lazy reopen <task>`** — complete|abandoned → blocked|backlog
  - For complete tasks: requires `--reason`, resets the session, returns to blocked
  - For abandoned tasks: returns to blocked if the task had agent work, otherwise backlog

#### Agent Actions

- **Agent turn completes** — working → blocked | conflict
  - The agent's turn is recorded
  - If the turn produced file permission violations, or earlier ones are still
    unresolved → conflict; otherwise → blocked
  - A turn that runs no permission check (an ask, a sync) never clears
    violations that are still pending

- **Agent crashes** — working → interrupted
  - The container or process exits without finishing the turn
  - Auto-resume may kick in (see [Crash/Resume Lifecycle](#crashresume-lifecycle) below)

#### System Actions (daemon)

The daemon keeps checking task state in the background and fixes up anything
that has changed underneath it:

- **Working tasks** — a finished turn is recorded and the task parks `blocked`
  (or `conflict`). A task whose agent has died without finishing gets a crash
  turn recorded — so `lazy show` shows what happened — and moves to
  `interrupted`, where auto-resume may pick it up.
- **Late answers** — if an agent's answer arrives after its task was already
  marked `interrupted`, it is still recorded and the task parks `blocked`.
- **Leftover containers** — containers still around for `complete` or
  `abandoned` tasks are removed.
- **Branches merged elsewhere** — a task whose branch is found merged into its
  target is completed (via `zombie`).
- **Dead pairing sessions** — a task left in `pairing` after its session ended
  returns to `blocked`.
- **Blocked tasks with no session** — moved back to `backlog`, which is where
  unstarted work belongs.

## Only one turn runs at a time

A task never has two turns dispatched at once. If an unblock, an ask and an
automatic sync arrive together, the first one to claim the task wins, and the
others see the task is busy:

- an ask or unblock is refused (409) **before** anything is recorded, so no
  feedback is lost — send it again once the task is idle;
- a sync re-queues itself and is reported as `pending_sync`, naming the status
  it stood down for, and runs later.

A turn is only dispatched from `blocked`, `conflict`, `submitted` or
`interrupted`. A task in `pairing` or `merging` is never handed a new turn.

## Command observability

Several CLI commands can run for seconds or minutes — starting a task (worktree
creation, branch publish, container launch), unblocking with feedback, merging
upstream into a task, asking its agent a question, accepting a merge, or
closing/rejecting a task (stopping the agent, remote PR cleanup, worktree
teardown). They narrate what they are doing, phase by phase.

**How it looks on the terminal.** Before work begins, the command prints a
numbered plan of the phases it expects to run. As each phase starts and
finishes, you get a line — on a TTY the open phase repaints with a live elapsed
counter; in piped or CI output the lines are append-only. Optional phases that
do not apply (for example publishing a branch for a linked task, or stopping an
agent that is not running) are listed up front and then reported as skipped with
a reason.

**A long phase keeps saying so.** Some phases do their work without anything to
report as they go — fetching an upstream branch, creating a container. On a TTY
the elapsed counter on the open line already shows that; in piped or CI output,
where there is no line to repaint, the command adds a `still running (…)` line
for the phase whenever roughly five seconds have passed with nothing printed. A
phase that finishes quickly adds nothing. These lines follow the daemon's own
liveness, so they stop when it stops — silence still means something is wrong.

**Pre-flight is always a prelude.** Every command runs validation first — task
and session checks, runner availability, dirty-worktree guards — and narrates
that as an unnumbered step. The numbered plan is announced only once pre-flight
knows which path applies.

The MCP tools for the same operations relay the same phases as progress
notifications.

| Command | Typical phases (after pre-flight) |
| --- | --- |
| `lazy start` | Resolve integration base → create worktree → publish branch (when applicable) → launch agent |
| `lazy unblock` | Prepare worktree → record feedback turn → launch agent; plus resolve file-permission violations when the task has any |
| `lazy sync` | Check task branch on origin → fetch and resolve upstream → compare with upstream → prepare worktree → launch agent to merge |
| `lazy reparent` | Repoint task to new parent → then the whole sync plan above, as one continuous checklist |
| `lazy resume` | Prepare worktree → launch agent |
| `lazy ask` | Prepare worktree → launch agent → wait for the agent's answer |
| `lazy accept` | Branch-protection and merge gates → merge description → merge → finalize → clean up |
| `lazy close` | Update task status → clean up worktree (when the task had a session); stop running agent first when applicable |
| `lazy reject` | Same as close, plus close the remote PR/MR when one exists. The reason is recorded on the task; nothing is written to the PR |

`lazy submit` is not in this table: it pushes the branch and marks the PR/MR
ready for review, and launches no turn. It asks first: a protected target
is a yes/no prompt (default No); an unprotected or unknown target requires
typing the branch name or the task code. `--yes` skips that. MCP
`lazy_submit` uses a `confirmation_code` instead — there is no `--yes`.

**Inside the launch phase.** Launching an agent is where a command can go quiet
for the longest, because it may have to build the container image first. That
interior is narrated under the launch phase itself, as indented continuation
lines: which image is being resolved, whether a task-pinned or adopted image is
in use, why a build is needed (no image for this lazy version yet, the Dockerfile
or its inputs changed, or the image is older than the maximum age), the build's
own output throttled to a readable rate, a `still building (…)` heartbeat while
Docker is quiet, and finally whether the container was created or an already
running one was reused. On a TTY these update the phase's line in place; piped,
they append. The phase does not settle until the agent is actually launched, so
the elapsed counter keeps running honestly throughout.

Narration is strictly observational — it never changes whether the command
succeeds or fails, and a phase is only marked failed when the command itself
fails. A sync that finds nothing to merge still settles its compare phase with
"already up to date" and reports the remaining phases as skipped, rather than
ending in silence; a sync whose fetch fails is not an error either — it queues
the task for retry and says so on the upstream phase's own line.

### `lazy sync` reconciles two things, in order

A task can be behind in two different ways, and sync handles both on the task's
own branch:

1. **The task's own branch on origin.** If a colleague has pushed commits to
   `origin/<task-branch>` — a review fix, a rebase of your work, a hand-written
   patch — those commits are merged into the worktree first. When the local
   branch is simply behind, this fast-forwards; when both sides have moved, it
   is a real merge, and any conflict is resolved by the task's own agent. The
   step is skipped, with a one-line reason on its own phase, when the remote
   driver is `local`, when lazy is offline, or when the branch is not on origin
   yet.
2. **The parent branch.** Fetched and merged into the task branch.

Neither step ever touches, merges into, or pushes the parent branch — syncing a
child does not reconcile its parent. Both merges are recorded on the task, so
`lazy show` and the web review page name the ref and commit each one brought in
("Merged origin/lazy/my-task @ 4f2ab19", then "Merged main @ 9c1de07").

Sync itself never pushes. The reconciled branch reaches origin through the push
that follows a turn, and through `lazy accept`.

### Accept-specific behavior

**Accept does not need a declaration.** It works from any park where the turn
ended normally — declared done, parked for a decision, or simply stopped — and
requires only that every open blocking item is resolved in the same command.
Deciding those items with the work in front of you IS the declaration.

The one park accept refuses is `interrupted`: a turn that was killed (watchdog,
container death, `lazy stop`, a closed pairing session) has an unknown ending,
because the agent never got to stop. Resume or unblock it first, or close it.
Like every other acceptance precondition — branch sync, protection preflight,
the review-issues gate — this is checked before anything is written, so a
refusal leaves the task exactly as it was.

An accept can run for minutes — an opt-in acceptance gate, remote pushes, an
LLM-written merge description, the merge itself. The announced plan is the plan
that runs: the acceptance gate appears in it only when enabled, and a later
`lazy accept` on a task already waiting on the forge shows a shorter plan (check
remote state → finalize → clean up).

**The merge description is an enhancement, never a gate.** It is written by a
one-shot agent run outside every git checkout, with write tools disabled and a
ten-minute limit. If it fails or times out, the accept falls back to a plain
list of the commits and proceeds. See
[conversation-import.md](./conversation-import.md#where-a-one-shot-runs).

**Status during an accept.** The narration tells the caller who is watching what
the accept is doing; the task's status tells everyone else (`lazy list`,
`lazy show`, MCP):

| Accept phase | Status |
| --- | --- |
| Acceptance gate (opt-in) | `working` |
| Merge phase (description, merge, finalize) | `merging` |
| Aborted at any point | the status held before the accept |

No agent turn runs during the gate, so the task shows a bare `working` with no
agent substate.

## Working, but not alive

`working` is where the task is in its lifecycle; the part in brackets is what
lazy can see running for it right now. `working(not-alive)` means the task is
still recorded as mid-turn but nothing is running for it and no answer is
waiting — the turn's process has died. It is a short-lived state: once the
turn is at least 30 seconds old, the daemon's next check (every few seconds)
either recovers a turn that had finished its work to `blocked`, or records the
crash, moves the task to `interrupted` and resumes it automatically.

Two things that look similar are not that:

- **`working(launching)`** — the daemon is still starting the turn's container
  or process. Building the container image on a fresh machine or after an
  upgrade can take minutes; the task is not dead, it has not started yet.
- **A running review** — `lazy review` runs its reviewer separately from the
  task's own agent, and the task reads `working(agent:reviewing)` for as long as
  the reviewer is running. If the reviewer dies without answering, the review is
  recorded as failed and the task goes back to the status it had before. A
  review or `lazy ask` that was running when the daemon restarted cannot finish
  — the restart cuts it off from the model — so the new daemon stops it, records
  it as failed, and puts the task back the same way.
- **Plain `working`, no brackets** — the run is starting up or its answer is
  being collected, or the container runtime did not answer when lazy asked
  about the run (a busy Docker, for example), so its liveness is unknown rather
  than dead. `lazy daemon health` names that last case as a warning with the
  reason.

A task that reads `working(not-alive)` for more than a minute or so is a bug
worth reporting. Include the `liveness` and `session` parts of
`lazy show <task> --json` and the output of
`lazy daemon logs <short-id> --no-follow -n 20000`, where `<short-id>` is the
first 8 characters of the task's `id` in that JSON (daemon log lines name tasks
that way).

## Waiting on subtasks

An agent that splits its work into subtasks drives them with blocking lazy
tools — `lazy_wait` (wait until a subtask finishes its turn) and `lazy_ask`
(ask a subtask's agent a question and wait for the answer). While blocked in one
of those calls the parent agent is doing nothing, and lazy shows that instead of
a plain `working(agent)`:

```
working(waiting on fix-foo (2m10s))
```

This appears in `lazy list`, `lazy active`, `lazy status`, `lazy show`,
`lazy watch`, and the MCP `substate` field. Two concurrent waits list both
labels; a larger fan-out is summarized (`waiting on a, b +2`).

Waiting outranks the turn-flavour substates (`agent:answering`,
`agent:reviewing`) — those say what the turn *is*, `waiting` says what it is
doing this second. A lazy-side phase (`harness:<phase>`) outranks waiting, and a
dead run still reads `not-alive`. If the daemon is killed mid-wait, the marker
is disregarded and the task falls back to `working(agent)`.

Time spent waiting is recorded separately from the agent's own working time, so
a turn that spent two hours blocked on a subtask does not bill those two hours
to the agent in duration or cost reports. A failure to record a wait never
affects the wait itself.

## Agent-reported progress

The working substate answers *who is active* — agent, lazy, a wait, nothing.
It cannot answer *doing what*. `lazy_update_progress` fills that gap: the agent
posts a short line and every surface that shows the substate folds it in:

```
working(agent: running migration 3/7)
```

- **Latest wins, no history.** Each call replaces the previous line, and
  nothing is kept — a progress line is worthless five minutes later. What is
  worth keeping about a turn (rationale, decisions, deferrals) belongs in the
  journal.
- **Bounded.** The line is whitespace-collapsed and capped at 120 characters.
  Longer messages are truncated, never rejected, and the agent is told.
- **Only while the agent is active.** It decorates `agent`, `agent:answering`,
  `agent:reviewing` and `waiting on …`, never `harness:<phase>` or `not-alive`.
- **Cleared with the turn.** Every new turn starts with no progress line, so a
  message from a finished turn never lingers.

A progress post that cannot be recorded is simply lost; it never costs the agent
its tool call.

## Agent Failure Classification

Not every agent failure deserves the same response. A rate limit clears on its
own; a revoked credential never does. So lazy sorts each failure into a class
and acts on the class.

This is about credentials and conditions that go bad *while a task runs*. A
daemon with no credential at all refuses to start in the first place.

### The taxonomy

| Class | Examples | Behaviour |
|---|---|---|
| `fatal_auth` | 401/403, invalid API key, missing credential, credit balance exhausted | Stop on the first failure |
| `fatal_config` | unknown flag, invalid model, agent binary missing (exit 127) | Stop on the first failure |
| `transient_overload` | 429, 529, 503, "overloaded" | Retry indefinitely, 5s→60s |
| `transient_network` | ECONNRESET, ETIMEDOUT, socket hang up, `fetch failed` | Retry indefinitely, 5s→60s |
| `transient_unreachable` | ECONNREFUSED, ENOTFOUND | Retry 5s→60s, **bounded** at 12 attempts (~9 min), then stop |
| `unknown` | anything unrecognized | Retry 15s→60s; the crash-loop detector still applies |

A failure lazy does not recognize is classed `unknown` rather than guessed at —
wrongly calling a failure fatal would block a task that would have recovered.

Each agent's own wording is recognized too (Claude Code's "Invalid API key ·
Please run /login", Cursor's "not logged in").

### Retry pacing

Transient failures are retried at 5s → 10s → 20s → 40s → 60s (capped) —
roughly 60 retries an hour.

The crash-loop detector (3 failures in a row, each under 10s) does **not** apply
to transient classes: a 429 comes back in milliseconds, so three in a row would
abort a turn that was about to succeed. It remains the bound for `unknown`.

`transient_unreachable` sits in between: a refused connection to a local proxy
can heal if the proxy restarts, so it is retried generously, but not forever.

### What "stop" means

When a failure is classed fatal (or `transient_unreachable` runs out of
attempts), the turn ends and the task moves to **`blocked`** — not
`interrupted` — with the class and reason recorded on it. Auto-resume only ever
restarts `interrupted` tasks, so this is what keeps lazy from relaunching into a
condition that will not clear, and puts the task in front of you with the reason
attached.

A crash loop is different: its class is always `unknown`, recorded for
diagnosis only. The task goes to `interrupted` and is auto-resumed, because
many crash-loop causes are transient.

Conditions that never clear on their own are kept out of `unknown`. A Cursor
plan quota spent or a spend limit reached is `fatal_auth`; Claude's `usage limit
reached` is a 5-hour window that clears by itself and stays
`transient_overload`. A Cursor quota message is only fatal when nothing in it
says the limit clears soon: a rate-limit marker or a short reset horizon
("resets in 20 minutes") stays `transient_overload`, while a reset stated as a
*date* ("when your monthly cycle ends on 9/19/2026") does not. When in doubt,
lazy retries.

### Seeing what is being retried

While a turn is retrying, lazy shows one line saying what and why — for example
`attempt 7 (transient_overload): API Error: 529 overloaded`, with the error
snippet truncated — in all of:

- the `lazy watch` / `lazy status` header
- the `lazy list` / `lazy active` substate
- the "Retry State" block in `lazy show`
- the supervisor log (`Phase: retrying …`)
- `retry_status` in MCP `lazy_show`, so a builder can tell a task stuck retrying
  from a healthy `working` one

### Watchdog kills

A no-progress watchdog kill has no error to classify — lazy killed the agent
itself, after `[agent] watchdog_output_timeout_ms` (default **30 minutes**; the
timer resets on every completed step) passed with no forward progress. What
happens next depends on one question:

| Did the turn capture anything? | Behaviour |
|---|---|
| **Yes** — a final result, or new commits | Not retried. The work is already on disk, so relaunching would repeat it or hang the same way; the turn ends and you read what was captured |
| **No** — no result, no new commits | Relaunched within the turn (5s → 10s backoff), at most 3 attempts. Each attempt costs a full no-progress window, so the bound is tight |

If lazy cannot read git to check for commits, it treats the kill as having
captured nothing and retries.

When a watchdog kill ends the turn, the task goes to **`interrupted`** with
auto-resume, not `blocked`. The recorded turn and the interrupt reason say which
guard fired, what its limit was, that keep-alive output does not count as
progress, and whether lazy already relaunched.

## Crash/Resume Lifecycle

When an agent crashes mid-turn, lazy detects it and tries to resume the task.

### Detection

The daemon watches `working` tasks. A task whose agent container or process is
gone without having finished its turn is marked `interrupted`. A task that
became `working` within the last 30 seconds is left alone, so a container still
starting up is not mistaken for a dead one.

### What is recorded

The crash is recorded as a turn on the task (visible in `lazy show`), along with
diagnostics: a reason (e.g. "OOM killed or SIGKILL (exit code 137)"), the exit
code, the time, and the last lines of the container's logs. `lazy show <task>`
displays them.

Every turn that dies leaves a visible record, even when the same failure repeats
turn after turn: two identical `fatal_auth` failures on consecutive unblocks are
recorded as two turns.

### Circuit breaker

Each crash counts toward a limit of **3 consecutive interruptions**. Once it is
reached, lazy stops auto-resuming and the task stays `interrupted` until you run
`lazy resume` or `lazy unblock`. An agent that crashes three times in a row
without finishing a turn has something fundamentally wrong — out of memory,
broken dependencies, an infinite loop — and needs a human to look.

The counter resets whenever a turn completes, and when you resume or unblock the
task yourself. So only sustained, back-to-back crashes trip the breaker.

### Auto-resume

Auto-resume continues the agent's existing conversation, so it keeps its full
history — but the files on disk reflect wherever the crash left them, and the
agent is told to verify before continuing. What else happens depends on whether
the worktree has uncommitted changes:

- **Clean worktree** (the agent crashed before editing anything, or after
  committing everything): the parent branch is merged into the task branch
  first, so a resumed task does not drift behind, and the agent is told upstream
  was merged. A task pinned to a fixed base commit (`lazy clone --same-base`)
  is not merged.
- **Uncommitted changes** (the agent crashed mid-edit): no merge — merging over
  half-finished edits would fail or tangle them. The agent is told there are
  uncommitted changes from the interrupted turn and asked to review them, keep
  or discard what it finds, commit, and continue.

The resume is recorded as a `system` turn, "Session interrupted and
auto-resumed".

If the crash happened while lazy was merging upstream into the task and the
merge failed, the task is **not** auto-resumed: it cannot make progress without
that merge, and a human needs to look at the conflict.

### Feedback is redelivered after a crash

Your feedback is saved before the agent is launched. If the turn then crashes
before the agent finishes responding to it, the resume — automatic or
`lazy resume` — delivers that feedback again **verbatim**, in place of the
generic "you were interrupted" prompt. If several pieces of feedback went
unanswered, the newest is reproduced and the prompt says how many others there
are. A crash during the resume redelivers the same feedback again. Once an agent
turn completes normally, all feedback before it counts as delivered and is never
redelivered.

This applies to your initial task prompt, `lazy unblock` feedback, `lazy ask`
questions, and PR comments and CI output delivered automatically. A comment made
through lazy itself (`lazy comment`, the web UI, `lazy_comment`) is different:
it never starts a turn, and reaches the agent with the next `lazy unblock`.
`lazy ask` and `lazy sync` neither carry a comment nor use it up.

### Three crash scenarios

| Crash | State after | On auto-resume |
|---|---|---|
| **Before any edits** — agent read files, then crashed | Worktree clean, no new commits | Upstream merged; agent verifies and continues |
| **Mid-edit** — one file edited, another half-written | Worktree has uncommitted changes | No merge; agent reviews the changes, commits, fixes or discards them |
| **After committing but before the turn finished** | Worktree clean, commits on the branch | Upstream merged; agent finds its commits on the branch and continues. The commits are recorded on the task when a later turn finishes |

### A turn nobody read

If you unblock a task just as its agent finishes a turn, that finished turn is
not lost: lazy still records it in the task's history, and remembers the agent
session it ran in, so `lazy pair` resumes where the agent left off. A turn
recovered this way is history only — it does not change the task's status or
disturb the turn now running. If a turn's output genuinely cannot be recovered,
the daemon log says so and names the task.

### Manual recovery

If auto-resume fails or the circuit breaker fires:

- **`lazy resume <task>`** — resume without feedback. Resets the crash counter.
- **`lazy unblock <task> --message "..."`** — give feedback and resume. Resets the counter.
- **`lazy pair <task>`** — work with the agent interactively to debug.
- **`lazy show <task>`** — see the interrupt diagnostics: reason, exit code,
  time, recent log lines, the consecutive-interruption count, and whether the
  session was auto-resumed.
