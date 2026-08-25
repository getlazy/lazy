# Changelog

## [0.22.1134] - 2026-08-24 - Hotfix for long running Docker builds

### Fixed

- **Container image builds are no longer killed after 20 minutes** — builds run unbounded and stream their progress; `lazy upgrade` / `lazy system build` take an opt-in `--timeout <seconds>`, and a build that bound does kill says lazy killed it rather than looking like Docker failing
- **git no longer refuses a task worktree with "dubious ownership"** — lazy trusts its own worktree and git dirs in the container's git config, and says what to do if it still happens
- **A finished turn is never dropped when the next command arrives** — unblocking an interrupted task could lose the whole turn and leave `lazy pair` on an empty session; the turn is now always recorded

## [0.22.1128] - 2026-08-23 - Cursor Edition

### Added

- **Cursor as a first-class task agent** — run tasks on the Cursor CLI: `--agent cursor`; `lazy ask` follows the task's agent (`lazy pair` stays claude-code only), and a missing binary or key fails one launch with the remedy instead of crash-looping
- **Cursor tasks let Cursor pick the model** — a Cursor task with no explicit model no longer inherits `[models] default` (an Anthropic name) and runs Cursor's own `auto`; `--model` and the task's model still win
- **Agents no longer hold your API credential** — containers and host launches get a per-task placeholder; the audit proxy swaps in your real Anthropic or Cursor credential on the way upstream, and revokes the placeholder when the task ends
- **Auto-resume is now a rolling, round-robin queue** — a task whose fast-lane circuit breaker trips retries on an interval instead of giving up, one task at a time project-wide, until `[daemon] auto_resume_max_attempts` is reached; see the new `lazy daemon resume-queue` and the queue position now shown in `lazy list`/`lazy show`
- **`lazy system agent`** — see which agents are installed and authenticated, switch the project default, and store an agent API key; all picked up on the next launch, no daemon restart
- **Switch agents mid-task** — `lazy edit --agent <id>` and `lazy unblock --agent <id>` change which agent runs the next turn; the session resets, and the next prompt gets distilled turn history plus a branch orientation
- **`lazy_create` takes an `agent`** — agents and the builder can now pick a task's agent over MCP, matching `lazy create --agent`
- **`lazy edit --effort <level>`** — change a task's reasoning effort between turns; like `--model`, it works on a task an agent has already started, and `lazy_edit` gained the same field
- **A refused accept in the browser now tells you how to fix it** — the review page shows what to do next, the files involved, and the exact copy-pasteable `lazy accept` command, instead of just failing
- **`lazy_update_progress`** — agents post a short line saying what they are doing now; it shows next to `working` wherever a task is listed, and clears when the turn ends
- **`lazy watch` shows live API traffic** — `net>` lines for every request the agent makes through lazy's proxy, so Cursor tasks stream too; `--traffic` / `--no-traffic`
- **Approve a protected accept from the review page** — enter the approval passphrase in the browser, or sync a branch that is behind, without leaving for a terminal; anything you had typed survives a failed attempt
- **`[limits] max_turns_without_human`** — caps how many consecutive turns a task can run without a human unblock/resume; a builder/agent-initiated turn past the cap is refused with a clear message, and any human turn resets the count
- **Every turn says which agent, model and effort ran it** — shown per turn in `lazy show`, `lazy review`, the web UI and MCP, with an unrecorded field reading `unknown`; the task's own agent now shows in `lazy show`, the web task list and MCP
- **`--levels <n>` on `lazy list` / `active` / `blocked`** — see just the top level of a busy project; elided children show as `(+N hidden)`, and `lazy_list`/`lazy_active` take the same limit

### Changed

- **`lazy system passphrase`** — the approval passphrase leaves your repo: enrolled once per machine, hashed; `[protection] passphrase_file` is removed and any leftover plaintext file is flagged
- **BREAKING: `lazy approve` no longer reads a piped passphrase** — the passphrase is typed only at the masked interactive prompt; `echo "…" | lazy approve <task>` is refused, so scripted protected merges must move to a terminal or the forge approval
- **The audit proxy has no off switch** — `[proxy] enabled` is removed; a lazy.toml still setting `enabled = false` is rejected at load and `enabled = true` warns that the line is dead, and you point a role at an explicit `endpoint` to send it elsewhere
- **Every role is proxied now** — a role's `endpoint` (and an Ollama backend) is the upstream lazy's proxy forwards to, not an address the agent dials, so nothing bypasses the audit trail
- **Agents no longer run your whole test suite every turn** — they verify with the tests covering what they changed, leaving full-suite runs to `[checks] post_turn`
- **`lazy builder` is autonomous by default** — no per-tool permission prompts; each launch prints the builder's posture (containerised, repo read-only, task operations via the daemon) and asks you to confirm, with `--no-autonomous` as the opt-out
- **`lazy resume` is fully un-deprecated** — it's the normal way to resume a blocked or interrupted task without new feedback, on equal footing with `lazy unblock`

### Fixed

- **A task stuck in `merging` can be escaped again** — an accept killed mid-merge no longer wedges a task forever: `reject`, `close`, `submit` and `unblock` recover it, the daemon sweeps it automatically, and `lazy doctor` reports it
- **`LAZY_DOCKERFILE_LAZY` and visible image sources** — a task's worktree never picks the container image; to build from another Dockerfile (e.g. a source branch's, before it merges) export `LAZY_DOCKERFILE_LAZY=<path>`, which applies to every command and the daemon alike, and `lazy upgrade` (incl. `--images`) now prints the exact `Config:` and `Dockerfile:` paths it builds from
- **`lazy upgrade` from a worktree** — on a TTY, asks whether to set `LAZY_DOCKERFILE_LAZY` to the worktree's `Dockerfile.lazy` before the image build starts
- **A malformed `~/.claude.json`, `~/.cursor/mcp.json` or `~/.claude/settings.json` is no longer silently overwritten** — lazy names the file and stops instead of wiping your other MCP servers and permissions
- **`lazy show`** — the slow-lane auto-resume indicator was computed but silently dropped before reaching the CLI, so an interrupted task queued for auto-resume never showed it
- **Approving a protected file makes it stay approved** — a later unblock decides only the still-pending violations, so it no longer silently reverts files you already approved, and re-approving them is accepted
- **Pending protected-file decisions survive read-only and side-channel turns** — an ask, sync, pairing session or stop can no longer clear a task's `conflict` label while its violations are still pending, which used to make the approval unexpressible and silently revert the agent's committed work
- **`lazy unblock` interactive mode** — approving or rejecting violated files via the prompt was lost before reaching the daemon; the daemon now also refuses conflict-task unblocks when no decision is passed, preventing silent data loss from any client
- **Supervisor tracks when a failed turn had no effect on the branch** — error responses now carry `agent_had_no_effect` when the agent crashed without commits or changes, letting downstream skip mechanisms that only make sense when work was done
- **Web dashboard / `lazy review`** — a task turn containing Windows-style line endings froze the whole daemon when rendered
- **Parent-chain walks are now bounded** — ancestry, root and sync-target lookups stop rather than spin if a task's parent chain ever loops, a guard the subtree walk already had
- **`lazy daemon status` / `stop` / `restart`** — a frozen daemon is reported as unresponsive within seconds instead of hanging, and stop/restart force-kill it for you
- **Public releases now compile** — the published repo was missing generated modules and a script its tests import, so `tsc --noEmit` failed on a fresh clone; a release now typechecks its own archive before publishing
- **Sync subprocess timeouts are now guaranteed** — a wedged `ps`, `git`, `docker` or `tmux` probe can no longer hang the daemon or the CLI; every such check is now bounded by default, while interactive handoffs like `lazy shell` still run as long as you need
- **Postgres storage initialises again** — two column migrations had a malformed quote that aborted schema setup for the whole backend, so every migration after them never ran

## [0.21.1096] - 2026-08-16 - Web review loop and reliability hardening

This release began as a complete redo of the web UI and shipped the first working review loop in the browser — task queue, line-anchored diff, inline comments and asks, unblock and accept. Around that core, most of the release hardens the layers underneath: agent/builder MCP tooling, daemon lifecycle and storage-lock correctness, and the e2e harness. New surfaces (`lazy stats audit`, `lazy ask` over stored conversations, the builder scratch dir) round it out.

### Added

