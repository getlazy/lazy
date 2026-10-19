# lazy doctor

This page is generated from `lazy doctor --help`.

```text
Usage: lazy doctor
       lazy doctor --clean-worktrees [--dry-run] [--yes]
       lazy doctor --clean-docker-images [--dry-run] [--yes]
       lazy doctor --clean-orphaned-containers [--dry-run] [--yes]
       lazy doctor --unset-upstream-tracking [--dry-run] [--yes]
       lazy doctor --resume-interrupted-tasks [--dry-run] [--yes]
       lazy doctor --clean-local-command-conversations [--delete-empty-local-command-conversations] [--dry-run] [--yes]
       lazy doctor --repair-git-pointers [--dry-run] [--yes]
       lazy doctor --reimport-conversations [--yes]
       lazy doctor --purge-housekeeping-conversations [--yes]
       lazy doctor --import-memory [--yes]
       lazy doctor --fix agents [--yes]
       lazy doctor <task-id> [--dry-run] [--yes] [--probe-agent]

Check the health of your lazy installation, or diagnose a specific task.

A plain 'lazy doctor' only REPORTS: every remedy below is a flag you choose to
run. Each lists what it would touch, asks before acting (--yes to skip the
prompt, --dry-run to list and stop), and prints one line per item. Run one
remedy at a time.

Remedies:
  --clean-worktrees          Remove the worktrees of finished (complete/abandoned) tasks,
                             reclaiming build output and dependency trees. Branches are kept
  --clean-docker-images      Remove stale lazy runner images. Never touches the image in use,
                             an adopted image, or an image pinned on a task
  --clean-orphaned-containers
                             Remove lazy containers whose task no longer references them
  --unset-upstream-tracking  Drop leftover upstream tracking from lazy task branches
  --resume-interrupted-tasks Start the next turn of interrupted tasks now, instead of waiting
                             for the daemon's reconciler to pick them up
  --clean-local-command-conversations
                             Drop Claude Code's local-command scaffolding (the caveat, a
                             built-in slash command and its output) out of conversations
                             stored before lazy filtered it at import, so each listing
                             summary becomes the first real thing that was said. Deletes
                             nothing: a row left with no content is listed and left alone
  --repair-git-pointers      Rewrite a task worktree's .git, commondir and gitdir pointer files
                             back to what lazy created, when something changed them. lazy
                             refuses to run git in such a worktree until they are repaired;
                             also moves aside (never deletes) nested repositories a task
                             planted in its worktree
  --delete-empty-local-command-conversations
                             Only with the flag above: also DELETE the stored conversations
                             that hold nothing but scaffolding. Never implied by --yes, asked
                             for separately, and permanent — a deleted row is not brought
                             back by --reimport-conversations

Options:
  --no-resume                Deprecated no-op — doctor never resumes tasks on its own
  --reimport-conversations   Recover builder conversations whose raw Claude logs are on
                             disk (shared ~/.claude/projects + per-builder isolation dirs)
                             but never reached the store; skips ones already imported
  --purge-housekeeping-conversations
                             Delete already-stored machine-generated lazy one-shots
                             (accept fidelity summaries, 'lazy report', memory
                             compaction, pairing summaries) from the conversation
                             store. Lists what it classified and deletes nothing
                             without --yes or an interactive confirmation. A ONE-TIME
                             cleanup: newer one-shots are marked at the source and
                             never reach the store
  --import-memory            Import Claude Code harness memory files (shared ~/.claude/projects
                             + per-builder isolation dirs) into lazy-owned shared memory;
                             skips records already present
  --fix agents               Rewrite lazy.toml from the removed role-backend config
                             ([models.roles.*] backend/model/endpoint, [ollama],
                             [proxy] openai_upstream) into [agents.<name>] profiles.
                             Shows the diff and asks first; --yes for scripts
  --dry-run                  List what a remedy would do and stop; in task mode, show task
                             issues without offering fixes
  --probe-agent              Task mode only: have the in-container doctor start a real
                             claude process to confirm the agent itself sees the lazy
                             tools. Off by default because it bills a model request
  --yes, -y                  Apply all fixes / skip the remedy, re-import, import-memory,
                             purge, or --fix confirmation prompt

Project-level checks (no task ID):
  - Git installed and functional
  - Repository has at least one commit
  - Docker installed and daemon running
  - Anthropic API key or OAuth token present in the DAEMON's environment
    (falls back to this shell's, saying so, when the daemon can't be asked)
  - Shell detected and completions installed
  - tmux installed (soft recommendation)
  - Data directory structure valid
  - Container image exists and up to date
  - No stale locks or orphaned containers
  - No split storage (when external storage is configured)
  - Recoverable builder conversations on disk but missing from the store
  - Stored conversations still listing Claude Code local-command scaffolding
  - Harness memory files on disk with no lazy shared-memory record
  - Injected memory context size vs [memory] warn_bytes (compact staleness + remedy)
  - Context budget: what every builder and task agent session starts with —
    CLAUDE.md and AGENTS.md files (and Claude Code's per-file size warning), lazy's system
    prompt, the shared memory index, the MCP tool schemas — with a total per role
  - Stale [protection].protected_tasks entries that gate nothing
  - Default-branch protection resolves to a real branch (not the "main" fallback)
  - [protection] gate keys configured while the master switch is off (inert)
  - Approval passphrase enrollment on this machine, and any leftover plaintext
    .lazy/approve-passphrase file from before it moved out of the repo
  - Tasks stranded in 'merging' by an accept that died
  - Interrupted tasks (resumable) and tasks whose run is gone — reported, never resumed
  - Worktrees still on disk for finished tasks, with the space they hold
  - Leftover upstream tracking on lazy task branches
  - Adequate disk space
  - Unknown or deprecated config options in lazy.toml
  - Remote driver health checks
  - Feature flags status and unknown flag warnings

Task-level checks (with task ID):
  - Stale parent (parent task is complete but child still points to it)
  - Missing local branch (session has a branch but it's gone locally)
  - Missing worktree (non-terminal task with no worktree directory)
  - Local/remote branch divergence
  - Status mismatch (task has work but status is still backlog)
  - Orphaned worktree (directory exists but not registered in git)
  - Agent MCP wiring, by running "lazy-agent doctor" inside the task's container and
    passing its output through (skipped, not failed, when there is no live container)

Exit code is 0 if all checks pass, 1 if any issues are found.

Documentation: https://docs.getlazy.dev/troubleshooting
```
