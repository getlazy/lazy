# Changelog

## [0.11.942] - 2026-04-06 - The Daemon Release

Lazy v0.11 turns the daemon into the central nervous system of the system — CLI and MCP all connect through it, and tasks advance themselves in response to real-world signals.

### Daemon as central nervous system

- **Event-driven task graph** — The daemon detects state changes during reconcile and acts on them by routing through the task graph: when a parent branch advances, the daemon notifies children and siblings. Notifications are delivered by writing an unblock command into the target task's protocol directory and launching (or reusing) the supervisor — the same path `lazy unblock` uses. Auto-react triggers (CI failures, PR comments) feed into the same delivery path
- **Auto-push task branches** — Task branches are automatically pushed to the remote after state changes (turn completion, acceptance, upstream merge). No manual `git push` needed. Pushes are serialized, retry on transient failures, and respect the configured remote driver. Enabled by default when a remote is configured
- **Per-project daemon** — Each project now gets its own daemon process with an isolated unix socket, PID file, and log. Socket paths are derived from the project root (`~/.lazy/daemon/<dir>-<hash>/lazy.sock`), so projects with different configs (API keys, remotes) no longer collide. `lazy daemon start/stop/status` operate on the current project's daemon and error clearly when run outside a lazy project
- **MCP proxy for containerized agents** — The daemon serves as the MCP endpoint for agents running in Docker containers. Agents access lazy tools (storage, git, task management) through the daemon over HTTP, replacing the old per-session builder server. Task-scoped tool execution ensures agents can only access their own worktree
- **CLI as thin RPC layer** — CLI commands are now thin wrappers over daemon RPC calls. `lazy start`, `lazy unblock`, `lazy upgrade`, and other lifecycle commands route through the daemon instead of launching supervisors directly or competing for file locks. Eliminates duplicate orchestration logic and the old server sync loop

### Auto-react and event delivery

- **Auto-react to CI failures** — When CI fails on a task branch, the daemon detects the failure during sync, extracts job name, failure reason, and logs, then auto-unblocks the task with structured error context so the agent can fix it. Duplicate failures (same CI signature) are not re-triggered
- **Auto-react to PR comments** — When a human comments on a task's pull request, the daemon auto-unblocks the task with the comment content. Comments on blocked tasks are auto-delivered as daemon events, giving the agent another turn without manual relay. Comment deduplication prevents re-triggering on already-seen comments
- **Auto-delivery of task tree events** — Events cascade through the task graph: when a child task completes, its parent is notified; when a parent accepts a child, sibling tasks auto-sync with upstream. `upstream.updated` events trigger `--sync-with-upstream` merges. Working tasks receive events via SSE; blocked tasks are auto-unblocked with context
- **Circuit breakers and budget controls** — Auto-triggered turns are governed by per-task turn budgets (default 3 auto-turns per trigger type), exponential backoff between retries, and a project-wide daily budget (`auto_react_daily_budget`, default 50). When limits are hit, the task pauses for human intervention. Counters reset only on manual unblock — never automatically. Defense-in-depth budget checks prevent runaway auto-triggers even if outer guards fail

### Developer experience

- **Ollama support** — Run lazy agents against local models served by host Ollama from inside Docker containers. Enables fully offline agent runs without burning Anthropic API credits.
- **`lazy pair --autonomous`** — New flag lets pair sessions run autonomously like the builder, with `--yes` guard for safety. Useful for fire-and-forget tasks where you want pair-mode context but don't need to watch
- **`lazy pair --resume`** — Resume a previous pair session in branchless mode, preserving conversation context across sessions
- **`lazy logs`** — New command to view daemon and supervisor logs. Task IDs are included in daemon logs and ISO8601 timestamps in supervisor logs for easier debugging
- **Default watchdog timeout** — Agent watchdog timeout now defaults to 2 hours (7,200,000ms) instead of being disabled. Prevents runaway agents from consuming resources indefinitely. Override with `[agent] watchdog_output_timeout_ms` in `lazy.toml`
- **`lazy submit`** — New command to explicitly create a PR/MR for a task branch. Introduces a `submitted` task state between `blocked` and the merge path. Agents can call `lazy_submit` via MCP to push their branch and open a PR when they believe the work is ready for review
- **Turn visibility** — Agent turns are now visible in task detail views, making it easier to track how many auto-turns a task has consumed