- **Web review loop (POC)** — review blocked tasks in the browser at `/review`: task queue, line-anchored diff, inline asks and comments, unblock and accept. See [docs/web-review.md](docs/web-review.md)
- **Withdraw a review comment** — take back a queued comment (or a failed question) from the review page before it reaches the agent; it stays in the thread struck through, out of the queue and out of the next unblock
- **Side-by-side diffs in the browser** — a Layout toggle on the review and commit pages puts deletions across from their replacements; comments anchor the same in either view
- **Review over RPC** — reviewing, commenting, asking, unblocking and accepting are now daemon RPC commands, so a web UI that is not the daemon (including one run from source) can drive the full review loop
- **Builder scratch dir** — a writable place outside the repo where the builder leaves documents and accept messages for you; agents cannot read it
- **`lazy ask <conversation-id>`** — ask a stored builder conversation a question and get an answer; a throwaway read-only agent reads the transcript and nothing is written back
- **`lazy stats audit`** — browse proxy audit records one per request, filter by task, role, time, denials, reroutes or failures, and open any record in full
- **Protected tasks now say so before an accept is refused** — a `Protected:` line in `show`/`status`, `[P]`/`[P][A]` markers in `list` and the dashboard, the gate in the review header, and a read-only `protection` field over MCP
- **`lazy accept` refuses a merge that would un-delete a file** — it names each file and the commit that deleted it; `--approve-file` lets a deliberate restore through
- **Errors, warnings and command help now point at the docs** — "Check documentation at <url>", pointing at docs.getlazy.dev by default; `[docs] url` retargets it at a mirror or `""` turns it off
- **docs.getlazy.dev is published on release, one snapshot per minor** — pointers are version-pinned to the docs your build shipped with, and a release fails if any of them 404s
- **A task blocked on its subtasks now reads `working(waiting on <task>)`** — instead of looking identical to an agent doing its own work; the waited time is also recorded so reports can subtract it
- **Agents can set `agent` and `effort` when starting a subtask** — a nonsense effort level is now refused instead of silently persisted, and `start`/`create` flags tab-complete again
- **Search hits now say which turn matched** — turn hits are labelled `turn #12`, and turn, commit and comment hits carry an index you can page `show` straight to, and follow-up hits an index into the follow-ups `show` always returns whole
- **`lazy daemon stop`/`restart` warn before they cut sessions** — they list live task agents, builders and pair sessions with what each loses, and ask first; `--yes` and scripts still warn but never block
- **`lazy doctor <task-id>`** — now also reports the agent's actual lazy tool count and a live daemon round-trip from inside the task's container, which `claude mcp list` cannot show
- **Storage housekeeping audit** — `docs/spikes/storage-housekeeping-audit.md` classifies every stored entity as durable project state or machine-local scratch, and recommends three moves into `.lazy/`
- **CLI/MCP parity audit** — `docs/surface-asymmetries.md` records every deliberate CLI-vs-MCP difference with its rationale; `docs/reviews/cli-mcp-parity-audit-2026-08.md` classifies the rest as gaps
- **UI-redo design doc** — `docs/spikes/ui-redo.md` synthesizes the demo-vcs prototypes into the architecture behind the new web review surface
- **Claude Design ↔ lazy loop spike** — `docs/spikes/claude-design-loop.md` designs a repeatable design-in-Claude-Design, land-as-code, sync-back loop that coding agents can run
- **Token-savings replay spike** — `docs/spikes/token-index.md` replays lazy's task history to estimate savings from adaptive model/effort selection
- **v0.12 resurrection audit** — `docs/spikes/v012-release-resurrection-audit.md` diffs the v0.12 release commit against its window and finds five more undone changes beyond the known SSE zombie, including the auto-react budget regression fixed below
- **"Six months of lazy" report** — `docs/blog/six-months-of-lazy.md`, a data-driven history of the project with token and task charts
- **`lazy server` is replaced by `lazy daemon dashboard-url`** — prints just the dashboard URL, or exits non-zero if the daemon isn't running, instead of auto-starting it; use `open $(lazy daemon dashboard-url)`

### Changed

- **`lazy builder --resume` now requires a session ID** — the bare form and the "resume previous session?" prompt depended on a shell variable lazy never set, so they could never fire; a bare `--resume` now points you at `lazy builder list`
- **`lazy init` now gitignores `.lazy/` wholesale** — one rule instead of a dozen per-path entries that went stale as lazy wrote new files; re-running init retires the old block and warns if git already tracks anything under `.lazy/`
- **`lazy upgrade` rebuilds the image while you decide** — the rebuild starts immediately in the background under a staging tag, so waiting on agents or prompts no longer delays it; your current image only changes once you proceed
- **`lazy timings` is now `lazy stats timings`** — the request-trace readout moved under the analytics multiplexer with no top-level alias, and it (plus ~20 other commands, subcommands and flags) is finally listed in `lazy --help` and shell completion
- **The lazy agent image ships its test dependencies** — bubblewrap, socat and PostgreSQL 15 (installed, not running; start it with `lazy-pg-start`) instead of every agent re-installing them per task
- **The agent image refreshes on time, not on version** — `lazy upgrade` always rebuilds it and a 14-day backstop catches idle hosts; builds off `main` now report `-alpha`

### Fixed

