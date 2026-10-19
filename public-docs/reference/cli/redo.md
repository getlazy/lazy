# lazy redo

This page is generated from `lazy redo --help`.

```text
Usage: lazy redo <task_id> [--prompt <text>] [--model <model>] [--no-start] [--yes]

Close a stale task and restart the same work on a fresh branch.

This is useful when a task's branch has fallen too far behind its parent and
merging would be more expensive than redoing the work from scratch. The old
task's history is preserved (closed, not deleted) and the new task links back
to it.

The replacement keeps the old task's PARENT: redoing a task that sits under a
release hub creates the replacement under that same hub, not on main. Only the
base ref is fresh — the branch is cut from that parent's current HEAD when the
task starts. To move the work elsewhere, use --no-start and re-parent the
replacement (lazy reparent <new_task> --parent main) before starting it.

Arguments:
  <task_id>          ID of the task to redo

Options:
  --prompt <text>    Override the prompt for the new task (default: inherit old prompt)
  --model <model>    Override model for the new task (e.g. opus, sonnet, claude-opus-5-5)
  --no-start         Create the new task but don't start it (backlog)
  --yes              Skip confirmation prompt when starting

What gets carried over:
  - Goal (always)
  - Prompt (latest version, unless --prompt overrides)
  - Model (unless --model overrides)
  - Task code (if set, best-effort)
  - Parent task (the replacement is created under the same parent)
  - Context from previous attempt (agent summary + diff stat)

What starts fresh:
  - Git branch (cut from the parent's current HEAD at start time)
  - Session (new agent session)
  - Turn history (only injected as context, not replayed)
  - Container image (root-resolved; warns if the old task had a per-task pin)

Examples:
  lazy redo abc123                        # Redo task, start immediately
  lazy redo abc123 --no-start             # Redo but keep in backlog
  lazy redo abc123 --prompt "Updated requirements"  # Redo with new prompt
  lazy redo fix-auth --model opus                    # Redo with different model
```
