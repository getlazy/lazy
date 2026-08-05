# lazy.toml Configuration Reference

`lazy.toml` is the project-level configuration file for Lazy. It lives at the root of your git repository and is created by `lazy init`.

You can override the config filename with the `LAZY_CONFIG` environment variable (e.g., `LAZY_CONFIG=lazy.lima.toml lazy list`). If `LAZY_CONFIG` is an absolute path, it is used directly; otherwise lazy walks up from the current directory looking for the file. Worktrees can carry their own `lazy.toml` this way.

If `LAZY_CONFIG` is set but points to a file that doesn't exist, lazy fails hard rather than silently falling back to defaults.

## If lazy.toml doesn't parse

A missing `lazy.toml` is a normal condition — lazy uses its defaults. A `lazy.toml` that **exists but doesn't parse** is not: lazy fails hard with the offending line and stops, rather than falling back to defaults. Falling back would discard every setting in the file at once and leave lazy running on defaults that look deliberate — a duplicate `[runner]` table would mean agents ran in Docker while the file plainly said host-process.

The most common cause is a **duplicate table**. `lazy init` already writes `[runner]`, `[server]`, `[storage]`, `[remote]`, `[docker]` and others, so appending a second copy of one is a TOML redefinition error. Edit the table that is already there instead of adding another one.

`lazy doctor` is the exception that keeps working: it reports the parse failure as a failed `lazy.toml parses` check and skips every config-dependent check rather than reporting defaults as if you had chosen them.

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

**Host vs container endpoints.** `endpoint` is written from the *container's* point of view — that is why the `ollama` default is `http://host.docker.internal:11434`, a Docker-internal DNS alias that resolves only inside a container. Not everything lazy launches is a container: `lazy pair`, `lazy chat`, and the host-process runner run Claude Code as a **host** process. For those launches lazy rewrites `host.docker.internal` to `localhost` before injecting `ANTHROPIC_BASE_URL` — the same conversion the reachability preflight probes with, so the address that was verified is the address the launched process is given. Container launches keep the docker-internal name unchanged. You do **not** need two configs: write the endpoint once, for the container, and host launches adapt. Any other hostname (a LAN IP, a real DNS name) is passed through untouched in both directions.

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
| `watchdog_output_timeout_ms` | `number` | `1800000`       | Hang backstop: kill the agent process after this many ms **without forward progress**. Resets on every completed step, so it bounds a single step, not the turn. A kill that captured nothing (no result, no new commits) is relaunched automatically with backoff; a kill after the agent had captured work stops for a human. `0` = use agent default (disabled for Claude Code). Default is 30 minutes. |
| `wind_down_timeout_ms`       | `number` | `60000`         | How long to wait for the agent process to exit *after* it has emitted its final result, before killing it. `0` = wait indefinitely. Default is 60s. |
| `effort`                     | `string` | `"medium"`      | Reasoning effort level passed to Claude Code via `--effort` for task agents. Valid: `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"`. Higher levels spend more tokens thinking before responding. |

```toml
[agent]
agent_id = "claude-code"
watchdog_output_timeout_ms = 3600000  # 1 hour without forward progress
wind_down_timeout_ms = 60000          # 60s to exit after the summary lands
effort = "medium"
```

### How a turn is guarded

The two timeouts above are deliberately different guards, and only one of them
is ever armed at a time:

- **While the agent is working**, `watchdog_output_timeout_ms` applies. It is a
  hang backstop, not a turn deadline — there is no time limit measured from
  launch, from a commit, or from any other event. For Claude Code the supervisor
  reads the agent's output stream and resets the timer on every step the agent
  *completes*, so a turn made of many long steps runs as long as it needs. What
  the value actually bounds is a **single step**: a tool call that runs longer
  than the timeout without finishing is killed. Keep-alive heartbeats emitted
  by a stuck tool call deliberately do **not** reset the timer — a wedged MCP
  call emits one every 30s forever, so counting them as progress would make it
  immortal. Agents that do not stream (Cursor) fall back to "any output counts".
- **After the agent emits its final result**, the work is safe on disk and the
  summary is in hand, so `wind_down_timeout_ms` gives the CLI a short window to
  exit and then kills it (SIGTERM, then SIGKILL after 5s). A kill here is
  recorded as a *successful* turn — the summary is preserved.

Both guards cover merge-conflict resolution turns too: when a sync hits
conflicts an agent resolves them, and that is an ordinary agent turn.

`graceful_exit_timeout_ms` is the old name for `wind_down_timeout_ms` and is
still read, so existing configs keep working.

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

Docker and Podman modes run agents in isolated containers. Host-process mode runs agents directly on the host so they can use your local toolchain (language servers, project scripts). It is no longer "no isolation" by default — see the host permission posture below.

