# Changelog

## [0.16.1045] - 2026-05-28 - PR/MR fidelity and reparenting

### Added

- **Driver-side commit and PR/MR fidelity** — squash commit messages and PR/MR bodies are now regenerated from durable lazy storage (turns, comments, feedback, child summaries) via an abstracted `Summarizer` rather than reflecting only the task's initial goal and raw branch commit subjects. Fires on upstream-write events that matter (new commits, child accept). `lazy sync` is deliberately excluded — sync is high-frequency and the regeneration belongs at points where the artifact is actually consumed. The lazy-owned section in the PR/MR description is delimited so human edits outside it are preserved across regenerations
- **`lazy reparent <task> --parent <new-parent>` and `lazy_reparent` MCP tool** — repoint a task that was created on the wrong parent (e.g. branched from `main` when it should have been on a release branch) to a new parent, then merge that parent into the task's branch. Unlike a close-and-recreate approach, reparent **keeps the task** — same session, turns, commits, and branch — and only changes its parent pointer (and therefore its sync/accept/diff base). It reuses the existing `lazy sync` machinery, so the task's own agent rides along to resolve any merge conflicts in place. `<new-parent>` accepts a task code, short ID, or a raw branch name (e.g. `main`). Blocks while a task is `working` (don't pull the branch out from under a running agent), requires reopening terminal tasks first, detects no-ops, and leaves child tasks untouched (they stay based on this task's branch and pick up the new parent's changes on their next sync). Use `--yes` to skip the confirmation prompt for non-interactive/scripted use
- **Per-task status history in `lazy show` and `lazy_show`** — new `status-history` section surfaces every `<from> → <to>` transition with the actor (human/system/agent) and timestamp. Lets you audit system-actor flips (e.g. reconciler/zombie-sweep transitions) instead of seeing only the latest status

### Changed

- **Daemon refuses to start without a Claude credential** — `lazy daemon start` (and every command that auto-starts the daemon) now requires `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` in the environment, with an actionable error naming both variables when neither is set. The daemon is the single enforcement point — equivalent client-side checks were removed from `lazy pair`, the runners, and other entry points so they pass through and let the daemon's gate be authoritative. Closes the failure mode where a daemon started without credentials silently spawned task containers that couldn't function. Ollama-only setups (`[ollama].enabled = true` in `lazy.toml`) are exempt from the gate
- **`lazy system export-dockerfile`** — writes the embedded default Dockerfile to disk so projects can customize the container image used to run tasks. Safe-by-default: refuses to overwrite an existing file unless `--force` is passed. `--stdout` prints the Dockerfile to stdout instead of writing it (useful for diffing or piping). Prints a `lazy.toml` snippet for wiring the exported path into `[docker].dockerfile` but does NOT edit the config itself — the human owns that. (Briefly named `eject-dockerfile`, which is kept as a hidden back-compat alias.)
- **`lazy daemon status` shows binary build time** — the status output now includes a `Built:` line carrying the daemon binary's UTC build timestamp (or `dev` when running from source via `bun run`). Build timestamp is embedded at `bun run build` time via the same mechanism that embeds the version
- **Shell completion rewrite** — command aliases (`ls`, `tasks`, `view`, `doc`) now tab-complete; subcommand completion added for `lazy system`, `lazy daemon`, and `lazy config`; previously-missing commands (`chat`, `stop`, `reparent`, `report`) now complete; and terminal-task commands (`chat`, `reopen`, `revert`, `redo`, `rework`) complete from `list --all` rather than the active list. The canonical alias map is sourced from the same file the CLI dispatcher uses, so completion and dispatch can't drift
- **Default agent model bumped to `claude-opus-4-8`** — was `claude-sonnet-4-5-20250929`. Example model IDs in `--model` help text and generated `lazy.toml` comments refreshed accordingly

### Fixed

- **Zombie sweep no longer silently completes crash-looping interrupted tasks** — the sweeper used to gate the system-actor `complete` transition on tree-equality between a task branch and its parent, which is ambiguous (a half-merged or no-op branch can match a parent tree without actually having been accepted). It now requires an authoritative `lazy-accept-<full-id>` git tag, created at every accept-finalize site before the status flips to `complete`. Crash-looping interrupted tasks can no longer be flipped to `complete` by the sweeper
- **Unit-test baseline restored to green** — `bun test test/unit` went from 824 pass / 89 fail to 914 pass / 0 fail. Root cause was cross-file `mock.module` pollution under Bun's single-process model (`mock.restore` is not actually undoable); fixed with a new `mock-module.ts` snapshot/restore helper used at test boundaries. Same task also removed `git push -u` from both repository drivers, restoring the documented invariant that task branches have no upstream tracking — this prevents a stray `git pull` in a worktree from folding remote state back into the local branch
- **Tasks no longer silently adopt the user's currently checked-out branch as their integration target** — creating a task while on `release-v015` (or any non-default branch) used to set that branch as the task's `target.branch`, leading to PRs/MRs that opened against a base which had since been merged or deleted. New tasks now default to the repo's configured default integration branch (`origin/HEAD` → `main` fallback). The checked-out branch is never adopted silently; pass it explicitly via a new `--parent <ref>` flag on `lazy create` and `lazy_create` (accepts a task code, short ID, or a verified raw branch name; rejects `lazy/*` task-branch refs). The same `getCurrentBranch`-as-fallback anti-pattern was audited and fixed across the codebase: the `resolveParentBranchWithFallback` heal paths, the `lazy_diff` top-level fallback, and the auto-resume path all now use the repo default. Existing affected tasks: `lazy/*` stale refs auto-heal on the next sync; non-`lazy/` adopted branches recover via `lazy reparent <task> --parent <branch>`

## [0.15.1040] - 2026-05-24 - Chat with agents from finished tasks

### New commands

- **`lazy chat <task>`** — reopen a finished task's agent session for an interactive, read-only conversation. Rehydrates the raw Claude Code session JSONL captured on close (accept/reject/close/abandon) into `~/.claude/projects/`, resumes it with `claude --resume` locked to read-only (plan mode + `Bash`/`Write`/`Edit` disallowed), and writes the extended session back to storage when the chat ends so the conversation persists across invocations. Talk to the agent about what it did and why — without any ability to mutate the repo or task state. Defaults to `--effort medium` (a retrospective chat is lightweight; faster/cheaper than the inherited high/xhigh task defaults); override with `--effort <low|medium|high|xhigh|max>`

## [0.14.1037] - 2026-05-23 - Control, visibility, and safety

Lazy v0.14 broadens what you can do (new `lazy report`, `lazy stop`, and `lazy_ask`), tightens how you do it (`lazy close` and `lazy reject` restored as distinct commands, `lazy watch` reworked as a unified timeline, builder discipline polish), and hardens the rough edges (safer accept, GitLab-driver verification, idempotent confirmation, ask-mode lockdown, post-turn-check no-hang).

### New commands

- **`lazy report`** — LLM-summarized markdown digest of recent activity. Covers ALL main-branch activity in the window — both lazy-managed work AND direct (non-lazy) commits by collaborators not using lazy. Default window is the last 24 hours; widen with `--start -3d` (or any relative offset / ISO timestamp) and bound with `--end`. Internally runs a map-reduce of LLM calls — one per lazy task with activity, one per non-lazy commit, then a final reduce — and emits a three-section digest (brief, manager tier, lead tier) where the lead tier clusters work thematically and distinguishes lazy-managed from non-lazy contributions
- **`lazy stop <task>` and `lazy_stop` MCP tool** — halt a running task without triggering auto-resume. The task transitions to `blocked` with a `user_stopped` flag the reconciler respects; re-engage with `lazy unblock` (with or without `--message`). For tasks in the middle of an `ask`, stop also writes a clean `ErrorResponse` to the protocol directory so the caller's RPC returns immediately instead of waiting out the full ask timeout
- **`lazy_ask` MCP tool** — builder-side read-only conversation with a blocked task's agent. Ask a stuck task questions from the builder without unblocking it or losing its session context. Hardened against misbehavior: `Bash`, `Write`, and `Edit` are explicitly disallowed, the in-container MCP server runs with `LAZY_MCP_READ_ONLY=1` (write-capable lazy tools like `lazy_commit`, `lazy_propose`, `lazy_comment` return errors), and a dedicated ask system prompt makes "your final message is the answer" non-negotiable

### Changed

- **`lazy close` and `lazy reject` restored as distinct commands; `lazy abandon` retired** — `lazy close` stops a task without requiring a session (works on backlog tasks); `lazy reject` requires an active session and closes its PR with a reject review. The combined `lazy abandon` verb introduced in v0.12 is gone — having two verbs maps to the two distinct workflows users actually have
- **`lazy resume` deprecated** — after the `lazy stop` change above, `resume` is structurally equivalent to `lazy unblock` with no message. The command and the `lazy_resume` MCP tool still work as aliases that route into unblock, but they print a one-line deprecation notice and will be removed in a future release. The builder system prompt no longer references `lazy_resume` as a canonical tool
- **`lazy watch` reworked as a unified timeline** — tails supervisor + agent streams into a single chronological view with live subprocess output and a phase header, instead of two competing streams. Works on any agent runner (Docker, host-process) without tmux
- **Top-level `lazy logs` removed** — the canonical form is `lazy daemon logs`. No alias, no deprecation passthrough — `lazy logs` simply doesn't exist anymore. Per-task agent/supervisor logs continue to flow through `lazy show <task>` and `lazy watch`
- **Tmux window-title auto-renaming dropped** — lazy no longer writes its own labels into the user's tmux window title. The previous behavior overwrote whatever the user had set and never restored it
- **Offline-mode warnings on accept, sync, and builder startup** — when lazy is in offline mode, `lazy accept` warns that no MR/PR will be created (still proceeds with a local squash-merge), `lazy sync` warns the merge is local-only, and the builder prints a one-time notice at session start. The `lazy_accept` MCP tool response carries the warning in `warnings[]`. Surfacing, not blocking — the human decides whether offline behavior is intentional
- **Builder system prompt polish** — builders are now coached on `ScheduleWakeup` for follow-up work, `lazy_wait` discipline (don't busy-wait, use the tool), and that they have passwordless `sudo` and can install packages themselves rather than blocking. These are prompt-only changes but they noticeably tighten builder behavior

### Added

- **Graceful-exit timeout for `claude -p`** — a 60s timer kills the child process if it hangs after the end-of-turn signal. Previously a hung `claude -p` could lock up a turn indefinitely. Configurable via `[agent].graceful_exit_timeout_ms` in `lazy.toml`
- **`docs/lazy-toml.md` reference docs** — comprehensive schema-grounded reference for every `lazy.toml` key. The generated `lazy.toml` header now embeds a URL pointing at this doc, and the schema parser has a comment reminding contributors to keep the doc in sync when adding keys
- **`lazy.toml` path validation in preflight** — paths configured in `lazy.toml` (and persisted paths in task state) are validated at startup with actionable errors when a configured directory is missing, stale, or unwritable. Replaces mysterious downstream failures with a single error that points at the offending key

### Fixed

- **Subagent MCP blindness** — the lazy MCP server's `initialize` response now includes an `instructions` field listing the available `lazy_*` tools and what each does. Claude Code injects this into the system prompt for every connected session — including subagents spawned via the Task tool — so subagents now know what lazy is and which tools to use. Previously subagents had the tools available but no context on them
- **Safer `lazy accept`** — verifies the squash merge actually landed on the parent branch before deleting the source branch. Previously, a silent merge failure (e.g., from a buggy driver path) would proceed to delete the source, losing the commits. This was the root cause of the v0.14-era "missing accepted children" incident that took a `recover-v014-branches` task to repair from dangling reflog commits
- **GitLab driver silent-accept** — `lazy accept` on a GitLab project no longer reports success when `glab mr merge` skipped the MR (e.g., the merge wasn't actually performed). The driver now waits and verifies the merge landed on the remote before reporting success or cleaning up
- **Post-turn-check no longer hangs** — the supervisor's post-turn check (which validates a turn completed correctly) previously hung indefinitely when `claude -p` ignored `SIGTERM` after the end-of-turn signal — the 600s safety timeout didn't fire on stuck verbose children. New post-turn-check module enforces the timeout and surfaces the hang as an interruption instead
- **`lazy_accept` confirmation flow is now idempotent** — when a large diff triggers the confirmation protocol, the preview call no longer mutates state. A second call that supplies the confirmation token completes cleanly instead of erroring out because the side-effect had already been recorded
- **`lazy_ask` MCP command rejected for missing protocol_version** — `AskCommand` now uses `commonCommandFields` so the protocol_version is populated. Previously the supervisor's protocol-version gate rejected every `lazy_ask` call with a "missing field" error
- **`lazy_create` no longer pushes back on singleton tasks** *(carried in from main as part of v0.13.1028 reconciliation)* — the parent-selection warning fires only when an active task has at least one non-terminal subtask, indicating the project uses parent-child hierarchy. Tasks with no live subtasks are treated as singletons and create without any prompt

## [0.13.1028] - 2026-05-11 - Lifecycle visibility

Lazy v0.13 sharpens visibility into stuck task lifecycles and tightens the daemon-required model.

### Changed

- **Ask timeout caps at 110s with an actionable 504** — when a supervisor is hung, an ask now returns a 504 with a recovery hint instead of an opaque transport timeout. Behavior change: asks previously could hang up to 10 minutes; they now cap at 110s
- **Reconciler failures surface in `daemon.log`** — per-task reconcile failures are logged at `warn` level (was `debug`) so they're visible without bumping log verbosity
- **Daemon-required model is structurally enforced** — the in-process RPC bypass is gone. Production behavior is unchanged from v0.12, but there is no longer a code path that pretends to work without the daemon

### Fixed

- **`lazy show` warns when auto-resume has given up** — when the auto-resume circuit breaker has tripped on a task, `lazy show <task>` now flags it and points to `lazy resume <task>` to recover manually, instead of leaving the task silently stuck
- **`lazy_create` no longer pushes back on singleton tasks** — the parent-selection warning now fires only when an active task has at least one non-terminal subtask, indicating the project uses parent-child hierarchy. Tasks with no live subtasks are treated as singletons and create without any prompt

## [0.12.1023] - 2026-05-04 - Sync, and Cleanup

Lazy v0.12 sharpens the workflow: sync is now its own operation, toolchains are gone, and the daemon hardens around version safety and project isolation. Offline behavior, interactive review, watch, and a new `lazy doctor <task-id>` round out the release.

### New commands

- **`lazy review -i`** — interactive per-hunk review with inline Q&A against the agent's session. Approve, reject, split, or ask the agent about a hunk without leaving the review TUI. Approvals persist across re-runs so split-hunk decisions aren't lost
- **`lazy watch`** — rewritten as a direct JSONL conversation renderer. Reads the agent's session log and prints full thinking, tool calls, and tool results in real time. Works on any agent runner (Docker, host-process) without tmux
- **`lazy sync <task>`** — standalone upstream merge for a task branch. Decoupled from unblock so feedback delivery has zero network dependencies. The daemon retries failed syncs with progressive backoff; a real unblock preempts but never cancels a pending sync
- **Internal task state renamed `closed → abandoned`** (storage-level only). `lazy close` and `lazy reject` remain distinct user-facing commands: `lazy close` stops a task without requiring a session (works on backlog tasks); `lazy reject` requires an active session and closes its PR with a reject review
- **`lazy doctor <task-id>`** — task-level diagnostics and repair. Detects stale parents (parent already complete/accepted), missing local branches, missing worktrees, local/remote divergence, status mismatches, and orphaned worktrees. Interactive by default, with `--yes` to apply fixes automatically and `--dry-run` to report only
- **`lazy system offline`** / **`lazy system online`** — toggle offline mode for a project. When offline, lazy skips remote pushes/fetches, starts tasks from local HEAD, accepts via local squash merge, and blocks submit with a clear error. The daemon stops sync/push background work on the next tick. Equivalent to `lazy config set offline on`/`off`
- **`lazy system build lazy-runner`** — explicitly prebuild the base runner Docker image so the first task launch isn't blocked on a cold image build

### Changed

- **Daemon is required** — fallback to daemon-less mode is removed. The daemon must be running; `lazy daemon start` is the entry point
- **Unblock is pure feedback delivery** — `lazy unblock` no longer attempts upstream merge. Network failures no longer block or corrupt feedback. To merge upstream changes into a branch before unblocking, run `lazy sync <task>` first. The `--sync-with-upstream` flag is removed
- **Toolchains removed** — the 15 language-specific toolchain Dockerfiles, the `toolchains-list` command, and all `lazy init` toolchain selection are deleted. Agents have passwordless sudo and install what they need; toolchains added complexity without value
- **Same-session conflict resolution** — the supervisor now uses the agent's existing Claude Code session for merge conflict resolution instead of spawning a cold-start `claude -p` process. The agent has full task context and makes better choices about which side of a conflict to keep
- **Unblock/accept pre-flight validation moves into daemon RPC** — state transitions happen atomically inside the daemon, eliminating races between concurrent CLI and daemon operations
- **PostgreSQL storage hidden** — not documented in `lazy init` output; embedded-postgres dependency may be removed in a future release. `external` storage (FileStorage) is the only documented backend
- **SSE event delivery dropped** — the daemon no longer pushes events to working agents over Server-Sent Events. All event delivery now flows through the unblock/protocol-directory path, removing a second code path that drifted from the primary one. Working tasks pick up sibling/parent updates on their next turn or via auto-unblock
- **Legacy model alias migration** — task `model` fields stored as `apprentice` / `journeyman` / `master` are auto-migrated to `haiku` / `sonnet` / `opus` on read. Old aliases keep working for existing tasks while new tasks use canonical names
- **Reconciler concurrency and pacing** — the daemon reconciler issues up to 5 concurrent remote requests instead of serializing, and the tick interval moved from 5s to 30s. Faster end-to-end signal propagation with less idle traffic
- **Builder containers scoped to project** — builder containers are labeled with the project root and filtered on discovery. `lazy upgrade` in one project no longer stops builder containers belonging to other projects
- **`lazy upgrade --wait`** — waits for all working tasks to reach a blocked/terminal state before upgrading, instead of killing them. Interactive prompt now offers three options when working containers exist: kill now, wait, or cancel
- **Updated shell completion** — `lazy` shell completion includes all verbs added in v0.11/v0.12 (`sync`, `doctor`, `submit`, `system`, etc.)

### Added

- **Claude Opus 4.7 support** — added as a selectable model alongside Opus 4.6, Sonnet 4.6, and Haiku 4.5
- **Protocol version gate on supervisor** — the supervisor refuses commands whose wire protocol is incompatible (Start/Unblock/Sync command shape, RPC signatures, supervisor↔daemon format) and tells the user to run `lazy upgrade` to rebuild containers. The lazy version itself is NOT part of the gate, so different projects on one machine can run different lazy versions concurrently as long as their protocol versions match. Bumping the protocol version is the explicit signal that containers must be rebuilt
- **Default `--effort` per role** — Claude Code is now invoked with role-aware effort: builder runs at `high`, agents at `medium`. Override via `[agent]` config in `lazy.toml`
- **`lazy_diff` offset parameter** — MCP tool accepts an `offset` parameter to paginate large diffs instead of returning the full diff in one response
- **Auto-react gate diagnostics in `lazy status`** — for blocked/submitted tasks, `lazy status <task>` now shows why auto-react is or isn't firing (budget exhausted, task not eligible, gate checks, etc.)
- **Filesystem-access pre-flight** — lazy now detects when the terminal lacks OS-level filesystem permission (e.g. macOS TCC/Full Disk Access prompts not granted) and surfaces an actionable error before opening `$EDITOR` or running commands that would silently fail
- **Daemon startup error UX** — daemon startup errors are surfaced to the terminal instead of disappearing into the daemon log, and the previous triple-logging in `daemon.log` is gone

### Fixed

- **CI failure detection no longer requires a PR/MR** — CI status is now looked up by branch name directly (GitLab: pipelines API; GitHub: check-runs API). Branches with no open PR/MR now correctly surface CI failures. Falls back to PR/MR lookup if branch lookup fails
- **False positive permission violation** — files created by the agent in one turn and modified in a later turn are no longer falsely flagged as violations. The check now correctly considers which files pre-existed on the branch
- **`lazy upgrade` Docker rebuild used stale cache** — `--no-cache` is now passed when rebuilding the Docker image during upgrade, preventing stale layers from masking version changes
- **`git push -u` set upstream tracking on task branches** — upstream tracking caused `git pull` on main to merge task branches in. Task branch pushes no longer set `-u`
- **`lazy status` early return on missing worktree** — a missing worktree previously cut off all remaining status output. Now prints an inline warning and continues rendering diagnostics
- **GitLab driver auto-merge on accept** — the GitLab driver now self-approves and sets auto-merge when the target branch is unprotected, matching the documented accept flow
- **GitHub driver swallowed PR creation errors** — failed `gh pr create` calls were reported as a generic "Failed to create remote reference" message. The actual gh CLI error is now surfaced
- **`lazy pair` session drift** — the pair session ID is now reconciled at turn end, with a safe fallback when the stored ID is stale. Pair session bridging works in the Docker runner for external projects (the pair container can find the agent's session over the daemon bridge)
- **Daemon startup hang** — daemon process logged "sync loop init" then nothing and never bound its socket. The startup path no longer blocks on a sync loop init that waits for the socket to be ready
- **Daemon degraded state when web port is taken** — failing to bind the web TCP port now fails fast with an actionable error and is surfaced in `lazy daemon status`, instead of leaving the daemon half-running
- **Backlog tasks stuck after non-zero check exit** — when an agent turn ended with a non-zero exit from a check command, tasks were stuck in `backlog`. They now transition correctly
- **Docker build killed by 60s subprocess timeout** — the default subprocess timeout was killing long Docker builds. Docker builds now run without that timeout
- **Stale `remote_target_branch` on reparent** — `resolveParentBranchWithFallback` could resolve to a stale `lazy/*` parent (e.g. a completed `release-v011`) when reparenting to a top-level branch. Stale targets are now detected and ignored
- **Reparenting to completed parent** — tasks whose parent was already complete/accepted no longer sync against that stale parent; reparenting to the grandparent (or main) happens up-front
- **Daemon reconciliation blocked by slow sync** — a slow sync call could starve the reconcile loop. The reconciler no longer awaits potentially-slow remote work on the hot path
- **Reconcile starvation removed** — the legacy `shouldAbort` / `hasPendingRequests` mechanism inside the reconcile loop is gone; async work already yields, so the manual abort plumbing was creating priority-inversion bugs
- **Literal `~` not expanded in paths** — some code paths created a literal `~` subdirectory in the project root instead of expanding to `$HOME`. All callers now go through path expansion before opening the file

## [0.11.942] - 2026-04-06 - The Daemon Release

Lazy v0.11 turns the daemon into the central nervous system of the system — CLI and MCP all connect through it, and tasks advance themselves in response to real-world signals.

### Daemon as central nervous system

- **Event-driven task graph** — The daemon detects state changes during reconcile and acts on them by routing through the task graph: when a parent branch advances, the daemon notifies children and siblings. Notifications are delivered by writing an unblock command into the target task's protocol directory and launching (or reusing) the supervisor — the same path `lazy unblock` uses. Auto-react triggers (CI failures, PR comments) feed into the same delivery path
- **Auto-push task branches** — Task branches are automatically pushed to the remote after state changes (turn completion, acceptance, upstream merge). No manual `git push` needed. Pushes are serialized, retry on transient failures, and respect the configured remote driver. Enabled by default when a remote is configured
- **Per-project daemon** — Each project now gets its own daemon process with an isolated unix socket, PID file, and log. Socket paths are derived from the project root (`~/.lazy/daemon/<dir>-<hash>/lazy.sock`), so projects with different configs (API keys, remotes) no longer collide. `lazy daemon start/stop/status` operate on the current project's daemon and error clearly when run outside a lazy project
- **MCP proxy for containerized agents** — The daemon serves as the MCP endpoint for agents running in Docker containers. Agents access lazy tools (storage, git, task management) through the daemon over HTTP, replacing the old per-session builder server. Task-scoped tool execution ensures agents can only access their own worktree
- **CLI as thin RPC layer** — CLI commands are now thin wrappers over daemon RPC calls. `lazy start`, `lazy unblock`, `lazy upgrade`, and other lifecycle commands route through the daemon instead of launching supervisors directly or competing for file locks. Eliminates duplicate orchestration logic and the old server sync loop

### Auto-react and event delivery

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