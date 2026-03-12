# Changelog

## [0.9.751] - 2026-03-11

### Added

- **File permission violation detection** — supervisor now detects and reports file permission violations during post-turn phase
- **Violation revert on unblock** — when a `conflict` task is unblocked, rejected files are automatically reverted to their pre-violation state. `--approve-file` flag (CLI) and `approved_files` parameter (MCP) allow selective approval; default is all rejected (safe default)
- **Direct accept for conflict tasks** — `lazy accept --approve-file` allows accepting conflict tasks without an extra unblock round-trip. All pending violations must be covered; partial approval is rejected
- **Re-parent on accept** — when a parent task is accepted, unfinished child tasks are automatically re-parented to the grandparent, preventing orphaned tasks after branch merge
- **Daemon reconcile loop** — daemon server now tracks active projects via RPC headers and reconciles state every 5 seconds, with grace period evaluation at call time for better testability
- **`conflict` task status** — tasks with file permission violations now transition to `conflict` instead of `blocked`, making violations visible at a glance in `lazy blocked`, `lazy list`, and the web dashboard. `lazy unblock` and `lazy pair` work on conflict tasks the same as blocked tasks
- **`[permissions]` section in `lazy.toml.example`** — documented the `permissions.protected` configuration for glob patterns that agents are not allowed to modify

### Fixed

- **Task commands ignored worktree config** — `start`, `unblock`, `resume`, and `upgrade` loaded `lazy.toml` from the project root instead of the task's worktree, silently ignoring branch-specific settings. All command-building paths now load config from the worktree.
- **Review subtask diffs** — `lazy review` TUI now correctly shows per-subtask diff branches in the task tree instead of missing diff context
- **Daemon project routing** — daemon is now project-aware and routes all commands based on repository root, fixing cross-project command execution issues
- **Docker container sudo** — added missing sudo package to all Docker containers and enabled agents to install additional tooling when needed

### Changed

- **Runner-specific agent instructions** — agent system prompts now include runner-specific guidance (passwordless sudo + tool installation instructions for Docker runners)
- **Docker containers run as non-root user with sudo** — containers create a `user` account with passwordless sudo, allowing tool installs via `sudo apt-get`
- **Parent branch protection** — parent branches are now guarded against remote push operations while child tasks are active, preventing accidental upstream modifications
- **Implicit AND in search queries** — multi-word queries like `task manager` or `in:turns merge conflict` now work without explicit `AND` operators, matching standard Lucene behavior

## [0.8.736] - 2026-03-08

### Added

- **Agent selection in MCP tools and CLI** — `lazy_create`, `lazy_start`, `lazy_unblock`, and `lazy_edit` MCP tools now accept an `agent` parameter. CLI `lazy edit --agent` and `lazy unblock --agent` allow switching agents per-task. Builder prompt documents agent selection guidance
- **Builder `--resume` support** — `lazy builder --resume` restores previous builder conversation, preserving context across sessions
- **Daemon infrastructure** — `lazy daemon start|stop|restart|status` commands with unix socket server, PID file management, bearer token auth, and auto-start mechanism. Daemon automatically starts when running CLI commands unless `LAZY_NO_DAEMON=1` is set
- **CLI pass-through mode** — read-only commands (`list`, `show`, `search`, `blocked`, `active`, `diff`) route through daemon for improved performance with transparent fallback to direct execution when daemon is unavailable
- **Dots in task codes** — task codes can now contain dots (e.g., `fix-accept.v2`) for better versioning and naming flexibility
- **Auto-restart daemon on upgrade** — `lazy upgrade` automatically restarts the daemon after successful upgrade to ensure latest version is running
- **Pre-flight sync validation** — `lazy accept` now validates that local branch is in sync with the configured remote before attempting irreversible remote merges, preventing half-accepted states where the remote merge succeeds but local fast-forward fails

### Fixed

