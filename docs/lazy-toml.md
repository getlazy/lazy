# lazy.toml Configuration Reference

`lazy.toml` is the project-level configuration file for Lazy. It lives at the root of your git repository and is created by `lazy init`.

You can override the config filename with the `LAZY_CONFIG` environment variable (e.g., `LAZY_CONFIG=lazy.lima.toml lazy list`). If `LAZY_CONFIG` is an absolute path, it is used directly; otherwise lazy walks up from the current directory looking for the file. Worktrees can carry their own `lazy.toml` this way.

If `LAZY_CONFIG` is set but points to a file that doesn't exist, lazy fails hard rather than silently falling back to defaults.

---

## `[models]`

Controls which AI model agents use by default.

| Key       | Type     | Default                         | Description |
|-----------|----------|---------------------------------|-------------|
| `default` | `string` | `"claude-sonnet-4-5-20250929"` | Default model for sessions. |

Values are raw model IDs — examples: `"claude-sonnet-4-5-20250929"`, `"claude-opus-4-7"`, `"qwen3.5:35b-a3b-coding-nvfp4"`.

```toml
[models]
default = "claude-opus-4-7"
```

### `[models.roles.*]` — per-role model targets

Lazy distinguishes two model **roles**: the interactive **builder** (`lazy builder`, `lazy pair`, `lazy chat`) and the **agent** that runs tasks (the task supervisor and all auto-triggered turns). The `[models.roles.builder]` and `[models.roles.agent]` tables let each role run against a different **backend**, so you can — for example — keep the builder on real Anthropic while task agents run on a local Ollama model.

| Key        | Type     | Default       | Description |
|------------|----------|---------------|-------------|
| `backend`  | `string` | `"anthropic"` | One of `"anthropic"`, `"ollama"`, or `"proxy"`. All three are Anthropic-native targets — lazy never translates between API shapes. |
| `model`    | `string` | `""`          | Model passed to the agent via `--model`. **Required** for `ollama`/`proxy`. For `anthropic`, an empty value means "use the normal model chain / `models.default`". |
| `endpoint` | `string` | see below     | `ANTHROPIC_BASE_URL` for the backend. **Required** for `proxy`. For `ollama` it defaults to `http://host.docker.internal:11434`. Ignored for `anthropic`. |

**Backends:**

- `anthropic` — the real Anthropic API (whatever `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` point at). This is the default for any role you don't configure.
- `ollama` — a local Ollama instance serving the Anthropic Messages API. Lazy injects dummy credentials and the base URL automatically; the configured `model` is authoritative.
- `proxy` — an Anthropic-compatible proxy endpoint, forwarded with your real Anthropic credential plus the configured `endpoint` as the base URL.

**How a role resolves to a backend** (precedence, highest first):