```toml
[runner]
type = "docker"
```

### Host permission posture

These keys apply **only** to the host-process runner (`type = "dangerously-host-process-without-any-isolation"`) and are ignored for Docker/Podman, where the container is the boundary.

| Key                           | Type       | Default               | Description |
|-------------------------------|------------|-----------------------|-------------|
| `permission_mode`             | `string`   | `"sandbox"`           | `"sandbox"` runs host agents/builder under Claude Code's OS sandbox (Seatbelt on macOS, bubblewrap on Linux/WSL2). `"bypass"` is the old `--dangerously-skip-permissions` behavior with **no** sandbox — an explicit opt-in. |
| `sandbox_allowed_domains`     | `string[]` | `["*.anthropic.com"]` | Network domains Bash may reach without prompting. See the security note below — this is **not** a hard network wall. |
| `sandbox_deny_read`           | `string[]` | `[]`                  | Extra paths to deny the Read tool, **merged with** the built-in sensitive defaults (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`, shell rc files, `~/.claude*`, …) — never replacing them. |
| `sandbox_deny_write`          | `string[]` | `[]`                  | Extra paths to deny the Write/Edit tools, merged with the same sensitive defaults. |
| `sandbox_allow_weaker_nested` | `bool`     | `false`               | Allow Claude Code's weaker nested sandbox so bubblewrap can run inside an unprivileged container (no user namespaces). **Considerably weakens isolation** — only enable when an outer container already provides the boundary. No effect on macOS. |

In `"sandbox"` mode, lazy confines host execution with two OS-enforced boundaries carried in Claude Code's `--settings`:

- **Headless agents** run sandbox + `--dangerously-skip-permissions`, so a `-p` session never hangs on a permission prompt; the OS sandbox is the sole hard boundary for Bash (a write outside the worktree or a connection to a non-allowlisted domain is a tool error, not a prompt), and the `dangerouslyDisableSandbox` escape hatch is disabled.
- **The interactive builder** runs sandbox + the normal prompt mode (it can answer a sandbox-escape prompt); `--autonomous` opts it into the headless posture.
- The **Read/Edit/Write file tools bypass the OS sandbox** (it governs Bash only), so lazy additionally confines them with `permissions.deny` rules built from the sensitive defaults + your `sandbox_deny_read`/`sandbox_deny_write`.

> **Security note — `sandbox_allowed_domains` is not a hard network wall.** Under `sandbox` + bypass it only *pre-approves* domains so Bash doesn't prompt; a non-allowlisted domain is still reachable (bypass auto-approves the prompt it would otherwise raise). Treat it as prompt-reduction, not network confinement. Real network confinement needs Claude Code managed settings, which lazy does not currently emit.

On Linux, `sandbox` mode requires `bubblewrap` and `socat`; if they're missing, host execution fails hard with an actionable install message (no silent fallback to unsandboxed). `lazy doctor` reports the active posture and, on Linux, checks these dependencies.

The posture above is verified against real headless sessions by `scripts/host-sandbox-probe.sh`. To re-verify it on Linux from a macOS host, follow [docs/runbooks/verify-host-sandbox-linux.md](runbooks/verify-host-sandbox-linux.md) — it runs the probe in a throwaway Lima VM and diffs the results against the verified macOS matrix.

```toml
[runner]
type = "dangerously-host-process-without-any-isolation"
# permission_mode = "sandbox"                      # default; "bypass" = no sandbox
# sandbox_allowed_domains = ["*.anthropic.com"]    # add registries/git hosts your project needs
# sandbox_deny_read = []                            # extra Read-tool denials (merged with defaults)
# sandbox_deny_write = []                           # extra Write/Edit denials (merged with defaults)
# sandbox_allow_weaker_nested = false               # opt-in for unprivileged containers
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

Under either mode, `lazy start` branches a task from the **local** parent/integration branch — it skips the remote fetch entirely (mirroring `lazy sync`), so starting a task whose parent branch only exists locally (e.g. created earlier while offline and never pushed) works without error. When you are **online** and a parent ref genuinely isn't on the remote, `lazy start --force-local` (CLI) or the `force_local` param on the `lazy_start` MCP tool starts from the parent's local HEAD instead of failing.

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
| `endpoint` | `string` | `"http://host.docker.internal:11434"`| Ollama API endpoint. The default assumes agents run inside Docker and need to reach Ollama on the host — `host.docker.internal` resolves to the host from inside the container. On Linux hosts this may require `--add-host=host.docker.internal:host-gateway` or a direct host IP. Host launches (`lazy pair`, `lazy chat`, the host-process runner) automatically rewrite this to `localhost` — see [Host vs container endpoints](#modelsroles--per-role-model-targets). |

```toml
[ollama]
enabled = true
model = "qwen3.5:35b-a3b-coding-nvfp4"
endpoint = "http://host.docker.internal:11434"
```

**Interaction with the daemon credential gate.** The daemon refuses to start without a model credential (`CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`) on every start path — explicit start, restart, upgrade, and the auto-start that fires on any `lazy` command — because it launches task containers that inherit its credential. `enabled = true` here is the documented escape hatch: Ollama-backed setups use local dummy credentials, so the gate is skipped entirely, matching `runner.checkAvailability()`. Note the gate reads **this block only** — a per-role `[models.roles.*]` table with `backend = "ollama"` and no `[ollama] enabled = true` still requires a credential in the daemon's environment. The check is presence-only and never calls the API (a blank value counts as absent); see `src/daemon/credential-gate.ts` for the rationale. Because it never calls the API, a credential that is present but *expired* passes the gate — the daemon starts and then every request 401s. `lazy doctor` covers that half: it reads the proxy's audit trail and reports a 401/403 that nothing has succeeded after, with the steps to re-mint. Both halves report on the **daemon's** environment, not the shell you happen to run `lazy doctor` in: the presence check asks the daemon over RPC (which returns presence and the variable *name*, never the credential itself) and labels the source it used — `daemon env: …`, or `shell env: …` plus a caveat when the daemon could not be asked.

---

## `[proxy]`

**The proxy is ON BY DEFAULT.** It is how lazy runs, the same way the daemon is: with **no `[proxy]` section at all**, the daemon starts the built-in Anthropic-native passthrough proxy on an OS-assigned port and routes **all agent model traffic through it**. You do not have to configure anything, and there is no `backend = "proxy"` to set — an ordinary `anthropic` role is proxied automatically.

What you get by default: SSE responses streamed through untouched, one asynchronously-logged `ProxyAuditRecord` per request (model, request shape, extracted `tool_use` blocks — Read/Write paths, Bash commands, WebFetch URLs, inherited `mcp__claude_ai_*` connectors — and `tool_result` previews, attributed to the role and task that made the call), plus the mechanistic policy plane over every tool call, with inherited claude.ai connectors denied by default — see [`[proxy.policy]`](#proxypolicy--mechanistic-enforcement-63-layer-1).

**Credentials are unaffected.** The proxy is a passthrough: it forwards your existing credential (API key or OAuth token) to the same upstream you would otherwise call, so authentication behaves exactly as before.

Find the live address with `lazy daemon status` (it's also printed at daemon start). The port is OS-assigned because a hardcoded one conflicts across per-project daemons; set `port` only to pin it.

**What is *not* proxied:** `ollama` roles (the proxy has a single Anthropic-native upstream; a local model is not it) and any role with an explicit `endpoint`, which is honored as-is.

### Turning it off — `enabled = false`

The escape hatch restores the previous direct-connection behavior **entirely**: no proxy server is started and no `ANTHROPIC_BASE_URL` is injected. There is deliberately no partial mode.

```toml
[proxy]
enabled = false   # direct connections: no audit trail, no policy enforcement
```

**If the proxy cannot start, the daemon fails to start** — it never falls through to a direct connection. A silent fallback would send agent traffic straight to Anthropic while the audit trail recorded nothing, so the trail would lie by omission and the connector deny-rules would silently not apply. The startup error names `enabled = false` as the way to get unblocked.

**And if a launch cannot reach the running proxy, the launch fails too.** Every launch path (task agents, the builder, `lazy pair`, `lazy chat`) resolves the proxy's live address at launch time — from the daemon directly when it launches the agent itself, over the daemon's RPC socket when the launch happens in a CLI client. If that resolution fails — daemon down, RPC blip, proxy not bound yet — lazy **refuses to launch** rather than connect direct:

```
[proxy] is enabled but lazy could not resolve the live proxy address.
Reason: Daemon is not running.
...
What to do:
  - Check the daemon:    lazy daemon status
  - Start / restart it:  lazy daemon start   (or: lazy daemon restart)
  - Or opt out of the audit plane explicitly, in lazy.toml:
        [proxy]
        enabled = false
```

The reasoning is the same as for daemon startup, and it is the point of the escape hatch: `enabled = false` is how you say "I want direct connections", and a transient daemon failure must not be able to say it *for* you — silently, on a single launch, with no trace afterward that the traffic went unaudited. `ollama` roles and roles with an explicit `endpoint` are unaffected: they were never routed through the proxy, so there is nothing to resolve.

**A resolved address is only good for the daemon that gave it out.** With the port OS-assigned, a restarted daemon serves the proxy somewhere else, so any address held across a restart is dead. This matters for `lazy upgrade`, which restarts the daemon *and* relaunches your builder session: the relaunched builder re-resolves the address against the daemon that came back, rather than reusing the one it started with. If that re-resolve fails, the builder is **not** relaunched — you get the error above and a `lazy builder --resume <id>` to run once the daemon is healthy, instead of a session that comes back alive but unable to reach the API.

> **Proven architecture.** The passthrough proxy is validated by the model-passthrough spike — a throwaway `logging-proxy.ts` intercepted real Claude Code ↔ Anthropic traffic including unguessable `tool_result` file contents, streaming SSE, and the two-stage permission-classifier flow. See `docs/spikes/model-passthrough.md`.

| Key        | Type     | Default                          | Description |
|------------|----------|----------------------------------|-------------|
| `enabled`  | `bool`   | `true`                           | Master switch. `false` restores direct, unproxied connections entirely — no proxy server, no `ANTHROPIC_BASE_URL` injection, no audit trail, no policy enforcement. |
| `port`     | `int`    | OS-assigned free port            | TCP port the proxy listens on. **Optional** — omit it to let the OS pick a free port (avoids conflicts across per-project daemons); the actual port is shown by `lazy daemon status` and at daemon start. Set it only to pin a specific port. |
| `bind`     | `string` | `"127.0.0.1"`                    | Bind address. Keep the default (loopback only) unless you deliberately expose the proxy to other machines. |
| `upstream` | `string` | `"https://api.anthropic.com"`    | Anthropic-compatible upstream the proxy forwards to (real Anthropic, Ollama, or another proxy). Anthropic-native targets only — the proxy never translates between API shapes. |
| `retry_after_threshold` | `int` | `5` | On a **primary** 429 whose `Retry-After` is ≤ this many seconds, the proxy waits that long and retries the primary **once** before failing over. A larger `Retry-After` fails over immediately. Only applies when a fallback chain is configured. |

```toml
# The default. No [proxy] section needed at all — the daemon starts the proxy on
# an OS-assigned port and routes agent traffic through it.
```

To pin a specific port and endpoint instead (both are overrides):

```toml
[proxy]
port = 8766
bind = "127.0.0.1"
upstream = "https://api.anthropic.com"

[models.roles.agent]
backend = "proxy"
model = "claude-sonnet-4-6"
endpoint = "http://127.0.0.1:8766"
```

Audit records are written to `.lazy/proxy-audit.jsonl` (append-only JSONL, one record per line). Writes are serialised — no interleaving even under concurrent requests — and happen asynchronously so the proxy hot path is never blocked by disk I/O.

Each record is **attributed to the role and task that made the request.** lazy sets `ANTHROPIC_CUSTOM_HEADERS` on every agent it launches through the proxy, so Claude Code sends `x-lazy-role` (`agent` or `builder`) and — for task agents — `x-lazy-task-id` on each request; the proxy reads them into the audit record's `role`/`taskId`, then strips them before forwarding upstream (real Anthropic never sees lazy-internal headers). This is what lets the audit trail (and every `DENY` log line) say *which* agent and task tried a given `tool_use`, not just that one did.

### Smart routing — `[[proxy.fallback]]` failover chain

By default, when the upstream returns **429** (rate limited) / **529** (overloaded) or is unreachable, the proxy fails the request and the agent's turn fails with it. A `[[proxy.fallback]]` chain lets the proxy instead **reroute** the request to an alternate Anthropic-native target — a different model tier, a different endpoint (e.g. a locally-served Ollama model), or a different account. Each entry is tried in order until one responds.

Failover is **explicit and opt-in.** With no `[[proxy.fallback]]` entries the proxy fails hard exactly as before — it never invents a fallback or silently retries (per lazy's no-silent-fallback rule). Every reroute is **logged** (`logger.warn`) **and recorded** in the audit trail: each `ProxyAuditRecord` carries a `reroute` field with the original upstream/model, the fallback upstream/model actually used, the trigger (`"429"`, `"529"`, or `"unreachable"`), and the number of targets attempted. So you can always see afterward which turns ran on a fallback model.

| Key        | Type     | Default | Description |
|------------|----------|---------|-------------|
| `upstream` | `string` | — (required) | Anthropic-native base URL to reroute to. Anthropic-native only — no translation layer. |
| `model`    | `string` | (keep original) | Optional. When set, the request body's `model` is rewritten to this before re-sending — use it to fail over to a different tier or to name the model a different backend expects. Omit it to keep the original model (e.g. a hot spare on the same model). |

```toml
[proxy]
port = 8766
upstream = "https://api.anthropic.com"
retry_after_threshold = 5

# First fallback: a local Ollama model (free). No API spend.
[[proxy.fallback]]
upstream = "http://host.docker.internal:11434"
model = "qwen3.5:35b-a3b-coding-nvfp4"

# Second fallback: a cheaper Anthropic tier, only if the local one is also down.
[[proxy.fallback]]
upstream = "https://api.anthropic.com"
model = "claude-haiku-4-5-20251001"
```

**Guarantees and constraints:**

- **Streaming is never interrupted.** Failover keys only on the upstream's *status line*. Once a `200` response has started streaming back to the client, it is never rerouted mid-stream — an error partway through a successful turn surfaces to the client as-is.
- **Respect `Retry-After`.** On a primary 429 with a short `Retry-After` (≤ `retry_after_threshold`, default 5s), the proxy waits it out and retries the primary once before failing over — a brief rate-limit blip is cheaper to wait than to reroute. A longer `Retry-After`, or a 529, fails over immediately.
- **Paid-API guard.** A fallback chain is itself explicit config, but mind the *ordering*: putting a paid Anthropic target as the fallback for a local/free primary means an overloaded local model silently escalates to billed API usage. That is allowed (you configured it) but should be intentional — order free/cheap targets first if that is what you want.
- **Anthropic-native only.** Fallback targets speak `/v1/messages` natively; the proxy never translates between API shapes.

### `[proxy.policy]` — mechanistic enforcement (§6.3 layer 1)

Beyond passive audit, the proxy runs a **deterministic, injection-proof rule engine** that inspects every `tool_use` an agent proposes *before it executes*. On a policy violation it **rewrites the response** so the call never runs and injects an explanatory assistant text block, so the agent learns why and course-corrects. Rules are model- and backend-independent — a prompt-injected agent cannot argue its way past a static rule.

**Enforcement is ON by default whenever `[proxy]` is set**, with a closed posture. The load-bearing rule: inherited **claude.ai account connectors (`mcp__claude_ai_*`) are denied by default, allowlist-only** — these Gmail/Drive/Calendar/Spotify tools are injected server-side from the authenticated account and are invisible to the OS sandbox and Claude Code's own permission model, so the proxy is the only `lazy`-controlled place that can stop them (see spike §0.5, §6.3). Reads of secret/credential paths are also denied by default.

Only a `/v1/messages` response to a request that *declared tools* is buffered for possible rewriting; every other response streams through untouched, and when nothing is denied the original bytes are forwarded verbatim.

| Key                      | Type       | Default | Description |
|--------------------------|------------|---------|-------------|
| `enforce`                | `bool`     | `true`  | Master switch. `false` = pure passthrough/audit, no enforcement. |
| `connector_allowlist`    | `string[]` | `[]`    | Exact `mcp__claude_ai_*` tool names to re-allow despite the default-deny posture. Exact match, not prefix. |
| `deny_secret_path_reads` | `bool`     | `true`  | Deny reads of `~/.ssh`, `.env`, `.aws/credentials`, private keys, `.npmrc`, kubeconfig, etc. |
| `deny_path_globs`        | `string[]` | `[]`    | Extra absolute-path globs (`*`/`**`) to deny for read/write tools. |
| `egress_allowlist`       | `string[]` | `[]`    | Hosts `WebFetch` may reach. Empty/unset = egress unrestricted; a non-empty list denies any other host. |

```toml
[proxy]
port = 8766

[proxy.policy]
enforce = true
connector_allowlist = ["mcp__claude_ai_gmail_search_threads"]  # re-allow only what you intend
deny_secret_path_reads = true
# deny_path_globs = ["/etc/**", "**/*.key"]
# egress_allowlist = ["api.github.com"]
```

Denials are recorded on the request's `ProxyAuditRecord` (`enforcement` field: which tool, which rule, why). This is the **mechanistic floor**; the LLM-judge layer for borderline cases (§6.3 layer 2) is separate, later work.

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

**One host path is refused outright: lazy's daemon state directory** (`~/.lazy/daemon/`, or wherever `LAZY_DAEMON_BASE_DIR` points). A bind `source` inside it — or one that *contains* it, such as `~/.lazy` or `$HOME` — fails with an error naming the entry and the reason. That directory holds the shared daemon token (which authenticates every `/rpc` call) and the per-task MCP token registry; a container that could read it could act as any other task, or as the builder, defeating per-task agent identity entirely. Absolute sources are refused at config-load time; a project-relative or placeholder source that *resolves* into that directory is refused at launch. Lazy's own read-only mount of a container's single MCP config file is added by the launch path itself and is unaffected.

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

## `[protection]`

Protected branches — accepting a task into a protected branch requires a one-time human approval, recorded with `lazy approve <task>`. This is friction against an over-eager builder, not a security boundary; the full story is in [docs/protected-branches.md](./protected-branches.md). Not to be confused with `[permissions].protected`, which guards *files* from agent edits.

**Opt-in — off by default.** A project with no `[protection]` section has no protection at all: accepts behave exactly as if the feature didn't exist. `enabled` is the single master switch, and while it is off every other key in this section has no effect. The one command that turns it on is `lazy protect main on`, which lists the branch **and** sets `enabled = true`; `lazy protect <target> off` never touches the switch, so toggling never loses a list. Because the feature is invisible while off, a successful `lazy accept` into the repo's default branch prints a one-line tip pointing at `lazy protect` — suppressed as soon as `enabled` appears in this section with either value. `lazy doctor` warns when other `[protection]` keys are configured while the switch is off, since they are inert.

| Key                   | Type       | Default                    | Description |
|-----------------------|------------|----------------------------|-------------|
| `enabled`             | `boolean`  | `false`                    | Master switch. Off by default; set `true` (or run `lazy protect <branch> on`) to engage protection — that alone protects the repo's default branch (e.g. `main`). While false, nothing else in this section has any effect. |
| `gate_default_branch` | `boolean`  | `true`                     | When protection is enabled, protect the repo's default branch. On by default; set `false` to protect only the branches listed in `protected_branches`. |
| `protected_branches`  | `string[]` | `[]`                       | Additional protected branches, for projects with more than one sensitive branch. Merges **into** them need approval. Exact branch names, no globs. |
| `protected_tasks`     | `string[]` | `[]`                       | Protected tasks, by task code or short id. Merging that task's work **out** — upward into any target — needs approval. The branch is resolved from the task at decision time. |
| `passphrase_file`     | `string`   | `.lazy/approve-passphrase` | Path (relative to the project root) of the file holding the approval passphrase. Create it out-of-band; it is gitignored and never surfaced through MCP. `lazy approve` checks this file exists and is non-empty *before* prompting, and names it in the prompt. |

Both lists are managed by **`lazy protect <branch|task> on|off`**, which edits this section in place and preserves its comments; `lazy protect` with no arguments prints the current state. Hand-editing works too — this section is the one and only store.

When enabled, protection applies on **all** remote drivers, including `local`, and regardless of who calls accept (CLI `--yes`, the builder over MCP, automation). Subtask merges into intermediate `lazy/*` parent branches are never protected — no friction in the inner loop — with one deliberate exception: a task listed in `protected_tasks` gates its own outgoing merge even into a `lazy/*` parent. One approval unlocks exactly one accept of the approved task.

`gate_default_branch` protects a branch that appears in no list: the default branch is resolved from `refs/remotes/<remote>/HEAD` at decision time, so it stays correct if the repo's default branch changes. `lazy protect` shows it under Protected branches marked as implicit, and `lazy doctor` warns when that remote ref is missing (resolution then falls back to the literal `main`, which would gate nothing on a `master` repo).

On GitHub and GitLab projects, **approving the task's PR/MR satisfies this same gate** — it is a satisfier resolved inside the gate, not a parallel mechanism, so a `local` project and a forge project reach the identical decision. The forge is checked before any pending `lazy approve` record (so an approved PR does not burn it) and fails closed if the forge is unreachable. See [protected-branches.md](./protected-branches.md).

```toml
[protection]
# opt-in: off until this is true (or until `lazy protect main on` sets it)
# enabled = true                # protects the repo's default branch

# advanced: additional protected branches (merges IN need approval)
# protected_branches = ["release"]
# advanced: protected tasks (merges OUT need approval)
# protected_tasks = ["add-auth"]
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

### `[automation.pre_accept]`

**Opt-in — `enabled` defaults to `false`.** The step costs a full agent turn on *every* accept (session resume, gate commands, maintained-files review, post-mortem) and `lazy accept` blocks on it, including agent-driven subtask accepts. Accept is fast by default; set `enabled = true` to turn the step on.

When enabled, a single agent turn runs as a task is being **accepted**, BEFORE the merge. It is the home for expensive one-time validation (full test suite, build) and for maintained-files completeness — any configured `[[automation.maintain]]` groups (a CHANGELOG, for example) brought up to date once against the *final* diff rather than re-litigated on every turn. Per-turn checks (`[checks].post_turn`) stay lightweight; accept-time is where completeness is enforced.

The turn's only built-in behavior is the post-mortem below. Everything else comes from configuration: the acceptance-checks step appears only when `commands` are set, and the maintained-files step only when `[[automation.maintain]]` groups exist. With neither configured, the turn is the post-mortem alone.

On accept the agent runs the configured commands, fixes what they surface, brings maintained files up to date, commits, and records a short post-mortem. The supervisor then **re-runs `commands` itself** as the authoritative merge gate — the agent cannot self-certify. Only if that independent run passes does the merge proceed.

| Key        | Type       | Default | Description |
|------------|------------|---------|-------------|
| `enabled`  | `boolean`  | `false` | Run the pre-accept turn at all. Default `false`: accept merges directly with no pre-accept turn (and no post-mortem). Set `true` to opt in. |
| `commands` | `string[]` | `[]`    | Gate commands, run in order after the agent's turn. The first non-zero exit **aborts the accept** and returns the task to the status it held before the accept with the failure surfaced as a comment — never a silent merge. Empty means the turn is the post-mortem (plus any configured maintained-files work) only — the gate passes trivially. |
| `timeout`  | `number`   | `600`   | Timeout in seconds for **each** gate command. A timed-out command counts as a failure and aborts the accept. |

**Built-in post-mortem (not a config knob).** Every pre-accept turn — even with no `commands` and no maintained files — asks the agent to append a short retrospective (what was hard, what it would do differently, what surprised it) to the task **journal**. The journal is chosen deliberately: it is append-only and prompt-immune (never re-injected into a later agent turn), so the retrospective is preserved as memory for future work without polluting any prompt. The post-mortem is valuable on its own, but it is not free — it rides along with the turn, so you get it by opting the step in.

**Failure semantics.** If the agent's turn crashes, the gate times out, or a gate command exits non-zero, the task is returned to the status it held before the accept — `blocked`, `conflict`, or `submitted`, whichever it actually was — with the reason recorded as a comment, and the accept is aborted. Fix the issue and re-run `lazy accept`. `enabled = false` (the default) opts a project out of the whole step.

**How long the daemon waits.** The daemon's own backstop for the whole pre-accept turn is derived from `[agent].watchdog_output_timeout_ms` plus a 5-minute margin, so it always fires *after* the agent's no-progress watchdog. That ordering is deliberate: the watchdog is the clock that can say something useful ("the agent stopped producing output"), so it should be the one that fires first; this wait exists for the case where the watchdog itself is wedged, and the message names which deadline fired. Raising the watchdog raises this wait with it — there is no separate knob to keep in sync.

```toml
[automation.pre_accept]
enabled = true
commands = ["bun test", "bun run build"]
timeout = 600
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

## `[memory]`

Advisory size budget for the shared-memory context injected into every builder and agent launch (see [memory.md](memory.md)).

| Key          | Type     | Default | Description |
|--------------|----------|---------|-------------|
| `warn_bytes` | `number` | `4096`  | When the assembled memory context exceeds this many bytes, every launch logs one generic line pointing at `lazy doctor` (and the builder's section carries a short in-prompt pointer to it). `lazy doctor` reports the actual size, this threshold, the compact's staleness, and the remedy. |

```toml
[memory]
warn_bytes = 4096
```

**Advisory, never enforced.** Memory past the threshold is still knowledge, so lazy never truncates it and never blocks a launch over it — the only effect is the warning. The full diagnosis lives in `lazy doctor` (the single "check engine light" surface), which recommends `lazy memory compact` only when the compact is actually behind the records; if it is already current, it points at curating records or raising this key instead. `lazy memory compact` regenerates the derived compact used for injection; it never modifies the records, and it refuses to write a compact that would make the injected context *larger* than it already is (see [Compaction](memory.md#compaction)) — so on a small or already-dense store, curating records or raising this key is the only thing that helps.

---

## `[limits]`

Concurrency caps for containers. When many tasks launch at once Docker struggles (slow launches, probe timeouts — see the write-probe flips under load that motivated this), so lazy caps how many run concurrently.

| Key                       | Type     | Default | Description |
|---------------------------|----------|---------|-------------|
| `max_concurrent_agents`   | `number` | `8`     | Max **live** agent task containers. New `lazy start`s beyond this **queue** — the task enters `queued` status and the daemon launches it automatically as slots free up. |
| `max_concurrent_builders` | `number` | `8`     | Max concurrent interactive builder containers. New `lazy builder`s beyond this **fail fast** with an actionable message — an interactive session a human is waiting on is never queued. |
| `idle_grace_minutes`      | `number` | `10`    | How long an idle **blocked** container may linger (kept warm for a likely next turn) before the reaper frees its slot. Same-or-higher-priority queued work overrides this grace immediately. `0` = reap as soon as idle. |

```toml
[limits]
max_concurrent_agents = 8
max_concurrent_builders = 8
idle_grace_minutes = 10
```

**What counts as a live agent container.** A supervisor container is *not* torn down when a turn finishes — a `blocked` task awaiting review keeps its container alive (idle-polling), until it is reviewed, its next unblock reuses it, or the **idle reaper** (below) frees it. Since the cap exists to bound Docker load, those lingering containers count toward `max_concurrent_agents` too — the cap tracks any non-terminal task holding a live container, not just those actively running a turn.

**Idle reaper.** So blocked-but-alive containers don't permanently eat slots, the daemon reaps them:

- **Base reap** (RAM bound): an idle container older than `idle_grace_minutes` is reaped unconditionally.
- **Demand-driven reap** (queued work waiting, no free slot): grace only keeps a container warm for a *likely next turn* — it never starves equal work. A blocked task's grace protects it only against strictly *lower*-priority queued demand; same-or-higher-priority queued demand reaps it immediately (lowest-priority / oldest-idle first). Heuristic exception: if a strictly-lower-priority task is currently *working*, its slot will free and drain to the queued task first, so the blocked task keeps its grace.

Reaping is safe and cheap: all durable state is in the store + the on-disk Claude session, and the next unblock relaunches the container anyway — so reaping costs only a container cold-start on the next turn.

**Per-runner semantics.** Both the cap and demand-driven reaping are **runner-agnostic** — docker, podman, and the host-process runner all set a run name and count against `max_concurrent_agents`, and any of them may be demand-reaped to free a slot for higher-priority queued work. The **base (grace) reap** applies only to container runners (docker/podman), where an idle run holds a full resident container; an idle **host-process** supervisor is a cheap Bun process, so it is exempt from grace-based reaping (never reaped just for sitting idle). This difference is driven by the runner's `reapsIdleRuns` capability, not an `if docker` check.

Both are **positive integers** (a cap `< 1` is rejected at load time). At the agent cap, `lazy start` reports `queued (N/N running)`; queued tasks surface in `lazy active` / `lazy list` with a `queued` status and their drain position (`queued #2 of 3`). Only the autonomous launch paths are gated (start-queue, crash auto-resume, and CI/comment auto-unblock); a deliberate human `lazy unblock`/`lazy resume` is never blocked or delayed.

**Queue priority.** Set a task's priority with `lazy create --priority <low|normal|high|urgent>`, `lazy prioritize <task> <level>`, or the `lazy_prioritize` MCP tool (default `normal`). When a slot frees, the daemon drains the **highest-priority** queued task first; ties break **FIFO** (oldest queued first). Priority is a durable task edit, shown wherever queued state is (`lazy active`/`list`, `lazy_active`/`lazy_list`). This is operational backpressure ordering, not a scheduler.

These are the **permanent** caps. To steer them at runtime without editing `lazy.toml`, use `lazy daemon config`:

- `lazy daemon config get` — both caps: configured value, ephemeral override, effective limit, and current running count.
- `lazy daemon config set <key> <value>` — set an **ephemeral** override for the current daemon session (e.g. `set max_concurrent_agents 12`, or the aliases `agents` / `builders`). This does **not** change `lazy.toml` and resets on daemon restart.
- `lazy daemon config reset [key]` — clear the override(s), reverting to `lazy.toml`.

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

### Surviving a daemon restart (running agents and builders)

A running agent or builder talks to the daemon through a small config file minted at
launch and bind-mounted into its container: its own MCP token (minted per task
session and per builder session, so an agent can only ever act as itself) plus a target of
`http://host.docker.internal:<web port>`. Restart the daemon (an upgrade, a crash, `lazy
daemon restart`) and that file can go stale, which used to leave **every** `lazy_*` tool
in the live session returning a bare `Unauthorized` — read-only ones included — until the
session was relaunched.

Three things keep a live session working across a restart:

1. **MCP tokens are persisted** (`~/.lazy/daemon/<slug>/mcp-tokens.json`) rather than
   re-minted, and the daemon **prefers the port it last bound** over the default.
2. **A starting daemon rewrites the config files it already minted** to its current port
   — never the token, which belongs to one identity and must not be swapped under a live
   container. The rewrite is in place (same inode), because a single-file bind mount pins
   the inode — an atomic write-and-rename would be invisible inside the container.
3. **Clients re-read that file on a 401 and retry exactly once.** Nothing is retried
   unboundedly, no auth check is skipped, and the only credential source is the same
   trusted local file (or `~/.lazy/daemon/<slug>/token` for the supervisor's client).

Point 1 is best-effort by nature: the `26024+` window is shared by *every* project on the
host, so if another project's daemon has taken your port while yours was down, yours moves
and the old port now answers with a foreign daemon that rightly rejects your token. That is
what points 2 and 3 recover from. If the 401 still stands after the refresh, the error
names the situation explicitly — the daemon on that port belongs to a different project —
using `/daemon/status`, which reports its `projectRoot` unauthenticated for exactly this
diagnosis. `lazy daemon list` shows which project owns which port.
