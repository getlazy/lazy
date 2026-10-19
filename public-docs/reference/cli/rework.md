# lazy rework

This page is generated from `lazy rework --help`.

```text
Usage: lazy rework <task_id> [--goal <goal>] [--prompt <text>] [--model <model>] [--code <code>] [--parent <task_id>]

Create a follow-up task to rework previously accepted work.

Use this when a task was accepted (squash-merged) but later needs changes —
a bug, a missed requirement, or feedback from production. Unlike reopen,
rework creates a new task that works on the current codebase where the
original changes are already present.

Arguments:
  <task_id>          ID or code of the accepted task to rework

Options:
  --goal <goal>      Override goal (default: "Rework: <original goal>")
  --prompt <text>    Rework instructions (what needs to change)
  --model <model>    Override model (default: inherit from original)
  --code <code>      Override task code (default: "rework-<original code>")
  --parent <task_id> Parent task for the rework (default: inherit from original)
                     Parent must exist and not be in a terminal state

Prompt input priority: --prompt flag > piped stdin > $EDITOR (interactive)

The new task:
  - Links to the original via metadata (rework_of)
  - Includes the original task's conversation history as context
  - Inherits the original task's parent (unless --parent overrides)
  - Is typed as 'rework'
  - Does NOT auto-start — run `lazy start` when ready

Examples:
  lazy rework fix-auth
  lazy rework fix-auth --goal "Fix token expiry edge case"
  lazy rework fix-auth --prompt "The refresh token logic doesn't handle expired sessions"
  lazy rework abc12345 --code rework-fix-auth --model opus
  lazy rework fix-auth --parent release-v2
  echo "Fix the race condition in auth" | lazy rework fix-auth
```
