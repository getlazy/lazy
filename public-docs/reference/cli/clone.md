# lazy clone

This page is generated from `lazy clone --help`.

```text
Usage: lazy clone <task_id> [--parent <task_id> | --default-parent] [--code <code>] [--model <model>]
                  [--agent <profile>] [--same-base | --base <sha>]
       lazy clone https://<install>/git/<team>/<project>.git [dir]

The second form clones a project hosted on a Lazy Teams install and binds the
clone to it in one step, logging this machine in first if it is not already
(see lazy login --help; --device and --device-name work as they do there).
It is chosen by shape: the first argument is a full clone URL, the address on a
Teams project page. Use the address your install is served on: lazy uses the
scheme you type (http:// or https://) exactly, as git does, and never switches it.

Duplicate a task with the same goal, prompt, model, and type. Creates a fresh task
in the backlog with no session history. By default, inherits the source task's parent.

Arguments:
  <task_id>          ID of the task to clone

Options:
  --parent <task_id> Set a new parent for the cloned task
  --default-parent   Use default parent (null, root task) instead of inheriting from source
                     (conflicts with --parent)
  --code <code>      Set a custom code for the cloned task (default: auto-generated)
  --model <model>    Override model for the cloned task (e.g. opus, sonnet, claude-opus-5-5)
                     Default: inherit from source task — or, with --agent naming a
                     different agent, that agent's default model
  --agent <profile>  Run the clone on another agent profile (e.g. cursor)
                     Default: inherit from source task
  --same-base        Branch from the exact commit the source task started from
                     (not the parent's current head) and PIN the clone there, so a
                     re-run on another agent or model sees the same code. Works on
                     finished tasks. Nothing merges the parent in automatically;
                     an explicit "lazy sync" lifts the pin.
  --base <sha>       Like --same-base, but pinned to a commit you name

What gets carried over:
  - Goal (always)
  - Prompt (latest version)
  - Agent and model (unless --agent / --model override; both stay on the clone.
    --agent alone switches to the new agent's default model, never the source's)
  - Task type (task, fix, spike, etc.)
  - Code (auto-suffixed with -clone-N, or explicit via --code)

What starts fresh:
  - No session, no turns, no commits
  - New git branch from parent's HEAD (or main if no parent) — or from the
    pinned commit with --same-base / --base
  - Status: backlog
  - Container image (root-resolved; warns if source had a per-task pin)
  - Metadata: cloned_from=<source_task_id> recorded

What does NOT carry over:
  - Session history, turns, comments
  - Container state

Examples:
  lazy clone abc123                           # Clone, inheriting source task's parent
  lazy clone abc123 --default-parent          # Clone as root task (no parent)
  lazy clone abc123 --parent def456           # Clone under a specific parent
  lazy clone abc123 --code my-new-code        # Clone with explicit code
  lazy clone abc123 --model opus                         # Clone with different model
  lazy clone fix-auth --parent main-task      # Reparent a task
  lazy clone abc123 --same-base --agent cursor --model gpt-5  # Like-for-like re-run

After cloning:
  lazy start <cloned_task_id>                 # Start working on the clone
```