- **`lazy review` no longer crashes on a task whose store holds a comment, journal entry or follow-up saved without text** — the record renders as `(no content recorded)`
- **A long-running builder no longer loses its lazy tools when other builders pile up** — the token registry's 50-entry cap now retires dead sessions' credentials before live ones
- **`lazy upgrade` now verifies the agent binary it installs** — a wrong file (the bare Bun runtime behind `Script not found "builder"`) is refused, the working one is kept, and `lazy doctor` names it
- **A builder or `lazy pair` session no longer gets resumed into lazy's own housekeeping run** — accept-time fidelity summaries can no longer be mistaken for your session
- **Git LFS files no longer get committed as raw blobs unnoticed** — lazy refuses to start a task when the LFS filter would not run, and refuses to accept a branch carrying raw content on an LFS path
- **An agent that starts with no lazy tools is now caught at its first line** — the turn is killed instead of doing the work blind, and each turn records what tools it actually had
- **An agent that cannot get its lazy tools no longer runs anyway** — the turn fails with a message naming the task, the container and the cause, instead of doing the work toolless
- **`lazy upgrade` deletes pre-v0.20 MCP configs left in your repo and rotates the daemon token they leaked** — it reports the count; running sessions are unaffected
- **A daemon restart no longer strands running agents, builders, `lazy pair` and `lazy chat` sessions** on a dead proxy address — each is stopped cleanly and resumed against the new daemon
- **A task whose code is exactly 36 characters can be looked up by that code again** — lookups took it for a task ID on length alone, so the task showed in `lazy list` but every command reported "No task found matching"
- **`lazy doctor` no longer calls `[proxy.policy]` and `[memory]` unknown options** — both are valid, documented config, and the schema is now pinned to the documented surface so it can't drift again
- **Commands run from a task worktree no longer warn about its `lazy.toml`** — the warning now fires only when that file's contents actually differ from the git root's
- **A failed `lazy daemon start` no longer wedges the daemon that is running** — it can't delete a live daemon's files, liveness comes from the daemon lock, and the daemon restores its own PID and socket
- **`lazy pair` and `lazy chat` no longer come up asking for `/login`** — they run on the daemon's credential like every task agent, instead of on whatever your shell happened to export, and say so before launching if there is none
- **The approval passphrase no longer appears on screen** — `lazy approve` masks what you type instead of echoing it into your terminal and scrollback
- **The builder no longer loses its lazy tools after an upgrade** — concurrent builders stopped clobbering each other's launch config and credential, and a broken MCP server now fails loudly at launch instead of silently
- **Builder conversation capture works again** — it was rejected every 30 seconds all session, costing `lazy upgrade` its resume point; a failure now stops the launch or is reported
- **Fuzzy search from an agent now reaches conversations and task codes** — it was quietly searching less than the same query typed at the CLI
- **GitHub Enterprise Server remotes now work** — lazy reads the repo and its hostname from any GitHub remote instead of only `github.com`, so PR creation, branch-protection checks, review posting and comment sync reach the Enterprise install rather than github.com; `lazy link` accepts its PR URLs too
- **`lazy doctor` now checks GitHub auth against the remote's own host** — being logged into some other host no longer makes the check pass, in either direction
- **`lazy doctor` no longer hangs on the wedged store it exists to diagnose** — it names the process holding the storage lock, marks the checks it skipped, and still prints the rest of the report
- **`lazy doctor` no longer calls a healthy store wedged** — a lock held by the running daemon reads as normal (that is its design), and only an unreachable daemon or a foreign holder fails the check
- **A storage lock with an unreadable timestamp can now be reported as wedged** — `lazy doctor` no longer downgrades it to a warning forever
- **The builder's exit report no longer flags ordinary tool errors as MCP server failures** — only real connectivity and spawn errors are reported
- **A recycled PID no longer wedges every lazy command forever** — a lock left by a dead process is recognized and reclaimed, and `lazy doctor` clears one it can't judge
- **`[session] debug = true` no longer prints your auth token** — debug output shows the container command with credential values redacted and everything else intact; remote host checks and supervisor tag validation were hardened alongside it
- **Unblocking a conflict task no longer silently reverts protected files** — approving or reverting each violated file is now required on both `lazy unblock` and `lazy_unblock`, instead of the check being skipped whenever a review nudge followed the violation
- **Token counts no longer double-count or drop a turn's spend** — a turn that crashed or was killed still records the tokens it used, and a re-reconciled turn stops inflating the task total
- **Task runs no longer leak a tmux session on hosts that have tmux** — `lazy watch` stopped using tmux long ago; clear old strays with `tmux kill-session -t lazy-<id>`
- **Auto-react budgets now actually stop a runaway task** — per-task retry and auto-turn counters survive a completed turn instead of resetting to zero after each one, so the retry limit, the auto-turn budget and the paused flag are reachable again
- **Upgrading lazy no longer keeps running a stale agent image** — runner images are tagged with lazy's major.minor version instead of `:latest`, and `lazy doctor` lists older ones to reclaim
- **Running the whole test suite no longer invents hundreds of failures** — the test scripts now pass a 30s timeout, so multi-file runs stop falling back to a 5s default that no suite hit when run on its own
- **Running the whole test suite no longer invents failures from file order** — a test-only flag one suite sets no longer leaks into the ones that run after it and cuts them off from the test daemon
- **Test runs no longer leave daemons behind** — a daemon started by the e2e suite now exits with that run even when the test process is hard-killed, instead of squatting a port and a storage lock forever
- **Turn history reads the same on a Postgres store as on a file store** — a turn with no recorded model id or effort no longer reports those as empty values instead of leaving them out
- **`lazy daemon list` no longer reports daemons that died months ago** — a recycled PID is now recognized as such, so those dirs show as orphans `--prune-dirs` can clear
- **Task history now shows who really did each thing** — closing, rejecting, submitting, reparenting, creating or journalling over MCP no longer reads back as a human's action
- **Rebuilding and restarting the daemon no longer kills a live builder or agent session** — lazy tool calls wait for the daemon to come back and pick up a re-issued credential, instead of ending the conversation
- **An agent that loses its lazy tools mid-turn recovers, and its journal entries and follow-ups are recorded anyway** — the tools reconnect after a daemon restart, and anything still unwritten is picked up when the turn ends
- **`lazy ask` keeps the agent's lazy tools** — an asked agent can query live task state again instead of reporting the tools disconnected; ask stays read-only
- **A malformed tool call is now refused instead of half-executed** — the daemon and builder check every MCP call against the tool's declared schema, so a bad request gets a 400 naming the field rather than writing an empty commit or journal entry
- **An acknowledged edit is no longer silently lost** — a `--prompt`/`--goal` edit racing another operation on the same task stays applied, `start` launches with the latest prompt, and a task never briefly reads as "not found" mid-write
- **Agent tool calls answer like the CLI does** — diffs use the task's real target branch, a task-filtered list covers the whole subtree, and a created subtask keeps its runner and priority
- **`lazy start` keeps the branch you created a task against** — `lazy create --parent release-x` now bases and targets the task on `release-x` instead of quietly using the repo default; an unresolvable target fails with the branch named
- **`lazy sync` can no longer strand a half-merged worktree** — it merges, resolves, or aborts loudly; `show`/`wait`/`status`/`accept` now name an unresolved merge
- **`lazy builder --resume` no longer mounts a stale copy of your session** — it resumes the copy with the most history, and capture can never shorten a stored conversation
- **A failed `lazy accept` no longer burns your `lazy approve`** — the approval is spent only once the merge completes, and a failed accept says it is still pending

## [0.20.1083] - 2026-08-05 - Hot fix

### Fixed

- **Proxy audit log no longer bloats your task store** — it now lives in the disposable, gitignored `.lazy/logs/`, capped at 8 MiB, and any oversized leftover in the store is removed on daemon start

## [0.20.1081] - 2026-08-04 - Agent containment, agent-run subtasks, and builder session reliability

This release draws a hard boundary around what an agent can do, and makes builder sessions dependable across restarts and upgrades. Containment is now enforced by mounts and tokens rather than by prompt: agent containers get a split `.git` mount that cannot move refs, every daemon MCP token is scoped to a single task or a single builder session, and all agent model traffic routes through lazy's local audit proxy by default. On top of that boundary agents can decompose and run their own subtasks end-to-end (create → start → review → accept), while the builder gets one unified `/resume` list per project, live conversation capture into lazy's store, and a relaunch that survives `lazy upgrade`.

### Upgrading

- **Relaunch any builder or agent session that was live across the upgrade.** MCP tokens are now minted per session and the daemon's config location moved, so a session that survives the upgrade holds a token the new daemon will not honor. Restarting the daemon is *not* enough — stop the session and start it again (`lazy builder --resume <id>` keeps the conversation).
- **Restart the daemon (`lazy daemon restart`).** Agent containers can no longer write git refs and forward those operations to the daemon's internal elevation tool; a daemon still running pre-upgrade code does not serve it, and in-container syncs will fail until it restarts.

### Added

