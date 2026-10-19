# lazy pair

This page is generated from `lazy pair --help`.

```text
Usage: lazy pair [task_id] [--unlock] [--no-summary] [--resume <session_id>] [--autonomous] [--yes] [--host] [--no-task] [--override-usage-pause]

Open an interactive agent session, context-aware.

Four modes:
  1. lazy pair <task>           Pair on a specific task
  2. lazy pair                  On a lazy/* branch: detect the task, pair on it
  3. lazy pair --host           On main or a non-task branch: launch the agent
                                in the current directory (no task context)
  4. lazy pair --host --no-task Same, on ANY branch — even a lazy/* branch with no
                                task in this store

In task mode the session runs INSIDE the task's container, where the task's
own turns run: it reads the same agent home directory the agent already
wrote, so resume needs no copying onto your machine, and --autonomous is the
same trust decision as an ordinary supervised turn.

In task mode the TASK'S OWN agent is launched (a Cursor task pairs with
cursor-agent, never Claude Code). Claude Code and pi sessions are fully
captured (transcript, conversation store, AI summary). Cursor and Codex
pair with reduced capture: commits are recorded, but lazy cannot read
their session files, so the transcript and summary are skipped.

In task mode (1 & 2), the task is locked during pairing — other commands
(start, unblock, accept, reject, resume) will refuse to operate until
pairing ends.

In branchless mode (3, 4) there is no task and no container, so the agent runs
on your machine: --host is required (and --no-task, on a lazy/* branch or to
skip task detection). The conversation is captured into
lazy's storage so it's searchable via lazy search.

Arguments:
  [task_id]    ID of the task to pair on (optional — detected from branch)

Options:
  --unlock               Recover a crashed session: stop the in-container agent
                         if one is still running, clear the lock, restore status
  --no-summary           Skip AI summarization of the pairing session
  --resume <session_id>  Resume a previous session (branchless mode only)
  --autonomous           Run the agent without permission prompts. In the task's container
                         this is the same posture as a supervised turn and needs no
                         confirmation; with --host it runs unconfined as you, and is
                         confirmed separately.
  --yes                  Auto-confirm prompts (required with --autonomous --host in
                         non-TTY mode)
  --no-task              With --host: skip task detection and pair in the current
                         directory with no task context, on any branch (including a
                         lazy/* branch this store has no task for)
  --override-usage-pause Start this pairing session even when its credential is paused.
  --host                 Run the agent on your machine instead of in the task's container.
                         Required for branchless mode; on a task it is an explicit
                         claude-code-only opt-in. Never a silent fallback.

Examples:
  lazy pair abc123                   # Pair in that task's container
  lazy pair abc123 --unlock          # Clear a stale pairing lock
  lazy pair                          # Detect task from branch and pair in its container
  lazy pair --no-summary             # Pair without AI summary
  lazy pair --host --no-task         # Pair here on the host, ignoring any task for this branch
  lazy pair --host --resume abc123   # Resume a previous branchless session, on the host
  lazy pair abc123 --autonomous      # Run without permission prompts, in the container
```
