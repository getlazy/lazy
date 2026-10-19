# CLI reference

Every `lazy` command, generated from the usage text each command prints for `--help`.

| Command | Summary |
| --- | --- |
| [`lazy accept`](accept.md) | Accept a task's work and merge it into the appropriate branch. |
| [`lazy active`](active.md) | List unfinished tasks that have been started (working, blocked, submitted, interrupted, ...). |
| [`lazy artifact`](artifact.md) | Attach files to a task, and retrieve files a task published back. |
| [`lazy ask`](ask.md) | Ask a question and print the answer. |
| [`lazy auth`](auth.md) | Store this project's model credentials in OS secure storage, so the daemon no longer depends on the shell it was started from. |
| [`lazy blocked`](blocked.md) | List tasks waiting on a person: blocked, conflict or submitted. |
| [`lazy branch`](branch.md) | Create a child task branching from a parent task's current state and start it immediately. |
| [`lazy browse`](browse.md) | Browse a task's artifacts. |
| [`lazy builder`](builder.md) | Launch an interactive Claude Code session with Lazy builder instructions. |
| [`lazy chat`](chat.md) | Interactive, read-only chat with a task's agent — ask it what it did and why. |
| [`lazy clone`](clone.md) | The second form clones a project hosted on a Lazy Teams install and binds the clone to it in one step, logging this machine in first if it is not already (see lazy login --help; --device and --device-name work as they do there). |
| [`lazy close`](close.md) | Close a task — stop work and mark it as abandoned. |
| [`lazy comment`](comment.md) | Add a freeform comment/annotation to a task, or edit one the agent has not seen yet. |
| [`lazy completion`](completion.md) | Output shell completion script to stdout. |
| [`lazy config`](config.md) | Runtime configuration toggles for lazy. |
| [`lazy conversations`](conversations.md) | Browse Builders — the reasoning and decisions from past builder sessions, stored automatically alongside task data. |
| [`lazy create`](create.md) | Create a new task. |
| [`lazy customize`](customize.md) | Scaffold a project-local customization against one of lazy's extension seams. |
| [`lazy customize proxy-plugin`](customize-proxy-plugin.md) | Scaffold a proxy request plugin into .lazy/plugins/. |
| [`lazy daemon`](daemon.md) | Manage the lazy daemon process. |
| [`lazy daemon auto-budget`](daemon-auto-budget.md) | Runtime control + visibility for the daemon's auto-react daily budget. |
| [`lazy daemon config`](daemon-config.md) | Runtime control + visibility for the daemon's builder concurrency cap ([limits] max_concurrent_builders in lazy.toml) and the usage pause ([usage_pause] in lazy.toml). |
| [`lazy daemon health`](daemon-health.md) | Check whether the running daemon's moving parts are alive — the things that can stop working without the daemon itself crashing: |
| [`lazy daemon logs`](daemon-logs.md) | Tail the daemon log file. |
| [`lazy daemon reload`](daemon-reload.md) | Re-read the lazy.toml the daemon is using and apply the startup-only settings that can change without a restart — [server] dashboard_url (links, sign-in and `lazy dashboard` use the new address) and [server] sync_interval. |
| [`lazy daemon resume-queue`](daemon-resume-queue.md) | Read-only: show the slow-lane auto-resume queue — tasks whose fast-lane circuit breaker tripped (repeated crashes) and are now waiting for a round-robin retry. |
| [`lazy dashboard`](dashboard.md) | Sign in to this project's web dashboard and open it in your browser. |
| [`lazy describe`](describe.md) | Write a linked task's description from its branch and pull request. |
| [`lazy diff`](diff.md) | Show changes made by a task relative to its upstream branch. |
| [`lazy doctor`](doctor.md) | Check the health of your lazy installation, or diagnose a specific task. |
| [`lazy document`](document.md) | Create a documentation task. |
| [`lazy edit`](edit.md) | Edit a task's goal, prompt, model, type, code, parent, runner, effort, agent, or review mode. |
| [`lazy env`](env.md) | Per-task environment variables — give ONE task an API token or endpoint without exposing it to every other task. |
| [`lazy env clear`](env-clear.md) | Remove every environment variable from a task. |
| [`lazy env list`](env-list.md) | List the names of a task's environment variables. |
| [`lazy env ls`](env-ls.md) | List the names of a task's environment variables. |
| [`lazy env rm`](env-rm.md) | Remove named environment variables from a task. |
| [`lazy env set`](env-set.md) | Give one task an environment variable. |
| [`lazy env unset`](env-unset.md) | Remove named environment variables from a task. |
| [`lazy fix`](fix.md) | Create a debugging/fix task with experimental debugging methodology. |
| [`lazy forward`](forward.md) | Reach a port inside a running task's container from this machine, for as long as this command runs. |
| [`lazy import-conversation`](import-conversation.md) | Import Claude Code conversation logs as development context. |
| [`lazy init`](init.md) | Initialize lazy in the current git repository. |
| [`lazy journal`](journal.md) | Read or append to a task's journal — an append-only side channel that never triggers a turn and whose text is never injected into an agent prompt. |
| [`lazy link`](link.md) | Link a pull request or a git branch as a lazy task. |
| [`lazy list`](list.md) | List all non-terminal tasks (every status except complete and abandoned). |
| [`lazy login`](login.md) | Log this machine in to a Lazy Teams install. |
| [`lazy logout`](logout.md) | lazy logout <teams-url>   Log this machine out of that install: delete its token and remove the git config entry lazy login added. |
| [`lazy loop`](loop.md) | Two modes, one review gate. |
| [`lazy memory`](memory.md) | Manage lazy-owned shared memory — small, named records of curated cross-task knowledge. |
| [`lazy messages`](messages.md) | Your inbox of system messages — proactive reports lazy wrote for you: scheduled analyses (post-mortems, tool-call patterns, token usage), daemon notices, and other findings. |
| [`lazy pair`](pair.md) | Open an interactive agent session, context-aware. |
| [`lazy playground`](playground.md) | Provision a throwaway lazy project with a real daemon and tasks in every state, so agents and humans can exercise the dashboard, the review surfaces, the CLI and Lazy Teams without touching a real project. |
| [`lazy protect`](protect.md) | Manage branch protection — which merges require a HUMAN approval (the passphrase typed at 'lazy accept''s own prompt). |
| [`lazy raised`](raised.md) | Everything agents raised for a human, across every task — one queue, one flag. |
| [`lazy redo`](redo.md) | Close a stale task and restart the same work on a fresh branch. |
| [`lazy refactor`](refactor.md) | Create a refactoring task. |
| [`lazy regions`](regions.md) | Show a task's review regions — the walkthrough it filed with its report (presentation.groups), with an "Other changes" region for anything no group claimed. |
| [`lazy reject`](reject.md) | Reject a task's work and close its PR, if it has one (no comment is posted). |
| [`lazy reopen`](reopen.md) | Reopen a previously abandoned or accepted (complete) task. |
| [`lazy reparent`](reparent.md) | Repoint a task to a new parent and merge that parent into the task's branch. |
| [`lazy report`](report.md) | Print an LLM-summarized markdown digest of recent activity to stdout. |
| [`lazy resume`](resume.md) | Resume a task with NO new feedback — writes a command for the supervisor and launches a container if needed. |
| [`lazy revert`](revert.md) | Revert an accepted task by creating a revert task. |
| [`lazy review`](review.md) | Run an agent review of a task's work. |
| [`lazy rework`](rework.md) | Create a follow-up task to rework previously accepted work. |
| [`lazy scratch`](scratch.md) | Read the builder scratch sandbox. |
| [`lazy search`](search.md) | Search across tasks, prompts, turns, commits, notes, raised items, conversations, and shared memory records. |
| [`lazy shell`](shell.md) | Open an interactive shell in a task's CONTAINER — the same environment the agent works in, with its toolchain — or run a one-off command there. |
| [`lazy show`](show.md) | Show detailed information about a task, conversation, or file. |
| [`lazy start`](start.md) | Start an existing task. |
| [`lazy stats`](stats.md) | Read-only analytics over what lazy recorded. |
| [`lazy stats audit`](stats-audit.md) | Browse the proxy audit trail one record per proxied request — the record-level view of the same trail `lazy stats tokens` rolls up. |
| [`lazy stats budget`](stats-budget.md) | The token budgets in play. |
| [`lazy stats latency`](stats-latency.md) | How fast the models answered, per endpoint × model (× tier). |
| [`lazy stats limits`](stats-limits.md) | The latest usage-limit reading per credential, as the lazy proxy saw it on model API responses: subscription utilization (5-hour and 7-day windows), API-key rate-limit headroom, and retry-after on refusals. |
| [`lazy stats timings`](stats-timings.md) | Show recorded request traces ranked by SELF TIME — the time a span spent on its own work, with its children's time removed. |
| [`lazy stats tokens`](stats-tokens.md) | Token accounting from the proxy audit trail. |
| [`lazy stats tools`](stats-tools.md) | Which tool filled a task's context. |
| [`lazy status`](status.md) | Show the current status of a task including worktree state, commits, and uncommitted changes. |
| [`lazy stop`](stop.md) | Halt a running task without auto-resume. |
| [`lazy submit`](submit.md) | Submit a task for review by creating or updating a pull request. |
| [`lazy sync`](sync.md) | Reconcile a task's worktree, by task ID, with everything it is behind — in two steps, each narrated as it happens. |
| [`lazy system`](system.md) | Inspect and prebuild Lazy system internals, and toggle project-wide modes. |
| [`lazy system agent`](system-agent.md) | See which agent PROFILES are ready and switch the project's default. |
| [`lazy system build`](system-build.md) | Prebuild a lazy system image, bypassing the current project's lazy.toml. |
| [`lazy system eject-dockerfile`](system-eject-dockerfile.md) | Write the embedded default Dockerfile (used to build agent containers) to disk so you can customize it. |
| [`lazy system export-dockerfile`](system-export-dockerfile.md) | Write the embedded default Dockerfile (used to build agent containers) to disk so you can customize it. |
| [`lazy system guest-init-script`](system-guest-init-script.md) | Write the lazy-guest-init script this lazy carries to the run directory and print its path. |
| [`lazy system machine`](system-machine.md) | What the project's machine is doing: the container runtime, the port forwarder (Lazy Teams machines only), the project daemon and its task proxy, and CPU, memory and disk use. |
| [`lazy system offline`](system-offline.md) | Enable offline mode for this project. |
| [`lazy system online`](system-online.md) | Disable offline mode and restore remote operations (push, fetch, sync, PR creation). |
| [`lazy system passphrase`](system-passphrase.md) | Manage the approval passphrase that `lazy accept` asks for when a merge crosses a protected branch or task. |
| [`lazy system repair-commits`](system-repair-commits.md) | Fix recorded commit lists that name commits the task never made. |
| [`lazy system runner-image`](system-runner-image.md) | The project's own runner image ([docker] dockerfile in lazy.toml) is built by the daemon when it starts. |
| [`lazy system source-id`](system-source-id.md) | Print the identity of a lazy source tree — a content fingerprint of the code that decides what a daemon actually runs. |
| [`lazy system status`](system-status.md) | Print the current system state for this project: offline/online mode, remote driver, git remote, storage backend, daemon, and lazy version. |
| [`lazy system store-backup`](system-store-backup.md) | Save a lazy store as one compressed archive (store.tar.gz) in <store>.backups/ beside it, verify it (the archive read back and every file compared by size and sha256), and keep the newest verified ones. |
| [`lazy system store-backups`](system-store-backups.md) | List a store's backups, newest first: when, which upgrade, size, and where. |
| [`lazy system store-check`](system-store-check.md) | Report what a lazy store directory holds, without opening it: its schema version, whether anything is holding its lock, how many tasks it has, and which actor ids its rows carry. |
| [`lazy system store-restore`](system-store-restore.md) | Put a verified backup back. |
| [`lazy tag`](tag.md) | Add one or more tags to a task for lightweight, non-hierarchical grouping. |
| [`lazy unblock`](unblock.md) | Unblock a task by providing feedback, or interactively review and act on it. |
| [`lazy untag`](untag.md) | Remove one or more tags from a task. |
| [`lazy upgrade`](upgrade.md) | Rebuild the Docker image and agent binary, then restart the daemon. |
| [`lazy url`](url.md) | Show where a task's declared [serve] ports are reachable on this machine. |
| [`lazy wait`](wait.md) | Block until a task transitions from 'working' to another status (blocked, complete, interrupted). |
| [`lazy watch`](watch.md) | Watch a task in real-time as a unified timeline. |