- **Protected branches (opt-in): human-approved accepts via `lazy approve`** — `[protection] enabled = true` gates accepts into the default branch on a one-time human approval, and approving the task's PR/MR works in place of `lazy approve`. `lazy protect <branch|task> on|off` manages it from one CLI (editing `[protection]` in lazy.toml, comments preserved) and adds protected *tasks*, which gate merges upward; the implicitly-gated default branch shows in `lazy protect` and `lazy doctor`, which also flags stale entries. Stays opt-in, but a successful accept into the default branch now tips you to `lazy protect main on`. See `docs/protected-branches.md`
- **`lazy stats tokens`** — token usage is now recorded for every proxied request and rolled up by role, task and model
- **Every turn now records the model and effort that produced it** — per-turn `model` (requested alias), `model_id` (concrete id, when the agent reports one) and `effort`, surfaced in `lazy show` and `lazy_show`, so a mid-task override is attributable instead of erased by last-value-wins `task.model`
- **`lazy loop <task...>` — queue mode** — drive a curated list of backlog tasks one by one: start, wait, review gate (feedback / hunk-by-hunk / accept / reject / sync / skip / stop), next. `--backlog --parent <hub>` picks the list, `--pipeline` pre-starts the next. No persisted state, no locks
- **`lazy wait <task> [<task>...]` / `lazy_wait`** — race several tasks and return the moment the FIRST one finishes its turn, naming the winner and the still-pending rest
- **`lazy chat` now works on paused tasks too** — interactive read-only conversation with a blocked task's agent in its worktree; the task is left untouched and no turn can start underneath
- **`lazy ask <task-id> [-m] [--json]`** — CLI for the existing read-only agent ask: one plan-mode question against a blocked task, answer on stdout, `$EDITOR` when interactive
- **`lazy memory compact`** — shrinks the memory injected into every launch via a derived summary; records untouched, newer ones still win, and `lazy doctor` reports size and staleness
- **Scripted runbook for verifying the host sandbox on Linux** — a throwaway Lima VM runs the probe and diffs each case against the verified macOS matrix. See `docs/runbooks/verify-host-sandbox-linux.md`
- **`lazy active <task>` / `lazy_active(task_id)`** — show only one task's subtree (it and all descendants); works with `-f`
- **Lazy-owned shared memory (`lazy memory`, `lazy_memory_*`)** — storage-backed, actor-attributed named records of cross-task knowledge, auto-injected as a compact index into every builder and agent launch; agents are read-only (enforced server-side), records are searchable via `in:memories`, and `lazy doctor --import-memory` imports existing harness memory verbatim. See `docs/memory.md`
- **`lazy timings` shows where a slow command actually spent its time** — lazy now traces every request automatically (always on, nothing to enable, no config) and `lazy timings` ranks each one by **self time** — slowest leaf operations, then the nested spans with real own work (children excluded, concurrent children counted once) — so pass-through wrappers stop masquerading as the slow thing; the nested tree is still there behind `--tree`, and traces are stitched across the CLI→daemon hop. Measured cost is 0.7µs per span — unmeasurable against real git/Docker work — and the trace store is pruned to a bounded size. `lazy start` is instrumented first; agent/model spans follow. See `docs/spikes/timings.md`
- **Host execution defaults to Claude Code's OS sandbox instead of `--dangerously-skip-permissions`** — agents and the interactive builder now run under Seatbelt (macOS) or bubblewrap (Linux/WSL2), with full bypass an explicit `[runner] permission_mode = "bypass"`. Headless agents run sandbox + bypass so a `-p` session never hangs on a prompt while the sandbox stays the hard boundary for Bash (the `dangerouslyDisableSandbox` escape hatch is disabled); the interactive builder runs sandbox + normal prompts. Because the OS sandbox governs Bash only, the Read/Edit/Write tools are separately confined by `permissions.deny` rules from a built-in sensitive-path denylist (`~/.ssh`, `~/.aws`, `~/.claude*`, shell rc files) plus user extras. New `[runner]` keys: `permission_mode`, `sandbox_allowed_domains`, `sandbox_deny_read`, `sandbox_deny_write`, `sandbox_allow_weaker_nested`. On Linux a missing `bubblewrap`/`socat` fails hard instead of silently running unsandboxed, and `lazy doctor` reports the active posture. See `docs/lazy-toml.md`
- **Pre-accept validation (`[automation.pre_accept]`, opt-in)** — with `enabled = true`, accepting a task first runs one agent turn that executes the configured `commands` (full suite, build), fixes what they surface, and brings maintained files up to date; the supervisor then re-runs those commands itself as the authoritative gate, so a failure returns the task to `blocked` with the reason instead of merging silently. Every pre-accept turn also records a short post-mortem to the task journal. Off by default, because the step costs a full agent turn that `lazy accept` blocks on
- **Competitive-landscape research** — three briefs under `docs/research/`: agent-orchestration field survey (portal + teams lens), forge/tracker convergence + injection-vector survey, and unattended-agent-loop primitives mapped onto lazy
- **Concurrency limits for agent and builder containers (`[limits]`, default 8 each)** — starts beyond `max_concurrent_agents` now **queue** (new `queued` status, shown with drain position such as `queued #2 of 3`) and the daemon drains them as slots free, including for crash auto-resume and CI auto-unblock; builders beyond `max_concurrent_builders` fail fast, since an interactive session is never queued. `lazy daemon config get/set/reset` overrides either cap for the running daemon session only
- **Idle-container reaper (`[limits] idle_grace_minutes`, default 10)** — a blocked-but-alive container no longer holds a concurrency slot indefinitely: it is reaped after the grace period, or immediately when same-or-higher-priority work is queued and starved. Reaping is cheap because durable state lives in the store, so the next unblock relaunches; base grace reaping is container-runner-only, routed through the runner's `reapsIdleRuns` capability
- **Task queue priority** — `lazy create --priority <low|normal|high|urgent>`, `lazy prioritize <task> <level>`, and `lazy_prioritize` set a durable per-task priority; when a slot frees the daemon drains the highest-priority queued task first (ties FIFO), and priority is visible wherever queued state is
- **`lazy upgrade --images` refreshes the image for future sessions without disruption** — rebuilds only the project's container image (with `--no-cache`, so a newly-released Claude Code is actually re-fetched) without stopping any container, rebuilding the agent binary, or restarting the daemon; running builders and agents keep working, and the command prints exactly when each kind of session switches over
- **Task tags for lightweight, non-hierarchical grouping** — `lazy tag <task> <tag>` / `lazy untag` (and `lazy create --tag`, repeatable) group tasks into efforts; every change is an append-only, actor-attributed history event surfaced in `lazy show`, and you can filter with `lazy list --tag`, `lazy blocked --tag`, and the `tag:` search field
- **Conversation import reaches every Claude projects dir, in bulk or by session id** — `lazy import-conversation` now uses the same multi-root discovery as the built-in recovery (shared `~/.claude/projects` plus per-builder isolation dirs, deduped to the best copy), so a session that only lives in an isolation dir is finally importable. Bulk import previews and confirms before writing (`--yes` to skip), is idempotent, and `lazy doctor --reimport-conversations` is an alias for the same flow
- **`lazy init` offers to inherit existing Claude Code history** — on a repo that already has Claude Code history, init offers, as one step, to import past sessions as builder memory and harness memory files as lazy shared memory records; both are prompts, skipped under `--non-interactive`, and declining points at `lazy import-conversation` / `lazy doctor --import-memory`
- **`lazy system prompts` / `lazy show <prompt-code>` work in compiled binaries** — built-in prompts are inlined at build time into a generated, gitignored `src/prompts-bundle.ts`; dev still reads live files, so edits stay instantly visible
- **`lazy-agent selfcheck` plus a builder preflight make a broken agent binary loud** — the wrong file mounted at `/usr/local/bin/lazy-agent` used to cost the builder every `lazy_*` tool with only an opaque `-32000` buried in Claude's logs; the supervisor now checks a stable `lazy-agent ok <version>` sentinel before launching and aborts with an actionable "rebuild/reinstall the agent binary" error
- **Daemon staleness signal in `lazy daemon status`** — a long-lived daemon serves whatever code it started with and never hot-reloads, so a merged fix silently has no effect until restart. The daemon now records the git short SHA it is running (`codeSha`) and `lazy daemon status` warns and points at `lazy daemon restart` when that diverges from the working tree's HEAD
- **`lazy shell <task> -- <command>` runs a one-off command in a task's worktree** — argv is passed through unchanged (no `sh -c` join, so quoting survives), stdio is inherited, `LAZY_TASK` is set, and the child's exit code becomes lazy's so it composes in scripts; with no `--`, behavior is the unchanged interactive shell
- **`lazy start` honors offline mode and exposes `--force-local` over MCP** — offline start now branches from the local parent HEAD (no remote fetch, sync-style warning); the MCP `lazy_start` tool gains an optional `force_local` param for the online missing-remote-ref case
- **`-m` short alias for `--message`** — `lazy journal`, `lazy comment`, and `lazy unblock` now accept `-m`, matching git's convention
- **Fake `claude` binary e2e test seam** — scripted agent behavior on PATH, so the real supervisor, its watchdog kills, and stream parsing are finally e2e-testable

### Changed