1. An explicit `[models.roles.<role>]` table.
2. The legacy `[ollama]` block (see [`[ollama]`](#ollama)), which maps to **all roles → ollama** when enabled.
3. The `anthropic` default — i.e. `models.default` / the normal model chain.

For the `anthropic` backend, an explicit `--model` flag, the previous turn's sticky model, or the task's model still take precedence over `models.default` as before. For `ollama`/`proxy` the configured `model` is **authoritative and never silently substituted** — a logical alias like `"claude-opus-4-8"` does not exist in those registries, so it is intentionally ignored. (Local backends only work through the Claude Code agent; any other agent forces the `anthropic` path regardless of config.)

**Guardrails (fail hard, no silent fallback):**

- Invalid `backend`, or an `ollama`/`proxy` role missing its `model` (or a `proxy` role missing its `endpoint`), is rejected at config load with an actionable error.
- Before every launch lazy **preflights** the role's backend for reachability. If a local backend is unreachable, the launch fails with an actionable error — lazy **never** silently falls back to a different backend.
- Unresolvable model names surface loudly (e.g. Ollama's `404 model not found`) rather than being quietly swapped.

```toml
[models]
default = "claude-opus-4-7"

# Builder talks to real Anthropic; task agents run on a local Ollama model.
[models.roles.builder]
backend = "anthropic"
model = "claude-opus-4-8"

[models.roles.agent]
backend = "ollama"
model = "qwen3.5:35b-a3b-coding-nvfp4"
endpoint = "http://host.docker.internal:11434"
```

---

## `[session]`

Controls session-level behavior and logging.

| Key                        | Type   | Default | Description |
|----------------------------|--------|---------|-------------|
| `verbose`                  | `bool` | `false` | Show Docker output in real-time during session execution. |
| `debug`                    | `bool` | `false` | Extra logging for troubleshooting. |
| `auto_commit_instructions` | `bool` | `true`  | Include commit guidelines in prompts sent to the agent. |

```toml
[session]
verbose = true
debug = false
auto_commit_instructions = true
```

---

## `[data]`

Controls where the `.lazy` directory lives.

| Key    | Type     | Default   | Description |
|--------|----------|-----------|-------------|
| `path` | `string` | `".lazy"` | Location of the `.lazy` directory. |

---

## `[storage]`

Controls where Lazy persists task state (tasks, sessions, turns, commits, comments).

| Key             | Type     | Default      | Description |
|-----------------|----------|--------------|-------------|
| `backend`       | `string` | `"external"` | Storage backend: `"external"` or `"postgres"`. |
| `external_path` | `string` | `""`         | Path for external storage. Defaults to `~/.lazy/<project-name>` if empty. Leading `~/` is expanded at load time. |
| `postgres_ssl`  | `bool`   | `false`      | Enable SSL/TLS for PostgreSQL connections (required for cloud databases like Neon, Supabase). |

```toml
[storage]
backend = "external"
external_path = "~/.lazy/my-project"
```

For PostgreSQL, configure the connection via `LAZY_POSTGRES_URL` or standard `PG*` environment variables (`PGHOST`, `PGDATABASE`, etc.).

The legacy `"in-repo"` and `"orphan-branch"` backends have been removed; lazy fails hard if it sees them and prints migration guidance.

---

## `[git]`

Git-related configuration.

| Key                     | Type     | Default  | Description |
|-------------------------|----------|----------|-------------|
| `default_branch_prefix` | `string` | `"lazy"` | Prefix for task branches (e.g., `lazy/fix-bug`). |

---

## `[output]`

Controls CLI output formatting.

| Key              | Type     | Default | Description |
|------------------|----------|---------|-------------|
| `shortid_length` | `number` | `8`     | Length of shortened IDs displayed in output. |

---

## `[agent]`

Agent configuration for task execution.

| Key                          | Type     | Default         | Description |
|------------------------------|----------|-----------------|-------------|
| `agent_id`                   | `string` | `"claude-code"` | Default agent for task execution. Validated against the agent registry at load time; unknown values are rejected. |
| `watchdog_output_timeout_ms` | `number` | `7200000`       | Kill the agent process if it produces no output for this many ms. `0` = use agent default. Default is 2 hours. |
| `effort`                     | `string` | `"medium"`      | Reasoning effort level passed to Claude Code via `--effort` for task agents. Valid: `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"`. Higher levels spend more tokens thinking before responding. |

```toml
[agent]
agent_id = "claude-code"
watchdog_output_timeout_ms = 3600000  # 1 hour
effort = "medium"
```

---

## `[builder]`

Builder session configuration. Builder sessions handle orchestration and planning across tasks.

| Key      | Type     | Default  | Description |
|----------|----------|----------|-------------|
| `effort` | `string` | `"high"` | Reasoning effort level passed to Claude Code via `--effort` for builder sessions. Valid: `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"`. |

```toml
[builder]
effort = "high"
```

---

## `[chattiness]`

Baseline conversational verbosity for the builder and agents — how much they narrate, explain, and elaborate in their replies. This controls *communication style only*, not how hard the model thinks (that is `effort`).

| Key       | Type     | Default | Description |
|-----------|----------|---------|-------------|
| `default` | `string` | unset   | Shared baseline applied to both the builder and agents. Valid: `"terse"`, `"normal"`, `"chatty"`. |
| `builder` | `string` | unset   | Per-role override for builder sessions. Falls back to `default` when omitted. |
| `agent`   | `string` | unset   | Per-role override for task agents. Falls back to `default` when omitted. |

When a role's effective level is unset (no `default` and no per-role value), **no verbosity guidance is injected** and behavior is unchanged from before this setting existed.

The injected guidance is **elastic, not binary**: the configured level is the baseline, and when you ask for more detail the model steps up *one notch* from that baseline for that reply — not straight to maximum verbosity. At a `terse` baseline, "tell me more" yields a normal-length explanation, not an exhaustive essay. The guidance is placed near the top of the system prompt so it gets the model's attention.

Invalid levels are rejected at config-load time, listing the valid levels.

```toml
[chattiness]
# Shared baseline for both roles
default = "normal"
# Optional per-role overrides
builder = "chatty"
agent = "terse"
```

---

## `[server]`

Web dashboard server settings.

| Key             | Type     | Default       | Description |
|-----------------|----------|---------------|-------------|
| `port`          | `number` | `26024`       | Starting port for the web dashboard server. If busy, the daemon tries the next few ports (a bounded window of 20) so several projects can run on one host. If the whole window is occupied — almost always stray daemons squatting the range — startup fails with an actionable error pointing at `lazy daemon kill-stray` rather than silently binding a far-off port. |
| `bind`          | `string` | `"127.0.0.1"` | Network interface the daemon's TCP server binds to. Loopback by default so the unauthenticated dashboard and the `/mcp` + `/rpc` endpoints are not reachable from other machines. Set to `"0.0.0.0"` to expose on all interfaces (opt-in to LAN access — the dashboard is unauthenticated, so the daemon logs a warning). The dashboard URL printed by `lazy daemon status`/`lazy server` reflects this value; a `0.0.0.0` bind is shown as `127.0.0.1` for local convenience. |
| `sync_interval` | `number` | `60`          | Interval in seconds for background sync when running `lazy server`. Set to `0` to disable. |

**Native Linux Docker note:** When `bind` is left at the loopback default and a container runner (`docker`/`podman`) is configured, on Linux the daemon *additionally* binds the detected docker/podman bridge gateway (`docker0`, typically `172.17.0.1`) on the same port. This is required because containers reach the host via `host.docker.internal` → the bridge gateway (a non-loopback interface), which a loopback-only daemon would refuse. The bridge interface is host-local and reachable only from the container network — **not** routable from the LAN — so it does not widen LAN exposure. macOS/Windows Docker Desktop need nothing extra (`host.docker.internal` is proxied to the host's loopback). If you set `bind` explicitly, that value is used as-is with no extra interfaces; if the bridge can't be detected on Linux the daemon logs an actionable warning rather than letting agents fail to reach it.

---

## `[runner]`

Controls how agent containers are executed.

Can also be specified as a top-level string for backward compatibility (e.g., `runner = "docker"`), which lazy translates into `[runner] type = "..."` at load time and warns about.

| Key    | Type     | Default    | Description |
|--------|----------|------------|-------------|
| `type` | `string` | `"docker"` | Runner type: `"docker"`, `"podman"`, or `"dangerously-host-process-without-any-isolation"`. |

Docker and Podman modes run agents in isolated containers. Host-process mode runs agents directly on the host — use **only** in VMs or other already-isolated environments.

```toml
[runner]
type = "docker"
```

---

## `[remote]`

Remote integration for push, PR/MR creation, and comment syncing.

| Key            | Type     | Default    | Description |
|----------------|----------|------------|-------------|
| `driver`       | `string` | `"local"`  | Remote driver: `"local"`, `"github"`, or `"gitlab"`. |
| `git_remote`   | `string` | `"origin"` | Git remote name. Change if your remote is named differently. |
| `auto_approve` | `bool`   | `false`    | If `true`, `lazy accept` on a protected target branch submits an approving review before merging. See behavior notes below. |
| `offline`      | `bool`   | `false`    | Permanent offline mode. If `true`, all remote operations (push, fetch, sync, PR creation) are skipped **indefinitely**. See offline modes below. |

### Offline modes

There are two ways to be offline, with deliberately different lifetimes:

- **Temporary — `lazy system offline`** (the command). Records an expiry at the **next local midnight** and auto-recovers: once that instant passes, lazy is online again and the daemon resumes remote ops, with no manual `lazy system online`. This prevents the common failure of forgetting to come back online and silently staying stranded. The expiry/countdown is always shown by the command, `lazy system status`, `lazy doctor`, and `lazy config get offline` (e.g. `OFFLINE — auto-resumes in 6h (00:00 local)`). Run `lazy system online` to restore remote ops sooner.

- **Permanent — `offline = true`** (this config flag). For projects that genuinely want to stay offline (air-gapped, Ollama-only, etc.). It is **not** subject to the midnight auto-expiry — it stays in effect until you remove the flag. `lazy system online` will **not** clear it (it never rewrites your `lazy.toml`); remove `offline = true` from `[remote]` to go back online.

### `auto_approve` on protected branches

When the target branch (usually `main`) has protection rules requiring approval, the accept path has two modes:

- **`auto_approve = false` (default)**: lazy requires an *external* approval to exist on the PR/MR before merging. Without one, `lazy accept` fails with a `409` and tells you to run `lazy submit` and wait for review.
- **`auto_approve = true`**: lazy submits its own approving review immediately before evaluating the merge gates, and skips the `reviews` gate when computing whether the accept is blocked (because the approval may not have propagated through the forge API yet). This is aimed at sole developers who don't want to manually approve their own MRs. It does **not** bypass other gates (CI checks, unresolved threads, merge conflicts) — those still block the accept.

Use `auto_approve = true` only when self-approval is acceptable by your team and forge policy.

### GitHub-specific options

Available when `driver = "github"`. Authentication is handled by `gh` CLI (`gh auth login`).

| Key                | Type   | Default | Description |
|--------------------|--------|---------|-------------|
| `github_auto_push` | `bool` | `true`  | Automatically push after each agent turn. |
| `github_dangerously_sync_comments_in_public_repos_and_open_yourself_to_prompt_injection` | `bool` | `false` | Sync PR comments in public repos. **Security risk** — enables prompt injection via public comments. |

### GitLab-specific options

Available when `driver = "gitlab"`. Authentication is handled by `glab` CLI (`glab auth login`).

| Key                | Type   | Default | Description |
|--------------------|--------|---------|-------------|
| `gitlab_auto_push` | `bool` | `true`  | Automatically push after each agent turn. |
| `gitlab_dangerously_sync_comments_in_public_repos_and_open_yourself_to_prompt_injection` | `bool` | `false` | Sync MR comments in public repos. **Security risk** — enables prompt injection via public comments. |

```toml
[remote]
driver = "github"
git_remote = "origin"
auto_approve = false
# offline = true   # stay offline permanently (no midnight auto-expiry)
github_auto_push = true
```

The driver-specific keys (`github_*`, `gitlab_*`) are always valid at the schema level — lazy won't warn about GitHub keys while you're temporarily using the `local` driver.

The legacy `[remote_github]` section is no longer supported; lazy fails hard if it sees one and tells you to move the keys under `[remote]` with a `github_` prefix.

---

## `[docker]`

Docker image configuration for agent containers.

| Key          | Type     | Default | Description |
|--------------|----------|---------|-------------|
| `dockerfile` | `string` | `""`    | Path to a custom Dockerfile (relative to project root). If empty, lazy uses the base image (Ubuntu with Claude Code + passwordless sudo). Agents install what they need via `apt-get`. |

```toml
[docker]
dockerfile = "Dockerfile.lazy"
```

---

## `[ollama]`

Use a local Ollama instance for model inference instead of Anthropic's API. Requires Ollama v0.14+ running on the host with the Anthropic Messages API enabled.

> **Legacy / backward compatibility.** When `enabled = true`, this block maps to **all roles → ollama** (both the builder and task agents). It is kept so existing configs keep working. For finer-grained control — e.g. the builder on Anthropic and agents on Ollama, or a `proxy` backend — prefer the per-role [`[models.roles.*]`](#modelsroles--per-role-model-targets) tables, which override this block for any role they set.

| Key        | Type     | Default                              | Description |
|------------|----------|--------------------------------------|-------------|
| `enabled`  | `bool`   | `false`                              | Route agent inference through Ollama. |
| `model`    | `string` | `""`                                 | Model name passed to the agent via `--model` (e.g., `"qwen3.5:35b-a3b-coding-nvfp4"`). Required when `enabled = true` — lazy rejects the config at load time if it's empty. |
| `endpoint` | `string` | `"http://host.docker.internal:11434"`| Ollama API endpoint. The default assumes agents run inside Docker and need to reach Ollama on the host — `host.docker.internal` resolves to the host from inside the container. On Linux hosts this may require `--add-host=host.docker.internal:host-gateway` or a direct host IP. |

```toml
[ollama]
enabled = true
model = "qwen3.5:35b-a3b-coding-nvfp4"
endpoint = "http://host.docker.internal:11434"
```

---

## `[documents]`

Mount additional documents into agent containers.

| Key    | Type     | Default | Description |
|--------|----------|---------|-------------|
| `path` | `string` | `""`    | Path to a directory of documents to mount into the agent container. |

---

## `[[mounts]]`

Custom mounts injected into **task agent containers** (the worktree containers where agents run; the builder container is not affected). Array of tables — each entry is either a host **bind** mount or a container-local **volume**. Opt-in: none by default, and with no `[[mounts]]` configured container launch is exactly as before.

The motivating case: the worktree (including its `node_modules`) is bind-mounted into the container, so container-installed Linux binaries fight the host's macOS ones. Shadowing `{worktree}/node_modules` with a volume gives the container its own `node_modules` that never clobbers the host's (Docker resolves overlapping mounts by longest container-path match, so the inner volume wins regardless of declaration order).

Each entry's keys:

| Key        | Type      | Default  | Description |
|------------|-----------|----------|-------------|
| `type`     | `string`  | `"bind"` | `"bind"` mounts a host path; `"volume"` uses a container-local Docker volume. |
| `source`   | `string`  | —        | Host path for bind mounts. Absolute, or project-relative (resolved against the repo root). Required for bind; invalid for volume. |
| `name`     | `string`  | —        | Volume name for a **named** volume (persists/reused across runs). Omit for an **anonymous** volume. Only valid for `type = "volume"`. |
| `target`   | `string`  | —        | Absolute container path to mount at. Required. |
| `readonly` | `boolean` | `false`  | Mount read-only. |

**Placeholders** (expanded at launch time) are supported in `source` and `target`:

| Placeholder  | Expands to |
|--------------|------------|
| `{worktree}` | The task's worktree path. |
| `{repo}`     | The repo root. |

Invalid entries fail loudly at config-load time with a message naming the offending entry (missing `target`, unknown `type`, a bind with no `source`, a volume that sets `source`, etc.) — they are never silently skipped.

```toml
# Bind a host path into the container
[[mounts]]
source = "/abs/or/project-relative/host/path"
target = "/absolute/container/path"
readonly = false

# Shadow a worktree path with a container-local named volume (the node_modules case)
[[mounts]]
type = "volume"
name = "myproj-node-modules"   # omit for an anonymous volume
target = "{worktree}/node_modules"
```

---

## `[features]`

Feature flags for experimental functionality. Accepts arbitrary key-value pairs — lazy does not warn about unknown keys here.

Set individual flags to `true`/`false`, or use `all = true` to enable everything. Use `LAZY_VANILLA=1` env var to disable all flags temporarily.

```toml
[features]
auto_sync_after_turn = true
# all = true
```

---

## `[worktree]`

Controls what untracked files are copied into new task worktrees.

| Key       | Type       | Default | Description |
|-----------|------------|---------|-------------|
| `include` | `string[]` | `[]`    | Glob patterns for untracked files to copy into new task worktrees. |

```toml
[worktree]
include = [".env", ".env.local", "config/local.yml"]
```

---

## `[permissions]`

File protection — prevents agents from modifying or deleting certain files.

| Key         | Type       | Default | Description |
|-------------|------------|---------|-------------|
| `protected` | `string[]` | `[]`    | Glob patterns for files agents should not modify or delete. Agents can still *add* new files matching these patterns — only modifications and deletions are flagged as violations for human review. User patterns are merged additively with the built-in defaults. |

```toml
[permissions]
protected = ["README.md", "test/**/*.ts", "*.spec.*"]
```

---

## `[automation]`

Maintained files — the inverse of `[permissions].protected`. Patterns agents are *expected* to keep up to date as they work (docs, CHANGELOG, architecture diagrams). Agents *may* skip them, but when a turn touches none of an entry's files, the supervisor prompts the agent once to either make the update or record why it skipped — turning a silent omission into a deliberate, reviewable decision. It is a nudge, not a gate: the task still blocks normally (it does not become a `conflict`).

`maintain` is an array of tables (`[[automation.maintain]]`), each with:

| Key            | Type     | Description |
|----------------|----------|-------------|
| `title`        | `string` | Short label for the group (shown to the agent and in review). |
| `pattern`      | `string` | Glob matched against the turn's changed files. |
| `instructions` | `string` | What/why to maintain — shown to the agent verbatim, up front and in the follow-up. |

Opt-in: empty by default. The follow-up fires at most once per turn, and is skipped entirely only on a no-op turn (no code changes).

When the same turn also has protected-file violations, the maintain nudge runs **after** the push-back exchange and is **independent of its outcome** — it fires whether the agent resolved the violations or kept them. (Earlier versions suppressed it whenever any violation remained; because `lazy.toml` is itself a protected file, every turn that edited it skipped the nudge, making the feature look inert.) Ordering within such a turn is: work → push-back → agent reply → maintain nudge → agent reply. The push-back never re-runs because of the maintain step (it is single-shot), and only the push-back turn carries the final violation set, so a still-violating turn still becomes a `conflict` even though it also got nudged.

The follow-up is recorded as its own discrete turn pair — a `supervisor`-authored prompt turn (under a "Maintained Files Review" heading) followed by the agent's reply turn — so the turn history reads cleanly: work turn → supervisor nudge → agent reply. The nudge text is **not** appended to the work turn's response. The reply turn carries its own token usage (including cache tokens) and any commits the follow-up made are attributed to it, not the work turn. The protected-file push-back behaves the same way ("Permission Violation Review"). In `lazy show` and the dashboard these prompt turns are labelled `supervisor` (not `human`), so you can tell "the human said" from "the supervisor pushed back".

```toml
[[automation.maintain]]
title = "docs"
pattern = "docs/**/*"
instructions = "Search for docs and update any that have gone out of date due to your work, OR create new docs if needed."

[[automation.maintain]]
title = "changelog"
pattern = "CHANGELOG.md"
instructions = "Add ONE line to the next release section under Added/Changed/Fixed: bold feature/command name, one sentence of the user-visible effect (not the implementation, no internal type/function names), and your task code in parens as the depth pointer. Max ~25 words. Skip if your work is intra-release; update your existing line instead of adding a second."
```

---

## `[checks]`

Post-turn checks run after each agent turn to capture test results or other signals.

| Key                 | Type     | Default | Description |
|---------------------|----------|---------|-------------|
| `post_turn`         | `string` | `""`    | Command to run after each agent turn. Output is captured and attached to the turn for reviewers. Does NOT block the agent or trigger retries. |
| `post_turn_timeout` | `number` | `300`   | Timeout in seconds for the `post_turn` command (default: 5 minutes). |

```toml
[checks]
post_turn = "bun test --bail"
post_turn_timeout = 300
```

---

## `[daemon]`

Controls the daemon's auto-react behavior — automatically unblocking tasks in response to CI failures, PR/MR comments, and other triggers.

| Key                       | Type     | Default         | Description |
|---------------------------|----------|-----------------|-------------|
| `auto_react_ci`           | `bool`   | `true`          | React to CI failures (auto-unblock blocked tasks when CI fails). |
| `auto_react_comments`     | `bool`   | `true`          | React to PR/MR comments (auto-unblock blocked tasks when humans comment). |
| `auto_react_max_retries`  | `number` | `3`             | Max auto-unblocks per task *per trigger type* before the task is paused for human review. |
| `auto_react_backoff`      | `string` | `"exponential"` | Backoff strategy between repeated auto-unblocks of the same trigger: `"none"`, `"linear"`, or `"exponential"`. |
| `auto_react_daily_budget` | `number` | `50`            | Max auto-triggered turns per day across all tasks in the project. Resets at **local midnight** (machine timezone). |
| `max_auto_turns`          | `number` | `3`             | Max *consecutive* auto-triggered turns per task before the task is paused for human review. The counter resets whenever a human manually unblocks the task or the task reaches a terminal state. |

```toml
[daemon]
auto_react_ci = true
auto_react_comments = true
auto_react_max_retries = 5
auto_react_backoff = "exponential"
auto_react_daily_budget = 100
max_auto_turns = 3
```

`auto_react_daily_budget` is the **permanent** cap. To steer the budget at runtime
without editing `lazy.toml`, use `lazy daemon auto-budget`:

- `lazy daemon auto-budget list` — today's used/limit, reset countdown, pause state,
  and a log of what consumed budget today (timestamp, task, trigger).
- `lazy daemon auto-budget update <+N|-N|=N>` — adjust **today's** effective cap only
  (e.g. `+50`, `-20`, `=100`). This is ephemeral and resets at local midnight; it does
  **not** change `lazy.toml`.
- `lazy daemon auto-budget pause` — pause all auto-react until local midnight (then
  auto-resumes); `resume` clears it early.

"Today" rolls over at local midnight, and every reset/pause expiry is shown with a
countdown anchored to `00:00 local`.

### Inspecting and reaping daemons across projects

`lazy daemon status` reports the daemon for the current project. To see and clean up
daemons across **all** projects on the host:

- `lazy daemon list` — every running daemon (pid, web port, version, age, project
  root). A daemon whose project root has been deleted is marked `(stray)`, and dead-pid
  state dirs left behind by crashes are reported as orphans.
- `lazy daemon kill-stray` — reap only stray daemons (those whose project root no longer
  exists). A daemon whose root still exists is **never** touched. Requires confirmation;
  pass `--yes` for non-interactive callers and `--prune-dirs` to also remove orphaned
  state dirs whose process is dead.

Daemon state lives under `~/.lazy/daemon/<slug>/` by default. Set the
`LAZY_DAEMON_BASE_DIR` environment variable to relocate it — useful for isolated test
runs or custom operator setups. It is honored by every daemon path, including the
`list`/`kill-stray` scan, so all daemons agree on a single location.
