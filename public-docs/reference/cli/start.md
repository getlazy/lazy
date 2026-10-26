# lazy start

This page is generated from `lazy start --help`.

```text
Usage: lazy start <task_id> [--model <model>] [--agent <profile>] [--effort <level>] [--review <mode>] [--review-gate <g>] [--review-auto-fix <on|off>] [--runner <docker|container|podman>] [--env KEY=VALUE] [--env-file <path>] [--follow] [--yes] [--force-local] [--override-usage-pause] [--default-image]

Start an existing task. The daemon handles worktree creation, agent launch,
and lifecycle management.

This command does NOT create tasks. Creation parameters — goal, prompt, code,
type, parent — belong to 'lazy create', which leaves the task in the backlog
where 'lazy edit' can still correct them. Once an agent is running, none of them
can be changed. Use 'lazy create --code <code> ...' then 'lazy start <code>'.
See public-docs/surface-asymmetries.md (section 9) for why.

Use 'lazy blocked' to check when the agent finishes and needs your input.
Use 'lazy status <task_id>' to check the current state.

Arguments:
  <task_id>          ID of the task to start (short hex prefix or task code)

Options:
  --override-usage-pause  Let this task's next turn start even though its credential is past the
                       usage-pause threshold (used up by that one turn)
  --default-image    While the project's runner image is still building (or failed), run on
                     lazy's default runner image instead of being asked (--yes does too)
  --model <model>    Override model for this session (e.g. opus, sonnet, claude-opus-5-5)
  --agent <profile>  Agent profile to run this task with — an [agents.<name>] block in
                     lazy.toml; harness names (claude-code, codex, cursor, pi) are the
                     built-in profiles. Default: from the task or lazy.toml.
  --effort <level>   Override Claude Code reasoning effort (low, medium, high, xhigh, max)
                     Persists on the task so resumes use the same value, and it
                     is respected in low-high review mode: the draft runs at the
                     effort you set, not at [review] draft_effort. A project-wide
                     [agent] effort does not do that — only a choice about this
                     task.
  --review <mode>    How this task gets reviewed once it declares final:
                       low-high  (default) the writer self-reviews in its own
                                 session — a low-effort draft, a high-effort
                                 hostile self-review, one revise pass
                       separate  a reviewer runs afterwards in its own session
                                 and its verdict gates accept: 3-4x the
                                 wall-clock and tokens, for when it is worth it
                       off       no review at all
  --review-gate <g>  When a recorded review holds the merge: auto (default —
                     the mode decides, and a review you asked for with
                     'lazy review' always gates), always (any recorded review
                     gates, the low-high self-review included), or never.
  --review-auto-fix <on|off>
                     In 'separate' mode, whether a review that found something
                     starts a fix turn by itself. Default off: the task parks
                     with its findings and you decide whether a round is worth
                     it.
                     All three persist on the task and take effect next turn.
                     Omit any of them to inherit the parent task's value, or
                     the lazy.toml [review] default for a top-level task.
  --runner <type>    Run this task on a specific runner regardless of the global
                     [runner] type: docker, container, or podman.
                     Persists on the task; takes effect this turn.
  --env KEY=VALUE    Give this task an environment variable (repeatable). A bare
                     --env KEY prompts for the value without echoing it, which
                     keeps a secret out of shell history and the process table.
                     Values live on this host only — never in task state, turns,
                     prompts, or logs — and are deleted when the task ends.
                     Manage them later with 'lazy env'.
  --env-file <path>  Read KEY=VALUE lines for this task from a dotenv-style file
  --follow           Wait for the agent to finish, streaming output in real time
  --yes              Skip confirmation prompts
  --force-local      Start from local HEAD even if remote fetch fails (use with caution)

Model Selection:
  Models are selected in this priority order:
  1. --model flag (session override)
  2. Task's model setting (if set during task creation)
  3. The agent's own default, if it has one (Cursor: "auto" — Cursor picks; Codex: "gpt-6.1-sol")
  4. lazy.toml default model
  5. Built-in default (claude-sonnet-5-5)

Notes:
  - Each task can only have one session (1:1 relationship)
  - If the task already has a session, use 'lazy unblock' instead
  - Tasks automatically fetch the latest remote state before creating worktrees.
    If the remote fetch fails, 'lazy start' will abort unless --force-local is used.
  - In offline mode ('lazy system offline' or offline = "on"), the remote fetch is
    skipped automatically and the task branches from the local parent HEAD.
  - For child tasks, the worktree starts from the parent's branch HEAD (fetched from remote)
  - The human turn is recorded before the container launches, so it's
    crash-safe — if the process dies, the turn is preserved

Examples:
  lazy create --goal "Add auth" --prompt "..." --code add-auth
  lazy start add-auth                       # Start it by its code
  lazy start abc12345                       # ...or by short ID
  lazy start abc12345 --yes                 # Start without confirmation
  lazy start abc1 --model claude-haiku-4-5-20251001  # Start with model override
  lazy start abc1 --follow                  # Wait for completion
```