- **SSE event delivery removed for good** — a v0.12 release merge resurrected the daemon SSE module, its dead supervisor client, and its test suite after v0.11 deleted them; all three are gone again
- **`lazy accept` narrates its phases** — announces the plan up front, then reports each phase start/finish with timing over CLI and MCP; status now says `merging` for the whole merge and an aborted accept restores `conflict`
- **Agent prompts now state git and transport discipline explicitly** — what git an agent may run, that history rewriting and `git stash` are refused by design, and that losing the `lazy_*` tools means reporting back, never hand-rolled daemon HTTP
- **Per-task daemon MCP tokens** — the daemon derives caller identity from the token and refuses (403) a mismatched task claim, ending cross-task impersonation
- **Builder MCP tokens die with their session**, and a `[[mounts]]` entry that would expose lazy's daemon state directory to a container is now refused
- **Agent containers can no longer move git refs** — in-container commits, merges, tags, resets and history rewrites are refused; agents commit via `lazy_commit` instead
- **Proposals retired; agents self-orchestrate their own subtasks end-to-end** — `lazy_propose` and the `lazy propose` CLI are gone from every user-reachable surface (leftover `proposals/*.json` sit inert; no migration). In their place an agent may create a task only as a child of its own and start only its own subtasks, then observe, iterate on, and complete them — `lazy_show`, `lazy_diff`, `lazy_wait`, `lazy_unblock`, `lazy_accept` (accepting your own task stays refused), `lazy_reject`, `lazy_close`, and every other task-targeting tool are gated daemon-side to its own task or a direct child, with `lazy_edit` unable to change a parent. `lazy_clone`, `lazy_redo`, and `lazy_reparent` are off the agent surface entirely; the builder keeps the full tool surface
- **Conversation capture now skips lazy's own `claude -p` housekeeping** — fidelity summaries, `lazy report`, and memory compaction no longer bury real conversations in `lazy builder list` and search; `lazy doctor --purge-housekeeping-conversations` lists, then (with `--yes`) deletes the already-stored ones
- **All agent model traffic now routes through lazy's local audit proxy by default; disable with `[proxy] enabled = false`** — a project with **no `[proxy]` section at all** now gets it: the daemon starts the Anthropic-native passthrough proxy on an OS-assigned free port (`[proxy] port` is now optional; an explicit port still overrides), injects `ANTHROPIC_BASE_URL` at launch, logs a Tier-1 audit record per request — attributed to the role and task that made it — and enforces the policy layer, with inherited claude.ai `mcp__claude_ai_*` connectors still denied by default and the denial teaching the `connector_allowlist` remedy. **Credentials are unaffected** — your existing API key or OAuth token is forwarded to the same upstream — `ollama` roles are never proxied, an explicit role `endpoint` is still honored, and a `backend = "proxy"` role no longer requires one. **No silent fallbacks:** a proxy that cannot start fails the daemon start, and a launch that cannot resolve the live proxy address fails rather than connecting direct, so a transient failure can never opt you out of the audit plane. `lazy daemon status` and daemon startup show the proxy — address, upstream, fallback count, and policy state — which is now the primary way to discover its address
- **The >300s e2e suites (daemon, remote-storage) are now opt-in** behind the test-only `LAZY_SLOW_TESTS=1`, each printing one skip line so default runs stay fast but never silently green-by-omission
- **`lazy view` groups turns into review chunks by default** — parity with the `lazy review` TUI; the canonical `lazy show` stays flat by default (scripts undisturbed), and `--chunks`/`--flat` force either mode on both
- **`lazy system prompts` no longer lists `merge-instructions`** — the unreachable prompt told agents to run `git merge` themselves, which agent containers refuse

### Fixed

