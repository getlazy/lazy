# Changelog

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