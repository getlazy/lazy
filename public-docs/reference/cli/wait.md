# lazy wait

This page is generated from `lazy wait --help`.

```text
Usage: lazy wait [<task_id>...] [--follow] [--next] [--json]

Block until a task transitions from 'working' to another status (blocked, complete, interrupted).

Modes:
  lazy wait <task_id>              Wait for a specific task
  lazy wait <id1> <id2> ...        Race several tasks: returns as soon as the FIRST
                                   one finishes, naming which task fired
  lazy wait --next                 Wait for any currently working task to finish

With --follow (single task only), streams the container's stdout/stderr in real-time.

Options:
  --follow     Stream container output in real-time while waiting (single task only)
  --next       Wait for any working task to finish (no task IDs needed)
  --json       Emit the winning task plus every waited-on task as JSON

Exit Codes:
  0            Task became blocked, conflict or submitted (awaiting review)
  1            Task completed, was interrupted, errored, or the wait timed out (600s cap)

Examples:
  lazy wait abc12345                    # Poll until task completes
  lazy wait abc1 --follow               # Stream output while waiting
  lazy wait abc1 def2 ghi3              # Return when the first of three finishes
  lazy wait abc1 def2 --json            # Machine-readable winner + still-pending set
  lazy wait --next                      # Wait for any working task
  lazy wait abc1 && lazy unblock abc1   # Chain commands: wait then review
```