### Pre-merge gates

- **Accept checks CI and review gates** — `lazy accept` now verifies CI status, required reviews, and unresolved PR comments before merging. If any gate fails, accept is hard-blocked with a link to the PR showing what needs attention. No `--force` bypass — gates must be satisfied. Implemented via `checkAcceptGates()` on the driver interface, so each remote driver (GitHub, GitLab) checks its own platform's gate semantics
- **Protected branch accept controls** — `lazy accept` on protected branches (main, master, etc.) is refused by default. Enable with `auto_approve` config or when the PR already has an external approval. Prevents accidental merges to protected branches without review

### Fixed

- **Daemon resilience** — Skip missing-branch pushes instead of crashing, unified liveness checks, and robust crash recovery. `checkDocker` no longer calls `process.exit(1)` during signal delivery, which was killing the daemon
- **Auto-react spin loop** — Auto-react used subprocess-based unblock which re-triggered the event loop. Now uses in-process unblock. Budget counters no longer reset during reconcile — only on human unblock
- **Submitted tasks stuck in `submitted`** — Tasks in `submitted` status were not transitioning to `complete` when the MR was merged on the remote
- **Spawn timeout killed long-running processes** — The spawn utility had a default 60-second timeout that killed supervisors, Claude Code, the builder, and watchdog processes. Long-running processes now run without a timeout
- **MCP tools broken in containers** — `requireDaemonStorage()` failed when called inside the daemon process itself. MCP tools now fail fast when the daemon is unavailable instead of falling back to direct storage (which caused lock contention)
- **MCP tools not available to agents** — Agents in containers could not access `lazy_search`, `lazy_show`, and other lazy MCP tools due to missing MCP config. `handleSyncCommand` now writes `.claude.json` correctly
- **Reconciler stall** — Daemon reconciler did not detect finished tasks, leaving them stuck in `working` status after the agent completed
- **Misleading "Daemon RPC failed" error** — Application-level errors from daemon RPC were wrapped in a generic "Daemon RPC failed" message that suggested restarting the daemon. Application errors now surface directly
- **Sync used wrong branch check** — `remote-sync.ts` used `branchExists` (which checks remote) instead of `localBranchExists`, causing unnecessary push retries for remote-only branches
- **Daemon sync missed main branch updates** — The daemon sync loop was not fetching changes to the main branch, causing stale upstream state
- **`atomicWriteTask` race condition** — Concurrent async operations on the same task directory caused intermittent write failures. Also fixed stale `.tmp` directories from interrupted writes
- **Diff/accept/resume with missing worktree** — When a worktree was gone but the branch existed on the remote, diff, accept, and resume operations crashed. Now recovers from remote branch state
- **False divergence in accept** — Accept incorrectly blocked when local main was ahead of origin/main, treating it as divergence
- **MR/PR titles exceeding limits** — Titles are now truncated to 128 characters to avoid GitLab's 255-character limit
- **Review TUI missing branch data** — Review command crashed when fetching branches for backlog subtasks that have no branch. Added remote branch recovery to `loadReviewData`
- **Orphaned processes in containers** — Container wrapper script now kills orphaned processes between turns
- **Invalid `rejected` status in auto-deliver** — Fixed TypeScript errors where auto-deliver compared task status against non-existent `"rejected"` value; the correct terminal status is `"abandoned"`

### Changed

- **Async IO throughout** — Converted all unjustified synchronous IO to async across the entire codebase, including all `spawnSync` calls in GitHub and GitLab drivers. The daemon event loop is no longer blocked by driver operations
- **Daemon logging** — All signals, decisions, and RPC calls are logged with safe rotation. Task codes appear in syncComments logs for easier correlation