- **Task code collisions** — redo/clone operations now scan existing tasks to deduplicate generated codes, preventing accidental overwrites
- **lazy diff upstream changes** — child tasks no longer show parent branch changes in diffs; now uses merge-base to show only task-specific commits
- **Remote sync without MR/PR** — `runSyncWithRemote` now fetches and merges remote branch even when no merge request exists
- **Builder unknown flags** — builder command now rejects unknown flags instead of silently passing them through, catching configuration errors earlier
- **Branch divergence visibility** — warnings about local/remote branch divergence are now displayed prominently during unblock/sync operations instead of being buried in logs
- **Spawn error diagnosis** — improved ENOENT error messages that distinguish between missing binary vs invalid stdio paths
- **Merge prompt E2BIG errors** — removed unbounded upstream context injection that exceeded OS argument limits on long-lived branches; agents now query git directly. Also hardened merge-and-fix error handling to prevent tasks from continuing on stale branches after merge failures
- **MCP unknown parameter validation** — MCP tools now reject unknown parameters with clear error messages and fuzzy "did you mean?" suggestions via Levenshtein distance matching. Validation applies to all tools through the common dispatch path
- **Auto-resume worktree safety** — auto-resume now checks worktree cleanliness before merging upstream. Clean worktrees get an upstream merge with instructions to verify assumptions; dirty worktrees (crashed mid-edit) skip the merge and get context about uncommitted changes to review first
- **Git ENOENT errors from MCP tools** — Centralized all 75 `spawnSync(['git', ...])` calls through a single `runGit()` function in `src/utils/git.ts` with cwd existence checks and proper error handling. MCP diff handler now falls back to main repo when task worktree is gone instead of crashing with misleading "posix_spawn 'git'" ENOENT errors

### Changed

- **Storage backends retired** — removed deprecated `in-repo` and `orphan-branch` storage backends; only `external` (default) and `postgres` remain. External storage uses FileStorage at a configurable path outside the working tree
- **Builder prompt refinement** — Added rule preventing builders from pre-researching codebase details that agents can discover themselves, reducing wasted human wait time

## [0.7.717] - 2026-03-07 - Native Installer & External Storage

### Changed

- **Native Claude Code installer** — All 16 toolchain Dockerfiles and the root Dockerfile now use Claude Code's native installer (`curl -fsSL
https://claude.ai/install.sh | bash`) instead of npm/bun global install. Toolchains that only had Node.js for Claude Code (base, rust, go, cpp, python, deno, etc.) no
longer install Node.js at all, resulting in smaller images and faster builds

### Fixed

- **Builder container HOME warning** — Builder containers no longer override `HOME` to the host path, eliminating the "installMethod is native, but directory does not
exist" warning from Claude Code. Mounts `.claude` to the container user's home (`/home/user`) instead, matching how agent containers work

## [0.7.707] - 2026-03-07 - Agent Abstraction & Watchdog

### Fixed

- **README image broke** - now it's fixed.

## [0.7.702] - 2026-03-07 - Agent Abstraction & Watchdog

Internal refactor to support multiple AI agents. The agent abstraction layer decouples the supervisor from Claude Code-specific details, enabling future support for additional agents.

### Added

- **Multi-agent abstraction** — Agent and AgentPackaging interfaces abstract away agent-specific implementation details. Supervisor resolves the agent from task metadata instead of hardcoding Claude Code. Centralized registry at `src/agent/registry.ts` for agent discovery and instantiation
- **Universal model monikers** — `apprentice`, `journeyman`, `master` provide portable model selection. The `--model` flag accepts these monikers (e.g., `lazy create --model apprentice`) in addition to agent-specific IDs like `sonnet` or `haiku`. Each agent maps monikers to appropriate models
- **Supervisor watchdog timer** — Automatically detects and kills hung agent processes that stop producing output. Configure timeout with `agent.watchdog_output_timeout_ms` in `lazy.toml` (0 = use agent default). Kill sequence: SIGTERM → 5s grace period → SIGKILL if needed
- **Agent configuration** — Set default agent with `agent.agent_id` in `lazy.toml` (defaults to `"claude-code"`). Override per-task with `--agent <agent_id>` flag on `lazy create` and `lazy start`. Agent selection validated against registry at config load time and task creation
- **Per-task agent tracking** — Tasks store `agent_id` in metadata, enabling mixed-agent workflows. Stored in all three storage backends (file, orphan-branch, postgres). Existing tasks without the field default to `"claude-code"` for backward compatibility

### Changed

- **Agent abstraction** — Supervisor resolves agent from task's `agent_id` field instead of hardcoding Claude Code. Enables seamless switching between agents per-task
- **Internal renames** — `claude_session_id` → `agent_session_id`, `ClaudeResponse` → `AgentResponse` throughout codebase. Backward compatibility maintained in FileStorage for reading old tasks
- **Default model is now `journeyman`** — Previously hardcoded to `sonnet`. Now uses universal moniker which maps to Claude Sonnet 4.5 for Claude Code, appropriate equivalents for other agents
- **Task display** — `lazy show` now displays the agent_id for each task
- **Runner validation** — Agents that require host-process runner are validated at startup. Clear error message shown if an incompatible runner is configured

### Fixed

- **Incorrect LAZY_CONFIG silently converted to default config** - now errors if `LAZY_CONFIG` is pointing to a file that does not exist on the current repository.

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