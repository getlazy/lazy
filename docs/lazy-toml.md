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

## `[server]`

Web dashboard server settings.

| Key             | Type     | Default | Description |
|-----------------|----------|---------|-------------|
| `port`          | `number` | `26024` | Port for the web dashboard server. |
| `sync_interval` | `number` | `60`    | Interval in seconds for background sync when running `lazy server`. Set to `0` to disable. |

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
| `auto_react_daily_budget` | `number` | `50`            | Max auto-triggered turns per day across all tasks in the project. Resets at midnight UTC. |
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