### Configuration reference

New `lazy.toml` options in this release:

```toml
[server]
port = 26024                          # Web dashboard port

[agent]
watchdog_output_timeout_ms = 7200000 # Default: 2 hours

[daemon]
auto_react_ci = true                 # React to CI failures
auto_react_comments = true           # React to PR comments
auto_react_max_retries = 3           # Per-task retry limit per trigger type
auto_react_backoff = "exponential"   # Backoff: none, linear, exponential
auto_react_daily_budget = 50         # Project-wide daily auto-turn limit
auto_approve = false                 # Allow accept on protected branches
```

## [0.10.827] - 2026-03-28 - Storage proxy, branch protection, and reliability hardening

### Added

- **`lazy pair` without a task argument** — running `lazy pair` on a task branch auto-detects the task from the current git branch name. On non-task branches (e.g., `main`), it launches Claude Code in the current directory with no task context. Conversations are still captured and searchable via `lazy search`
- **GitHub/GitLab branch protection checks before merge** — `lazy accept` now verifies CI checks have passed and required reviews are approved before attempting to merge a PR. Previously, repo admins could inadvertently bypass branch protection rules because GitHub allows admin merge by default
- **Conflict task unblock safety** — `lazy unblock` on a `conflict` task now warns when no `--approved-files` flag is provided, instead of silently reverting all violated files. CLI prompts for confirmation; MCP returns an error listing the violated files so the caller can make an explicit choice

### Fixed

- **RemoteStorage proxy for daemon-as-single-writer** — CLI commands now proxy all storage calls through the daemon via unix socket RPC instead of competing for file locks directly. Eliminates lock contention that caused ~7.5s timeouts when the daemon's reconcile loop and CLI commands fought over `.storage-lock`. Falls back to direct storage when the daemon isn't running
- **`lazy start` used wrong base branch in worktree setups** — `start` determined the parent branch from the main repo's current checkout, which is arbitrary when `main` lives in a worktree. Now resolves the base branch from the remote's default branch, which is always correct regardless of local checkout state
- **Accept/merge silently swallowed remote failures** — `tryFastForwardInWorktree` returned `success: true` with a warning when merges actually failed, causing branch divergence that surfaced later as confusing push rejections. Remote operations now fail hard after 3 retries with progressive backoff, and parent branch commits are pushed before remote merges to prevent divergence
- **Phantom "HEAD" branch created by `lazy sync`** — sync and fast-forward operations could create or target a literal "HEAD" branch instead of resolving it to the actual default branch. Added HEAD guards in both GitHub and GitLab drivers, and HEAD resolution in GitLab's `targetBranch()`
- **`lazy_accept` passed "HEAD" as base ref for GitHub PRs** — the accept flow resolved the target branch to the literal string "HEAD" instead of the actual branch name (e.g., `main`), causing PR creation to fail with "Base ref must be a branch"
- **Lock file failures with missing parent directory** — both storage-lock and worktree-lock silently failed when the parent directory didn't exist, causing mysterious "can't get lock" errors after 50 retries. Now throws a clear error message identifying the missing directory
- **`lazy_diff` returned ANSI color codes in JSON** — git diff output included terminal escape codes that wasted LLM tokens and bloated JSON responses. Now passes `--no-color` to all git diff invocations in MCP tool responses
- **`lazy pair` failed with host-process runner** — session bridging assumed a Docker sandbox directory existed. With the host-process runner, Claude Code writes session files directly to `~/.claude/projects/`, so no bridging is needed. Now detects this case and skips bridging

### Changed

- **Removed inline task creation from `lazy start`** — the `--goal`, `--prompt`, and `--code` flags were removed from `lazy start`. Use `lazy create` followed by `lazy start` instead. This simplifies the start command and avoids duplicating creation logic

## [0.10.788] - 2026-03-17 - Minor fixes

### Fixed

