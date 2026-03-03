# Changelog

## [0.6.678] - 2026-03-03

### Added

- **PostgreSQL storage driver** — team/shared use with connection pooling, migrations, and comprehensive test coverage. Configure with `[storage] driver = "postgres"` and `connection_string` in lazy.toml
- **worktree.include config** — copy untracked files into new task worktrees. Use glob patterns to include build artifacts, credentials, or other files agents need to test their work or user needs if testing manually through `lazy shell`
- **docker_agent_root and docker_agent_no_network runner options** — advanced Docker container configuration for running agents as root or without network access
- **Markdown formatting in lazy start** — prettier prompt display in TTY confirmation with proper code blocks and emphasis

### Fixed

- **Turn-level diffs showing upstream changes** — now correctly shows only task's own changes instead of including parent branch commits
- **fastForwardLocal false divergence** — no longer reports divergence on checked-out branch paths
- **Doctor orphaned containers** — improved detection and reporting of stale agent containers
- **Doctor auth check missing API key** — better error messages when Anthropic API key is not configured

### Changed

- **Clone command moved to Task Management section** — better help text organization, grouping task creation/modification commands together

## [0.5.645] - 2026-02-28 - First Public Alpha

## [0.5.658] - 2026-03-01

### Added

- **LAZY_CONFIG env var** — override config filename (e.g., `LAZY_CONFIG=lazy.lima.toml lazy list`). This allows for
per-environment config files (e.g. one for VM, one for docker)
- **Runner-aware doctor** — `lazy doctor` checks are now runner-specific via `runner.diagnose()` instead of hardcoded
Docker checks
- **Stop hook for tsc** — `.claude/hooks/check-build.sh` blocks agents from finishing with type errors

### Fixed

- Host-process runner uses `process.execPath` instead of `process.argv[0]` (compiled Bun binaries returned "bun" instead
  of actual path)
- `lazy init` .gitignore now covers all runtime artifacts (`.reconcile-lock`, `storage.lock`, `tasks/*/protocol/`) and
removes obsolete entries
- Dirty worktree checks exclude `.lazy-task-sandbox/` to prevent false positives
- Host-process runner strips `CLAUDECODE` env var to prevent "nested session" errors
- Runner config moved from top-level `runner = "docker"` to `[runner] type = "docker"` section (backward compat
preserved with deprecation warning)
- Fixed `fastForwardLocal` reporting divergence on clean state
- Doctor no longer reports `git_remote`, `github_auto_push`, `gitlab_auto_push` as unknown config keys

### Changed

- Doctor delegates to runner `diagnose()` interface instead of hardcoded check functions

## [0.5.659] - 2026-03-01

### Added

- This CHANGELOG.md