- **Long daemon and MCP calls no longer go silent, time out, or block other calls** — heartbeats stream to the client as `notifications/progress` so a slow `lazy_accept` or `lazy_wait` is not abandoned at an idle timeout, quick calls answer right away instead of queueing behind a long merge, and a failed call names the real cause instead of reporting the daemon down
- **A turn recorded without content no longer crashes accept, show or search** — read paths degrade to a placeholder, and all three storage backends now coerce turn content to a string on write
- **No-progress watchdog now fires at 30 minutes, not 2 hours** — and a kill that captured nothing (hung first model call) is relaunched automatically with backoff; the recorded turn explains the kill
- **Postgres storage returns the same data as file storage** — unset optional fields are absent rather than SQL NULL, turn `actor` and task `pending_sync` now persist, and JSONB columns (per-turn violations, merge conflicts, usage) are no longer double-encoded into raw text; a migration repairs existing rows
- **`lazy diff` fails loud instead of printing its error as a diff, and `lazy show` shows the timestamp that tells two same-code tasks apart**
- **A builder relaunched by `lazy upgrade` resumes the same conversation** — the host now recovers the session id itself, builders are stopped gracefully instead of SIGKILLed, and the relaunch no longer fails with "No conversation found with session ID" when the session lives in a per-builder isolation dir
- **One builder `/resume` list per project** — every prior session is listed whichever builder id you resume (v0.18's per-builder isolation had left each run its own empty list), and resuming a session that never ran under lazy asks for `--import` instead of silently adopting it
- **The builder `/login` loop ends** — a transient 401 no longer swaps in a stale host credential; builder Claude settings persist between launches, and `lazy doctor` reports a rejected credential
- **`lazy doctor` reports the credential the DAEMON holds, not your shell's** — a daemon-only token no longer reads as "not authenticated", nor a stale shell token as healthy
- **MCP tool errors keep their real status** — a bad argument returns 400, not a 500 that looks like a daemon crash; malformed task paths fail clearly
- **Conversations reach lazy's store reliably** — host-side Claude sessions (your own `claude` included) are captured live, builder conversations no longer silently vanish in Docker mode with an external storage backend, and `lazy doctor` fails when recent sessions never reached the store
- **A daemon request killed mid-flight now shows up in `lazy timings` as an error** — reaped requests and heartbeat writers used to leave no trace at all
- **Piped output is no longer cut short** — `lazy logs` and `lazy export-dockerfile --stdout` dropped everything past the first 64 KiB when piped
- **`lazy pair` / `lazy chat` / `lazy builder` no longer die with ENOTFOUND on a docker-runner project** — host launches now get the host-reachable proxy/ollama address the preflight actually verified
- **Turns are no longer killed mid-summary after a commit** — the kill window opens only once the summary is captured, for work and merge turns alike. `[agent] graceful_exit_timeout_ms` → `wind_down_timeout_ms`
- **A broken lazy.toml fails loudly instead of silently running on defaults**, naming the offending line; the daemon refuses to start on one rather than guessing the runner and dashboard port, and `lazy doctor` still runs (daemon-less) so you can see why; an overrunning dashboard page now returns a readable error, not a dead connection
- **The daemon never starts without a model credential** — every start path refuses, including auto-start; a blank value counts as absent, and `daemon restart` checks before stopping
- **Agent failures are classified, not retried blindly — and retrying tasks say what they are retrying** — a dead credential blocks the task with its reason instead of retrying forever, rate limits retry every 5–60s instead of 30–300s, and `watch`/`show`/`list`/`active` show the attempt count, failure class, and latest error instead of a bare "retrying"
- **`lazy upgrade` aborts up front when no model credential is set**, instead of rebuilding everything and then leaving you with no daemon; builders now wait out a long rebuild instead of timing out
- **A batch of long-standing command-path bugs** — `lazy revert` could never find the merge commit for a task created with `--code`; `lazy start` on an orphaned child always failed with impossible advice; `lazy redo` printed a removed command's name and had no already-closed guard; a silently recreated missing worktree warns again; a fetch against an unconfigured remote retried three times before reporting; `lazy wait` on a never-started task lost its "has no session" guidance
- **`lazy system <sub> -h` / `lazy daemon <sub> -h` print the subcommand's help, not the parent's** — subcommand usage text (e.g. `daemon logs`, `system build`) was previously unreachable
- **Feedback recorded but never consumed is re-delivered verbatim on resume** — a turn that crashes after feedback is persisted but before the agent reads it no longer resumes with a generic "carry on" prompt; delivery is now tracked per turn, for any crash cause
- **Feedback containing NUL/control bytes no longer crash-loops the agent and silently drops the feedback** — every text intake (CLI, `$EDITOR`, stdin, MCP, daemon RPC) escapes non-printable control characters before persisting, and `spawn()` rejects NUL-bearing argv with an actionable error. Also fixes `lazy unblock -f <file>`, which was rejected as an unknown flag
- **Running agents and builders survive a daemon restart** — `lazy_*` tools recover on their next call instead of failing `Unauthorized` until the session is relaunched; the daemon persists its bound port and prefers it on the next start, and a session that genuinely cannot reach or authenticate gets an actionable error naming the exact recovery (`lazy builder --resume <id>`)
- **`lazy show` / `lazy view <session-id>` display captured builder conversations again** — with the daemon running, an unknown-task 404 propagated as a fatal "Task not found" instead of falling through to conversation resolution, so the `lazy builder list` hint never worked; ambiguous session-id prefixes are now disambiguated
- **`lazy_active` / `lazy_list` return each task's `status` and derived `substate`** — they returned only id/code/goal/model, so a builder could not tell what an active task was actually doing
- **`lazy pair` no longer dies with a raw ENOENT when a task's sandbox directory doesn't exist yet** — the pairing lock is created in the directory it actually lives in
- **Running a lazy command in a plain git repo says "not in a lazy project. Run `lazy init` first."** — it used to point at `lazy daemon start`, a dead end when there is no project for a daemon to bind to
- **Re-accepting an already-accepted task says so** — the ended-session check now runs before worktree recovery, instead of three fetch retries ending in "branch not found on remote"
- **Merge-conflict detection no longer false-positives on literal conflict markers in file content** — accept/merge checks now use `git merge-tree --write-tree` exit status instead of grepping merge output, so committed fixtures or docs containing those sequences can't spuriously block a merge

## [0.19.1078] - 2026-07-12 - Operator tooling, turn provenance, and reliability

This release sharpens day-to-day operation and observability of the daemon and task history. Operators get host-wide daemon tooling, runtime auto-budget control, and port-exhaustion hardening; turn history gains real provenance with a `builder` actor, supervisor-attributed sync turns, and an append-only task journal; and a batch of reconciler and accept-race fixes round out reliability.

### Added

- **Proxy policy rule engine (`[proxy.policy]`)** — deterministic deny-rules checked before a proposed `tool_use` runs, with inherited claude.ai `mcp__claude_ai_*` connectors denied by default (allowlist-only), secret/credential path reads denied, and an optional WebFetch egress allowlist; enforcement is on wherever `[proxy]` is set. See the security-posture section in the README
- **Anthropic-native passthrough proxy + Tier-1 audit plane (`[proxy]`)** — streams `/v1/messages` to the configured upstream and logs one audit record per request (model/tier, role and task, tool calls, status, duration); opt a role in with `backend = "proxy"`. See `[proxy]` in `lazy.toml`
- **Proxy smart routing** — on upstream 429/529 or unreachability, reroutes to a configured `[[proxy.fallback]]` chain instead of failing the turn
- **Task journal** — an append-only, prompt-immune side channel for orchestration metadata and design rationale
- **Custom container mounts (`[[mounts]]`)** — inject extra bind/volume mounts into task agent containers, e.g. a volume over `node_modules` to stop the host/container clobber
- **`lazy daemon auto-budget`** — inspect and adjust today's auto-react budget at runtime, plus pause/resume until local midnight
- **`lazy daemon list` / `kill-stray`** — see and safely reap stray daemons host-wide
- **Offline mode auto-expires at local midnight** — no more stranded-offline, with a permanent-offline flag for air-gapped setups
- **`builder` actor** — turns record who submitted them, distinguishing builder (MCP) from human (CLI)
- **`working(agent:answering)` substate** — read surfaces show when an agent is answering a `lazy ask` vs doing task work
- **`COLORTERM=truecolor` in default and task Dockerfiles** — terminal apps inside containers render colors correctly

### Changed

- **Sync turns are recorded by the reconciler and attributed to `supervisor`** — a no-op sync now leaves no turn at all
- **Daemon web-port bind fails with an actionable error** — instead of silently walking 100 ports it caps the window and points at `lazy daemon kill-stray`

### Fixed

- **Concurrent `lazy accept` no longer leaves a task `blocked` with its merge applied** — accept runs under a per-task lock so the merge happens exactly once
- **A started task's model can be changed durably** — `--model` on unblock/resume now persists, fixing the stale-model crash-loop
- **Accept's messaging about active children no longer misleads** — it states children are auto-reparented and no manual action is needed
- **Containers reach the daemon again on native Linux Docker** — the daemon also binds the docker bridge gateway after v0.18's loopback bind
- **A stranded completed response on an `interrupted` task is recovered** — routed through `working` so the finished work lands in `blocked` for review
- **Auto-resume no longer skips the upstream merge on a stale session lock** — `.lazy-lock` is excluded from the dirty-worktree check

## [0.18.1071] - 2026-06-18 - Automatic source maintenance, per-role model targets

The goal of this release is to prepare `lazy` to continue running the builder on Anthropic but to be able to switch agents to a different model through Ollama.

### Added

- **Chunked turn review across every surface** — reviewing "the latest turn" silently skips the intermediate turns that comment-driven auto-resumes, supervisor nudges, and syncs insert between two human turns, so an agent's earlier question or caveat is never seen. Turns can now be grouped into review chunks — each chunk starts at a genuine human/builder turn and absorbs every following agent, supervisor (`actor: 'supervisor'`), and system (`actor: 'system'`) turn until the next human/builder turn — on all four presentation surfaces: the MCP `lazy_show` `chunks` section, the CLI `lazy show --chunks` flag, the web dashboard task-detail view (grouped by default), and the review TUI (Turns nav grouped under chunk nodes, with a chunk overview pane). All surfaces share a single source of truth (`src/utils/turn-chunks.ts`) for the boundary rule — derived from the actor model (a `role: 'human'` turn whose actor is a real reviewer `human`/`builder`, or a legacy turn with no actor), with `auto_triggered` as a backstop for legacy auto-turns — and each surface exposes `actor`/`auto_triggered` provenance so automation turns are distinguishable from real human/builder turns. Presentation-only: no state, behavior, or storage changes. Independent of the not-yet-landed `builder-actor` task: the human-vs-builder label doesn't move boundaries. See `docs/spikes/chunked-turns.md`
- **Task-level follow-ups (`lazy_add_followup`)** — a durable, builder-triaged home for the genuinely *orthogonal* work an agent discovers while working a task (a different concern the task doesn't need to be correct and mergeable), replacing the interim "surface it in your summary" guidance. Follow-ups are a new task-level store (added to the Storage interface and implemented across FileStorage, Postgres, and the daemon RPC) — so unlike the removed turn-level proposals, they survive auto-turns and auto-resumes. The defining property is that recording one is **non-triggering**: it creates no comment, changes no task status, and writes no signal, so it can never kick off an auto-turn/auto-resume — which is precisely why follow-ups are a distinct store and not comments (comments feed the comment auto-react loop). Agents record them via the new MCP tool; they're surfaced everywhere comments are — `lazy_show`/`lazy show`, the web dashboard, and the review TUI — and indexed in search (`in:followups` / `has:followups`, plus a `--followups` filter); and the builder system prompt now has an explicit review-time triage step — fold back into scope, promote to a vetted task, or drop — so the backlog only ever receives builder-vetted tasks
- **Maintained-files automation (`[[automation.maintain]]`)** — the inverse of protected files: where `[permissions].protected` marks files agents must *not* touch, this new array-of-tables config (each entry a `title`, `pattern`, and `instructions`) marks files agents are *expected* to keep current — docs, CHANGELOG, architecture notes. Opt-in (empty by default) and enforced in two halves: an up-front context block appended to the agent's system prompt so it maintains those files while working, and a post-turn skip check that resumes the agent once to update — or justify skipping — any maintained pattern its commits didn't touch, recording the reply under a `## Maintained Files Review` heading for the reviewer. Skip detection is committed-only (mirrors `detectViolations`), so uncommitted edits correctly still nudge; protected-file violations take precedence and the nudge never produces a `conflict`; no-op turns are never nagged; the follow-up has a 10-minute watchdog. See `[[automation.maintain]]` in `docs/lazy-toml.md`
- **Per-role model targets (`[models.roles.builder]` / `[models.roles.agent]`)** — the interactive builder and task agents can now run against different Anthropic-native backends, so you can keep the builder on real Anthropic while task agents run on a local Ollama model (the motivating split). Each role table takes `backend = "anthropic" | "ollama" | "proxy"`, a `model`, and an optional `endpoint`; lazy never translates between API shapes. A single resolver replaces the model-selection logic that was previously duplicated across every launch site, and the legacy `[ollama]` block still works — it maps to "all roles → ollama" for backward compatibility. Guardrails are fail-hard per "least surprise": invalid/incomplete role config is rejected at load, each backend is preflighted for reachability before launch, and an unreachable or unresolvable backend fails with an actionable error **rather than silently falling back** to a different one. The resolved (not logical) model is recorded on the turn/task. See `[models.roles.*]` in `docs/lazy-toml.md`
- **Configurable chattiness for the builder and agents (`[chattiness]`)** — a new config section with a shared `default` plus optional `builder` / `agent` overrides, controlling conversational verbosity via a named ladder (`terse` / `normal` / `chatty`) injected near the top of the relevant system prompt. The wording is elastic: the configured level is the baseline, and an in-conversation "tell me more" / "be terser" steps exactly one rung for that one reply rather than jumping to an extreme, with deliberate headroom above `chatty`. Unset by default — no snippet is injected and existing users see no change; invalid values fail loudly naming the offending key and the valid levels
- **`lazy builder --model <id>`** — overrides the model the builder's own interactive Claude Code session runs as, so the builder can run on a newly released model that isn't yet selectable from Claude Code's in-conversation settings. An explicit `--model` is a hard override: it wins over a configured local model on every backend (including a local `[models.roles.builder]` ollama/proxy entry) while the backend + endpoint — the "server" — stay as configured, and exactly one `--model` ever reaches the child. A model the Anthropic API can't serve directly (any name that isn't `claude-*` or one of `haiku`/`sonnet`/`opus`/`fable`/`mythos`) is rejected up front when no local server is configured, with a message pointing at `[models.roles.builder]` — rather than failing opaquely at launch. Distinct from the per-task `--model` used when starting tasks
- **Working-substate visibility across read surfaces** — a `working` task used to render identically whether the agent was mid-turn, the supervisor was grinding through a long post-turn check, or the run had died, so a finished task was easily misdiagnosed as stranded. Lazy now derives three observable substates from the supervisor's `status.json` plus live run liveness — `working(agent)`, `working(harness:<phase>, <elapsed>)` (naming the running command, e.g. `post_turn_check cargo build (3m)`), and `working(not-alive)` — and surfaces them consistently in `list`/`blocked`/`active`, `show`/`view`, `status`, and `watch`. Purely observational: it never alters task state or transitions, and the more precise `working(not-alive)` supersedes the old `[CRASHED]` indicator. Nothing new is persisted — the substate is derived, not stored

### Changed

- **Builders no longer misread intentionally-nested tasks as mis-parented** — a new "stacked tasks" section in the builder system prompt documents that nesting one hub/umbrella task under another is deliberate stacking (so the child builds on the parent's not-yet-merged code), that accept auto-reparents still-active children onto the accepted task's target branch, and that tasks can never be orphaned thanks to two-layer protection (accept-time reparenting plus sync-time fallback up to `main`). The trigger was a real failure: a builder flagged the next release hub as "orphaned" and hesitated to accept. Prompt-only, framed in general hub/umbrella terms rather than lazy-internal release vocabulary
- **Supervisor push-back / maintained-files nudges are now their own full turns, not appended to the work response** — the protected-file push-back ("Permission Violation Review") and the maintained-files nudge ("Maintained Files Review") used to be run as in-session resumes and concatenated onto the work turn's result text, producing garbled, mashed-together turn responses. The supervisor now returns a **bundle of full responses** (one per `claude -p` invocation it ran — a protocol-version bump), and the daemon reconciler materializes each supervised follow-up as its OWN discrete turn pair: a `supervisor`-authored prompt turn plus the agent's reply turn (`turn_type = nudge`). The turn history reads cleanly — work turn → supervisor nudge → agent reply — and each supervised reply carries its **own token usage (including cache tokens), its own commits/diff (attributed by per-invocation SHA window, no double-count on the work turn), and its own re-detected violation set**. A new `supervisor` actor distinguishes these prompts from the human's across `lazy show`, the dashboard, and synthesis. File-violation resolution (accept/unblock) reads the FINAL re-detected set from the push-back turn, so a reviewer resolves exactly what the agent left unresolved

### Fixed

- **Agent prompts now teach scope discipline instead of steering agents to the dead `lazy_propose` mechanism** — the agent system prompts, tool-instructions, MCP server instructions, and the refactor/document task constraints used to tell agents to "propose follow-up tasks" via `lazy_propose`, but those proposals were never reviewed and never materialized into tracked work. That guidance is removed and replaced with a positive scope directive: deliver the natural, coherent, non-breaking unit of work, expanding in the obvious direction when that's what finishing the task requires, and never ship a fragment that breaks `main` while deferring the part that makes it work to a "follow-up." Creating subtasks with `lazy_create` (`parent`-scoped) is kept strictly for decomposing the task's OWN in-scope work; genuinely orthogonal discoveries are surfaced crisply in the final summary rather than spawned as backlog tasks (which only clutter the backlog). The `lazy_propose` tool itself is unchanged (still registered, existing proposals still readable); this is a prompt-only change that stops advertising it
- **Daemon TCP and web server now bind `127.0.0.1` by default** — the daemon's TCP listener serves the unauthenticated web dashboard plus the `/mcp` and `/rpc` endpoints, but `Bun.serve()` was called with no `hostname`, so it bound `0.0.0.0` (all interfaces), exposing the dashboard — and, one bearer token away, the full RPC/MCP surface — to anyone on the same LAN. It now binds loopback by default, with a new `[server] bind` key as the explicit opt-in for remote binding and a `logger.warn` whenever a non-loopback interface is used. The safe path is the default (closes the Fable architecture-review finding S2)
- **Daemon dashboard URLs now reflect the actual bind interface, not a hardcoded `localhost`** — every user-facing dashboard URL (`lazy daemon status`/`start`, `lazy server`, and the daemon's `Web dashboard:` log line) printed `http://localhost:<port>`, but the daemon binds its web server to `127.0.0.1` by default (the new `[server] bind` change). `localhost` can resolve to IPv6 `::1`, which does **not** reach an IPv4-only `127.0.0.1` bind, so a user opening the printed URL could get a "can't connect"/empty dashboard even though the daemon was healthy — and it was outright misleading once `[server] bind` pointed at a specific interface. The daemon now reports its bound interface via `/daemon/status` and all print sites route through a single `formatDashboardUrl` helper: a loopback or specific-interface bind is shown as-is, while a `0.0.0.0`/`::` (all-interfaces) bind collapses to `127.0.0.1` for local click-to-open convenience. The bound port was already reported correctly and is unchanged
- **Completed agent sessions no longer get stranded in `working`, and recovery now restores the agent's real report** — an agent could finish all its work and commit real code, yet the daemon never persisted the turn, recorded the commits, transitioned `working → blocked`, or fired the review notification, leaving the task stuck forever. A new reconciler recovery (`recoverStrandedCompletion`, plus a durable restart-surviving sweep) backfills the unrecorded commits from the branch and drives the canonical `working → blocked` transition — but only when the run is genuinely **not alive** and not mid-finalization (an authoritative liveness check plus an active-harness-phase guard keep it from stomping a turn that is still settling). Recovery also surfaces the agent's *actual* written report by reading the Claude Code session transcript (the supervisor runs in the container and can't reach Storage; the host reconciler reads the JSONL the harness already writes incrementally) instead of dropping a bare `[Recovered]` placeholder — and a timestamp watermark ensures it surfaces only transcript content newer than the last finalized turn, so a crashed report-less turn no longer resurfaces the *previous* turn's report misattributed to the current one
- **Builder conversations are now captured reliably, even across `/clear`, compaction, resume, and crashes** — `lazy builder list` was silently losing most builder sessions (one environment captured zero over 25 days; active repos showed "checkered" partial loss). Both capture paths assumed one builder run produced one Claude Code JSONL file, but the harness rolls to a new file on `/clear`, compaction, and resume, so every segment after the first was dropped — and a graceful-only final flush lost everything on a Ctrl-C, kill, or crash. Capture now records **every** session file belonging to a run, incrementally and with a signal-handled final flush. Underpinning this, each `lazy builder` invocation now gets its own isolated Claude `projects` dir (while `~/.claude` stays shared for credentials/settings), making session ownership **evidence-based** — any JSONL in the dir belongs to this run — which finally makes concurrent builders attributable on disk. The isolation is unconditional and self-healing (no config knob): it falls back to the shared dir with a warning when the dir can't be created or a legacy session must be resumed, and prunes stale dirs after 14 days
- **Builder resume targets the newest session segment after a `/clear`** — when a user ran `/clear` mid-session in a builder started with `lazy builder --resume <id>`, the resume-target detector kept stamping the *original* session UUID forever, because that file still exists on disk. The detector now picks the newest genuinely-new JSONL segment (the post-`/clear` tail) first, with `--resume <id>` demoted to a tiebreaker used only when no new segment has rolled; the existing hijack guard (a merely-touched neighbour can't win) is preserved
- **Builder no longer fails "Authentication required" when the daemon holds the credential** — `lazy builder` launches a credentialed daemon, but the builder *container* is spawned by the CLI **client** process, which in a daemon-only-credential deployment legitimately has no credential of its own — so the launch path's `getAuthEnvVars()` check against the client environment threw despite a healthy daemon. A new token-authenticated daemon RPC (`getAuthEnv`) routes the credential from where it actually lives (the daemon's environment) to the client launch path over the existing local socket; it is never logged or written to disk, and the daemon stays the single credential-enforcement point. The sibling host-path case (`runClaudeOneshot`, used by `lazy report` and the pair summarizer) was identified and filed separately rather than scope-crept here
- **MCP lifecycle tools no longer fail with "Daemon storage not initialized" during a pairing/builder session** — `lazy_start` (and its lifecycle siblings) called the in-daemon handler function directly, which obtains storage via `getOrCreateStorage()` — module state that only exists inside the daemon process, not in a local MCP process — so the call threw even though `lazy_create`, `lazy_comment`, and reads succeeded against the same daemon over RPC. The handlers now route through the same RPC-fallback layer the CLI already uses (`lazy_start`, `lazy_unblock`, `lazy_ask`, `lazy_accept`, `lazy_reject`, `lazy_close`, `lazy_stop`, `lazy_submit`, `lazy_resume`, `lazy_sync`, `lazy_reparent`): forward to the daemon over RPC when not in-daemon, fall back to the direct handler only under the daemon/test flags. This preserves the lazy-on-lazy subprocess elimination (it's an in-process RPC call, not a re-introduced subprocess spawn)
- **`lazy watch` shows agent output for host-runner tasks** — watch (and two other paths) showed only supervisor output for tasks on the host-process runner, because session-file discovery only looked under the Docker runner's in-container sandbox HOME, while the host runner writes its session JSONL under the real host HOME. Discovery is now driven by a new `agentSessionProjectDir(worktreePath)` on the `Runner` interface, so each runner is the single source of truth for where its agent writes — no "scan both dirs" branching. The same broken helper was silently failing the supervisor's graceful-exit session recovery and the `lazy loop` activity monitor (which also carried a duplicate sandbox-only copy with sync-fs calls); both now use the shared async discovery
- **Local-merge accept now pushes the parent and cleans up after itself** — accepting a child into an unprotected parent branch does a local squash-merge (no PR/MR), but the merged parent was never pushed to origin, so local `<parent>` (including `main` on an unprotected remote) sat permanently ahead of `origin/<parent>` and `lazy sync` then falsely reported "Already up to date" by resolving against the stale remote ref. Accept now pushes the merged parent to origin using the original remote driver (not the swapped-in `LocalDriver`), as a plain branch push — never a PR/MR — wrapped in `withRemoteRetry()` so it fails hard rather than silently degrading. Separately, two non-standard finalize paths (the daemon's zombie-accept sweep and the CLI external-merge detection) marked a task `complete` but skipped teardown, leaving ~80–95 stale local `lazy/*` branches and worktrees to accumulate; both now run the same safe cleanup the reconciler uses (gated on the authoritative accept tag / `MERGED` state, local branches only, remote refs untouched)
- **A dirty destination/parent worktree no longer blocks accept** — when the target parent branch was checked out in a separate worktree, the squash-merge hard-threw on *any* uncommitted changes there, a frequent annoyance when merging into `main` in multi-worktree setups. Accept now stashes the destination worktree's unrelated changes (tracked and untracked), performs the merge, and restores the stash, landing it in the same end state the clean-worktree path already produces — and never losing the human's work: a stash failure aborts early, a merge failure rolls back and pops the stash. If restoring the stash conflicts, accept still succeeds (the merge is durable) and a structured signal unblocks the destination's owning task — whose agent is available to reconcile — with feedback naming the preserved stash by SHA, rather than warning-and-continuing
- **`lazy_ask` (and `lazy review -i`'s ask) now works on `conflict` tasks, not only `blocked`** — `conflict` is a blocked-variant ("blocked, with a protected-file conflict to resolve") and an ask is read-only (plan-mode resume; no commits, no worktree changes), so there was no reason to reject it. Previously the ask path rejected conflict tasks with "Task X is 'conflict', not 'blocked'", forcing the reviewer to unblock just to ask a question. The ask now restores the task's pre-ask status on completion, so asking a `conflict` task leaves it in `conflict` (it never silently demotes to `blocked`)

## [0.17.1069] - 2026-06-01 - DX improvements and bug fixes

### Added

- **Interactive builder sessions auto-resume in place across `lazy upgrade`** — when `lazy upgrade` stops a running `lazy builder` container to rebuild the image (docker/podman), the host-side `lazy builder` process now waits for the rebuild to finish and relaunches the session **in the same terminal with the same conversation** via `claude --resume`, instead of leaving you to restart it by hand. The promise is "same conversation, same terminal, no manual `--resume`" — **not** zero data loss: a message you've typed into the builder but not yet submitted when the container is stopped cannot be preserved (Claude Code owns that input buffer and the upgrade passes the stop signal straight through). To mitigate that, `lazy upgrade` now prints a synchronous pre-stop warning for each live builder and waits for you to confirm you've submitted any in-progress message before stopping it; under `--force` or with no TTY the warning is printed but not blocked on, and unsent builder input may be lost. The handshake is carried by a durable, Storage-backed builder-resume-intent (it has to survive both the stopped container and the daemon restart, so the transient event plane can't carry it). If the relaunch can't complete (rebuild failure or timeout), the builder fails loudly and prints the exact `lazy builder --resume <id>` to run, so a session is never silently dropped. **Host-process builders are unaffected** — upgrade doesn't stop them, so there is nothing to relaunch. See `docs/spikes/builder-upgrade-resume.md` for the design and the verified mechanics
- **`lazy system status`** — a compact, scannable readout of the project's current system state. Headlines ONLINE vs OFFLINE (and when offline, surfaces the `enabled_at` timestamp, the suspended remote driver, and the `lazy system online` remedy), then shows the effective remote driver, git remote name, storage backend, daemon running/not, lazy version, and project root. Fills a real gap — offline mode silently forces `LocalDriver` (no fetch), which can make sync a no-op, and there was previously no way to see that the project was offline
- **New dashboard diff viewer** — the daemon's web dashboard renders task diffs through a real diff-rendering engine (`@pierre/diffs`) with unified and side-by-side views, replacing the previous ad-hoc renderer

### Changed

- **Blocking `spawnSync` removed from daemon/async hot paths** — synchronous subprocess spawns that ran on the daemon event loop (runners, drivers, capture, supervisor launch, git/version helpers) are converted to async `spawn`, so a wedged subprocess can no longer freeze the whole daemon (no RPC, no timers, no reconcile). Container **stop now uses `docker kill` (immediate SIGKILL) instead of `docker stop`** (SIGTERM + ~10s grace) — there is no graceful shutdown to wait for when terminating an agent container, and the blocking grace period was the leading suspect for a 90s `lazy stop` hang. Supervisor container launch gained a bounded timeout (default 5 min) that aborts with an actionable error naming the binary instead of hanging indefinitely. Remaining `spawnSync` calls are confined to CLI startup/preflight and interactive TTY handoffs, each with a justifying comment
- **`lazy server` is now a thin daemon-dashboard alias** — the undocumented standalone/`--port` server mode is gone. `lazy server` ensures the daemon is running and prints the daemon-served dashboard URL, then exits; it no longer opens a second storage path or blocks. The `--port` flag and "standalone mode" framing (already daemon-backed and misleading) were removed, along with the dead `startServer()` path; the daemon's own web server is unchanged

### Fixed

- **`lazy sync` no longer silently merges a stale/local parent ref instead of the live remote upstream** — a `git fetch` regression made the remote drivers' `resolveUpstreamRef` resolve the merge target from a stale local `origin/<parent>` tracking ref (or the bare local branch), so `lazy sync` could report "Already up to date" even when the real remote parent had moved on — and `lazy accept` then failed with "MR has merge conflicts" that no local sync could reconcile. Sync now fetches the live remote before resolving `<remote>/<parent>`, so it merges the current upstream; per "fail hard on remote failures," a fetch failure surfaces (the task is marked for retry) rather than degrading to a stale-ref merge. A latent silent `catch {}` fallback to the local ref on the task-launch path was removed too (it now throws unless `--force-local`)
- **Accept/submit local-merge into unprotected parent branches instead of opening an MR against `main`** — for a child task whose lazy parent is an intermediate branch (e.g. `lazy/release-v017`), accept/submit used to open a remote MR/PR **targeting `main`**, because the drivers' `targetBranch()` silently rewrote a `lazy/`-prefixed target to the default branch. GitLab/GitHub then evaluated conflicts against the wrong base (the child is behind `main` via its parent), the MR was "unmergeable," and `lazy sync` — correctly reconciling against the lazy parent — reported "Already up to date," leaving the two evaluating different bases. Accept now does a **local git merge** into an unprotected parent branch and opens no remote MR; the remote MR path runs only when merging into a protected branch. The `lazy/`→`main` retarget fallback was removed from both drivers — an MR, if ever created, targets the actual parent/integration branch and never silently retargets to `main`. Upholds the "PRs only for protected branches" and "subtask→parent merges are local" invariants

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
