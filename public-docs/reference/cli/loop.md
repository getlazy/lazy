# lazy loop

This page is generated from `lazy loop --help`.

```text
Usage: lazy loop [<task_id>...] [--backlog] [--parent <task>] [--tag <tag>]
                 [--pipeline] [--model <model>] [--follow]

Two modes, one review gate.

Reactive (no task IDs):
  Sequentially review all blocked tasks, oldest-waiting first. When none remain,
  shows active tasks and polls for new blocked ones every 3 seconds.

Queue (task IDs, or a --backlog/--parent/--tag selection):
  Drive exactly those tasks, in that order: start each one that hasn't run yet,
  wait for its turn, present the review gate, act on your decision, move on.
  Backlog-processing for a hub's pile of small tasks.

At each gate you choose: give feedback, review hunk-by-hunk (the same surface as
'lazy browse --interactive'), accept, reject, sync upstream, skip (leave the task
exactly as it is), or stop.
Feedback and sync return to the same task; accept, reject and skip move on.

The queue is not persisted. Stopping (or Ctrl+C) prints the command that resumes
the rest, and re-running is idempotent: finished tasks are skipped, started ones
are not restarted.

This command is YOU driving the loop, at a review gate, task by task. For a batch
an agent drives on its own, create a task of type 'cluster'
(lazy create --type cluster) and let its agent run its subtasks.

Options:
  --backlog         Select backlog tasks instead of naming them (confirmed interactively)
  --parent <task>   Restrict the selection to this task's direct children
  --tag <tag>       Restrict the selection to tasks carrying this tag
  --pipeline        Start the NEXT queued task while you review the current one
  --model <model>   Override model for feedback turns (e.g. opus, sonnet, claude-opus-5-5)
  --follow          Wait for agent after giving feedback

Examples:
  lazy loop                                  # Review all blocked tasks
  lazy loop fix-a fix-b fix-c                # Drive these three, in order
  lazy loop --backlog --parent v0-20         # Pick a hub's backlog, then drive it
  lazy loop --backlog --tag cleanup --pipeline
  lazy loop --model opus                     # Use opus for feedback turns
  lazy loop --follow                         # Wait for agent after giving feedback
```