- **`lazy sync` invalid status transition** — syncing externally-merged blocked/conflict tasks tried `blocked → complete` which violates the state machine. Now transitions through `merging` first
- **Builder close-and-recreate loop** — builder prompt now discourages closing and recreating tasks on transient failures (e.g., Docker misconfiguration). Added guidance to prefer `lazy_resume` over `lazy_close` + `lazy_create` when infrastructure issues are resolved
- **Duplicate task code resolution** — `resolveTask` failed with "Task not found" when multiple tasks shared the same code. Now disambiguates by preferring non-terminal tasks over terminal ones, and most recently updated when all are terminal
- **`lazy_active` MCP tool mismatch** — MCP tool only returned `working` tasks while CLI `lazy active` showed all non-terminal tasks with sessions. MCP now uses `{ withSessionsOnly: true, nonTerminalOnly: true }` to match CLI behavior
- **GitHub PR creation diagnostics** — added `--repo` flag to all `gh` CLI calls for explicit repository targeting, debug logging of exact `gh` command arguments, and guards against empty `targetBranch` values (the `??` operator doesn't catch empty strings `""`)
- **False conflict on files created by the task itself** — agent-created files matching protected patterns were flagged as permission violations when modified in later turns. Now uses merge-base to distinguish pre-existing files from task-created ones
- **`lazy_create` MCP guard missed blocked tasks** — parentless-task guard only checked `working` tasks, missing `blocked` ones. Also escalates to stern confirmation when active tasks have children, naming the parent tasks explicitly
- **`lazy pair` broken with host-process runner** — session bridging failed because the sandbox directory doesn't exist for host-process tasks. Now creates the sandbox directory before attempting to bridge
- **`lazy_accept` passed HEAD as base ref for GitHub PRs** — when creating a PR via the GitHub driver, the base ref was passed as the literal string "HEAD" instead of resolving to the actual branch name. Now resolves HEAD to the current branch before passing to the API

## [0.10.763] - 2026-03-13 - Confirmation protocol and soft push-bach on file violations

### Added

- **Confirmation protocol for destructive MCP operations** — MCP tools that are destructive or hard to reverse now require a two-step confirmation: first call returns contextual guidance and a confirmation code, second call with the code executes the operation. Applies to `lazy_reject` (always stern), `lazy_accept` (scales with diff size), `lazy_close` (scales with work invested), `lazy_redo` (scales with history), and conditionally to `lazy_reopen` and `lazy_create`
- **Confirmation level scaling** — confirmation intensity scales with operational risk: `lazy_accept` requires stern confirmation for diffs >2000 lines or >30 files, standard for >500 lines or >10 files, light otherwise. `lazy_close` is stern if task has commits (work abandoned), standard normally, light if task is empty. Similar scaling for other operations based on context and risk
- **Confirmation guidance templates** — each confirmation level provides tailored guidance (e.g., `lazy_reject` warns about work being discarded and suggests `lazy_unblock` feedback as an alternative). Guidance is generated from template files in `src/prompts/confirmations/`
- **MCP confirmation codes** — confirmation codes are short-lived (`<verb-prefix>-<4-hex>`), scoped to (operation, task_id), single-use, and valid for 5 minutes. Code format makes codes non-interchangeable between operations
- **Updated MCP tool signatures** — `lazy_reject`, `lazy_accept`, `lazy_close`, `lazy_redo`, and `lazy_reopen` now accept an optional `confirmation_code` parameter (string) to complete two-step confirmations. Calling without the code returns guidance; calling with it executes
- **Permission violation self-correction (soft push-back)** — when an agent makes a file permission violation, supervisor now gives the agent one chance to self-correct before marking the task as `conflict`. On the first violation, the supervisor injects the violation context into the agent's next prompt without blocking, allowing the agent to fix it. Only after a second violation does the task move to `conflict` status
- **Confirmation handling in builders** — builder agents now understand the confirmation protocol and handle `confirm_required` responses by extracting guidance and codes, deciding whether to proceed, and calling with confirmation code if needed
- **Post-turn check command** — `[checks] post_turn` configuration option allows running a custom command (e.g., `bun test --bail`) after each agent turn. Output is captured and attached to the turn data for reviewers to see. No push-back or gating — purely instrumentation for data collection. Configure with timeout support via `post_turn_timeout_ms`
- **File permission violations in review TUI** — the `lazy unblock` review editor now prominently displays file permission violations from the latest agent turn, showing which files were flagged and their status (pending, approved, rejected)
- **CI failure fetching from GitHub/GitLab** — `lazy sync` now fetches CI check results from the remote driver and adds failures as comments on corresponding tasks. Includes job name, failure reason/logs, and links to the CI run. Works for both GitHub (check runs/status checks API) and GitLab (pipeline/job API)
- **Accept dirty worktree flag** — `lazy reject --accept-dirty-worktree` and `lazy close --accept-dirty-worktree` allow these commands to proceed even when the task worktree has uncommitted changes, since these commands discard the work anyway
- **Pairing lock file visible as untracked** — moved pairing lock from `<worktree>/.lazy-pairing` to `<worktree>/.lazy-task-sandbox/pairing-lock` so it's covered by `.gitignore`

### Fixed

- **Docker containers could write outside worktree** — agent containers mounted the repo root read-write, allowing agents to modify files outside their worktree. Repo root is now mounted `:ro` with the worktree and `.git` directory mounted read-write on top
- **Reject/close of working tasks threw error but silently succeeded** — rejecting or closing a task in `working` status failed on the state transition (`working → abandoned` is invalid) but the task was silently fixed by self-healing. Now properly stops the runner and transitions through `interrupted` first
- **Zombie sweep and self-healing touched working tasks** — both mechanisms now skip tasks in `working` status to avoid interfering with active agent runs
- **GitHub code scanning alerts** — resolved false positives in code scanning
- **Missing worktree directory handling** — gracefully handle cases where worktree directory is missing for completed tasks instead of crashing
- **Empty squash merge not detected** — `lazy accept` with squash merge could produce an empty commit when the target branch already contained the changes. Now detects this and shows an actionable error
- **PR comments being echoed back** — fixed issue where imported comments were re-exported to PR, causing duplication
- **lazy_start MCP tool missing parameters** — fixed MCP tool to properly accept goal, code, prompt, and type parameters for create-and-start operations
- **grep -P usage in release.sh** — fixed macOS compatibility in the release script
- **TOML config generation commented out section headers** — `lazy init` generated `lazy.toml` with commented-out section headers (e.g., `# [checks]`), causing keys like `post_turn` to silently land under the wrong TOML section. Section headers are now always emitted uncommented; only individual keys within sections are commented out

### Changed

- **Toolchain build scripts** — extracted toolchain builds into standalone script for better modularity and reusability
- **Activity monitor shows permission and check phases** — added `permission_pushback`, `permission_pushback_done`, `post_turn_check`, and `post_turn_check_done` phases to the activity monitor display
- **Debug logging in supervisor and permission checks** — added structured logging for command fields, SHAs, violation detection, and post-turn check execution to aid debugging
- **Duplicate task codes accepted** — `lazy create` now rejects task codes that collide with active (non-terminal) tasks, preventing confusing ambiguity

## [0.9.751] - 2026-03-11 - File permissions and violation detection

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

## [0.8.736] - 2026-03-08 - Daemon and multi-agent support

### Added

- **Daemon infrastructure** — `lazy daemon start|stop|restart|status` commands with unix socket server, PID file management, bearer token auth, and auto-start mechanism. Daemon is required and automatically starts when running CLI commands
- **Agent selection in MCP tools and CLI** — `lazy_create`, `lazy_start`, `lazy_unblock`, and `lazy_edit` MCP tools now accept an `agent` parameter. CLI `lazy edit --agent` and `lazy unblock --agent` allow switching agents per-task. Builder prompt documents agent selection guidance
- **Builder `--resume` support** — `lazy builder --resume` restores previous builder conversation, preserving context across sessions
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
- **docker_agent_root runner option** — advanced Docker container configuration for running agents as root
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