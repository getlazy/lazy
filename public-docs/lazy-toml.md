# lazy.toml Configuration Reference

`lazy.toml` is the project-level configuration file for Lazy. It lives at the root of your git repository and is created by `lazy init`.

**The project root's `lazy.toml` is the only one that counts.** Lazy always reads it from the root of your repository, whatever directory you run a command from — and a copy inside a task worktree is ignored entirely. Task branches are agent-writable, so honouring a worktree's copy would let a task decide the protected paths, post-turn check, watchdog guards, maintained-file groups and model its *own* next turn runs under.

You can override the config filename with the `LAZY_CONFIG` environment variable (e.g., `LAZY_CONFIG=lazy.lima.toml lazy list`). If `LAZY_CONFIG` is an absolute path, it is used directly; otherwise it names the file lazy looks for in the project root.

If `LAZY_CONFIG` is set but points to a file that doesn't exist, lazy fails hard rather than silently falling back to defaults.

## If lazy.toml doesn't parse

A missing `lazy.toml` is a normal condition — lazy uses its defaults. A `lazy.toml` that **exists but doesn't parse** is not: lazy fails hard with the offending line and stops, rather than falling back to defaults. Falling back would discard every setting in the file at once and leave lazy running on defaults that look deliberate — a duplicate `[runner]` table would mean agents ran in Docker while the file plainly said host-process.

The most common cause is a **duplicate table**. `lazy init` already writes `[runner]`, `[server]`, `[storage]`, `[remote]`, `[docker]` and others, so appending a second copy of one is a TOML redefinition error. Edit the table that is already there instead of adding another one.

**The daemon refuses to start on such a config**, whether it failed to parse or was rejected for an invalid value — it fails before the dashboard port is bound, with an error naming the file and the cause, and tears down what it had already opened — timers, storage, the lock — so a refused start leaves nothing listening and nothing to clean up by hand. It reads the dashboard port, the bind interface, and the runner from this file and hands the last of those to every task it launches, so starting on guessed values would serve a dashboard on a port you did not configure with a runner you may not have. This joins the daemon's other hard startup preconditions — the credential gate and the [proxy bind](#proxy).

`lazy doctor` is the exception that keeps working: it reports the parse failure as a failed `lazy.toml parses` check and skips every config-dependent check rather than reporting defaults as if you had chosen them. It keeps working *without a daemon*, too — every other command auto-starts one and fails when that start fails, but doctor prints why the daemon isn't there and runs its remaining checks anyway. It is the command you reach for when nothing else runs, so it must not die of the thing it is meant to diagnose.

---

## `[models]`

Controls which AI model agents use by default.

| Key       | Type     | Default                         | Description |
|-----------|----------|---------------------------------|-------------|
| `default` | `string` | `"claude-opus-5"` | Default model for sessions. |

Values are raw model IDs — examples: `"claude-opus-5"`, `"claude-sonnet-5"`, `"qwen3.5:35b-a3b-coding-nvfp4"`.

```toml
[models]
default = "claude-opus-5"
```

**`default` is an Anthropic model name, so it applies only to agents that speak
Anthropic model names.** An agent may declare its own default instead: a Cursor
task with no explicit model runs Cursor's `auto` (Cursor picks the model), and a
Codex task runs `default` (the Codex CLI's own current default model), not
`models.default` — lazy's default is chosen for Claude Code and means nothing to
another vendor's registry.

**Every launch names a model.** Lazy always passes the model it resolved to the
agent CLI and refuses to start one without it, so a turn never silently runs
whatever the tool itself would pick. Codex's `default` is the one exception in
spelling only: it is passed by omitting the flag, which is how the Codex CLI
names its built-in default. `lazy chat` and `lazy pair` run the task's own model.
Lazy's own background calls (summaries, reports) run the builder profile's
`model`, else that agent's own default, else `models.default`.

**Cursor resolves short names itself.** A task that asked for `opus` may
actually run whatever snapshot cursor-agent currently maps that alias to
(Opus 4.5, Opus 5, …). Lazy records the concrete model the CLI reported
when the turn started and shows it next to the name you asked for
(`opus → claude-opus-4-5-…`) on `lazy show`, the web Turns tab, and the
turn report. A different family or an older version than the name
suggests is called out on that turn. An explicit per-task model (`lazy start --model`, the task's
`model`) still wins over the agent's default,
and so does a model pinned on the task's [agent profile](#agentsname--named-agent-profiles). Once a task has a model, every turn runs it — including on a profile that pins an `endpoint`, where the profile's `model` is only the default for a task that has none yet. Full precedence:

1. `--model` on the command
2. The task's model, else the profile's model
3. The agent's own default (Cursor: `auto`; Codex: `default`; Claude Code and Pi declare none)
4. A project default set outside the repository (where your deployment offers
   one), else `models.default`

Both entries in step 4 are one project-wide model name, so neither overrides an
agent's own default — that is what keeps a Cursor task off an Anthropic model it
cannot run. To pin one task anyway, give it a model explicitly (step 1 or 2).

**This precedence decides every turn lazy runs on a task, not only the ones you
launch by hand.** A model or effort you give a task once — on `lazy start`,
`lazy unblock` or `lazy edit` — is stored on the task, so the turns lazy starts
for you use it too: merge-conflict resolution during `lazy sync`, the wrap-up
steps that close a declared-final turn (the protected-file exchange, the
maintained-files and reactive nudges, the presentation walkthrough),
`lazy ask`, and an auto-resume after an
interruption. Nothing goes
back to the project default mid-task, and you never have to restate `--model` on
the next command to keep a task where you put it. Switching a task's agent with
`--agent` is the one exception: model names are not portable between agents, so
lazy re-resolves the model and effort for the new agent unless you pass
`--model` / `--effort` on the same command. A switch to a different agent
program also starts a fresh agent session (with the task's turn history handed
over in the next prompt) and recreates the task's container so the new agent
gets the right proxy wiring — reusing the old container would leave it without
those settings.

**Only a command you run changes a task's settings, and the last one wins.**
`lazy start`, `lazy unblock`, `lazy resume` and `lazy edit` with `--model`,
`--effort` or `--agent` move a task, as does the review UI's edit form; a change
takes effect on the task's next turn, so making one while a turn is running is
fine — it applies to the turn after it, not the one already going. Asking
a question is not one of them: an effort you give an ask covers that question
only, and the task's own settings are what its next work turn runs on. Changing
`models.default` or a profile in `lazy.toml` does not move a task that already
has its own model either — it applies to tasks that never got one.

**The short model calls lazy makes for itself are the exception, and they run on
your builder profile.** The summary written into a pull request at `lazy accept`,
`lazy report`, `lazy memory compact` and asking a question of a stored
conversation are each one prompt in and one answer out: no session to continue,
nothing kept warm, and nothing that a task's model would make cheaper. So they go
to the profile in [`[models.roles.builder]`](#modelsroles--the-default-profile-per-role)
— the one you already picked for talking to lazy yourself — at an effort lazy
fixes per kind, so a builder you drive at `xhigh` does not make every accept-time
blurb cost as much as the work it describes. The task each one is about is still
recorded against that task in your usage.

### `[models.roles.*]` — the default profile per role

Lazy distinguishes two model **roles**: the interactive **builder** (`lazy builder`, `lazy pair`, `lazy chat`, plus the short one-prompt calls lazy makes for you — the `lazy accept` summary, `lazy report`, `lazy memory compact`) and the **agent** that runs tasks (the task supervisor and all auto-triggered turns). Each role names one [agent profile](#agentsname--named-agent-profiles), and that profile decides everything about how the role runs — harness, model, upstream, credential.

| Key     | Type     | Default | Description |
|---------|----------|---------|-------------|
| `agent` | `string` | see below | Name of an agent profile. Unknown names are rejected at config load, with the available profiles listed. |

Defaults: the **agent** role falls back to [`[agent] agent_id`](#agent) (the project's default profile for new tasks), and the **builder** role to the built-in `claude-code` profile.

```toml
# Builder talks to real Anthropic; task agents run on a local Ollama model.
[models.roles.builder]
agent = "claude-code"

[models.roles.agent]
agent = "local-ollama"
```

A role is only a **default**. A task that names its own profile (`lazy create --agent <profile>`) runs on that profile, whatever the role says — which is the whole point of profiles.

> **The `backend`, `model` and `endpoint` keys were removed from this table.** A lazy.toml that still has them is rejected at load, with the exact `[agents.<name>]` block that replaces them printed. See [Migrating from role backends](#migrating-from-role-backends).

---

## `[agents.<name>]` — named agent profiles

A **profile** is the whole answer to "how does this task's agent run": which agent program drives it, which model it asks for, which upstream lazy's proxy forwards that traffic to, and which stored credential pays for it. You pick one **per task** with `--agent <name>` on `lazy create` / `start` / `edit` / `unblock`.

**These names are what every agent picker offers.** The web dashboard's *Agent profile* dropdown on the New-task and Edit pages lists your `[agents.<name>]` profiles first and the built-ins beneath them, and the `agent` argument of the `lazy_create` / `lazy_start` / `lazy_edit` / `lazy_unblock` MCP tools takes the same names. Harness names (`claude-code`, `codex`, `cursor`, `pi`) work everywhere because each is an implicit built-in profile. Picking a configured profile is the normal route; a one-off `--model` / `--effort` on the same command still overrides that profile for the single task, so an ad-hoc combination never needs a block of its own.

| Key          | Type     | Default | Description |
|--------------|----------|---------|-------------|
| `harness`    | `string` | the profile's own name, when that name is a harness | The agent program that drives the turn: `"claude-code"`, `"codex"`, `"cursor"`, or `"pi"`. Unknown values are rejected at load. |
| `model`      | `string` | the harness default (`qwen3.8:latest` for `pi`; otherwise the harness's own) | Model to ask for. **Required whenever `endpoint` is set** — model names belong to the endpoint, and lazy will not guess one. |
| `endpoint`   | `string` | the harness default (`http://localhost:11434` for `pi`, `https://api.openai.com` for `codex`; the proxy's primary upstream otherwise) | The upstream **lazy's proxy forwards this profile to** — never an address the agent dials. Host-perspective; see below. |
| `credential` | `string` | inferred from `endpoint` | Name of a stored credential (`lazy auth set <name>`) that pays for this upstream, or `"none"` for an upstream that authenticates nobody. |

```toml
[agents.local-ollama-pi]
harness = "pi"
model = "qwen3.8:latest"
endpoint = "http://localhost:11434"

[agents.claude-code]          # overrides the built-in profile of the same name
harness = "claude-code"
model = "claude-opus-5"

[agents.work-codex]           # same provider as the built-in codex profile,
harness = "codex"             # billed to a different key
model = "gpt-5-codex"
credential = "work-openai"    # any name you choose: `lazy auth set work-openai`
```

**Built-in profiles.** Profiles named `claude-code`, `codex`, `cursor` and `pi` exist implicitly, each with `harness` equal to its name and that harness's defaults. Two of them carry an upstream of their own instead of the proxy's primary one: `codex` runs `https://api.openai.com` (it is OpenAI-wire), and `pi` runs a **local Ollama** — `http://localhost:11434`, model `qwen3.8:latest`, no credential — because Pi is the local-model agent and `--agent pi` must not quietly spend a hosted one. Pointing Pi at Anthropic or anywhere else is a profile you declare. A `[agents.<builtin>]` block *replaces* the built-in of that name — which is how you pin a model or an upstream for every task on that harness. A project with no `[agents]` section behaves exactly as it did before profiles existed.

**Credentials are named objects.** `credential` names a key in lazy's credential store, not a provider type: `"anthropic"`, `"openai"`, `"openrouter"`, `"ollama"` and `"cursor"` are the provider-named defaults, and any other name works as soon as you run `lazy auth set <that name>`. Two profiles on the same provider share one credential unless one names its own. Omit the key and lazy infers it from the endpoint hostname:

| Endpoint | Inferred credential |
|----------|---------------------|
| `ollama.com` | `ollama` |
| `openrouter.ai` | `openrouter` |
| An address on this machine or your LAN | `none` — a local model server takes no key, so lazy does not send it one |
| Anything else | the credential for the harness's API (`anthropic`, or `openai` for Codex) |

A private gateway that *does* want a key just names one: `credential = "anthropic"`. Keys themselves never go in `lazy.toml` — see [Credentials](credentials.md).

**The wire format is derived, never configured.** Claude Code and Cursor speak the Anthropic Messages API; Codex speaks the OpenAI wire (Chat Completions / Responses); Pi speaks both, and its endpoint decides: `api.openai.com` and `openrouter.ai` put a Pi profile on the OpenAI wire, any other host on the Anthropic one. OpenRouter serves both APIs from one hostname, so each harness takes the one it speaks — Claude Code its Anthropic-compatible Messages endpoint, Codex and Pi its native OpenAI API. Lazy never translates between API shapes, so a profile whose endpoint speaks only the *other* wire (`api.openai.com` under `claude-code`, say) is rejected at load, naming the mismatch and the harnesses that do speak it. The wire also selects which paths the proxy will forward and which usage extractor reads the response, which is why it is not yours to set. For OpenAI-wire profiles the proxy forwards **only the OpenAI inference surface** (`/v1/chat/completions`, `/v1/responses`, model discovery) — never account, billing, or admin endpoints — and counts token usage from both endpoints, streaming or not, into `lazy stats tokens`.

**The profile chooses the upstream, never whether the traffic is proxied.** Every launch goes through lazy's audit/policy proxy, including profiles pinned at a local endpoint. The agent is always handed the proxy's address; where the request goes next is the proxy's decision, made per launch from the profile named on that launch's credential grant — evidence, not a header the agent could set. See [`[proxy]`](#proxy).

**Guardrails (fail hard, no silent fallback):**

- An unknown `harness`, an unknown key, a pinned `endpoint` with no `model`, a harness/endpoint wire contradiction, or a task naming a profile that does not exist — all rejected with an actionable error.
- Before every launch lazy **preflights** the profile's upstream for reachability. If it is unreachable, the launch fails with an actionable error — lazy **never** silently falls back to another upstream.
- A pinned profile's `model` is **never silently substituted**; a task that sets its own model (`lazy edit --model`) runs that one instead — a logical alias like `"claude-opus-5"` does not exist in an Ollama registry. Unresolvable model names surface loudly (e.g. Ollama's `404 model not found`).

**Omitting `endpoint` inherits the harness default, and that default can move.** Two harnesses have one of their own: `pi` runs a local Ollama and `codex` runs `https://api.openai.com`. So a profile of yours that names a model but no endpoint follows its harness — `[agents.my-pi] harness = "pi", model = "claude-opus-5"` runs against the local Ollama, not Anthropic, and `claude-opus-5` is not a model that server has. Lazy warns at startup for exactly that combination (a harness default upstream that is not Anthropic, plus a recognizably Anthropic model), naming the profile and the `endpoint = "https://api.anthropic.com"` line that pins it where you meant. It is a warning, not a refusal: only you can say which service you wanted.

**`endpoint` is host-perspective.** The proxy runs inside the daemon, which is a host process, so it makes the upstream call from the host. Write `endpoint` the way the host reaches the service: `http://localhost:11434`, a LAN IP, a real DNS name. A container-perspective `host.docker.internal` spelling is read as `localhost` (the same service, from the host) with a **warning** naming the value it read; update it to clear the warning. Other hostnames are used exactly as written. Container and host launches alike get the proxy's own address in `ANTHROPIC_BASE_URL`, and only *that* address differs between them.

### Two profiles, two upstreams, one project

Because the upstream rides the profile rather than the role, one project can run different tasks on different services at the same time — including two profiles of the *same* harness, each billed to its own key:

```toml
[agents.house-codex]          # the team's OpenAI account
harness = "codex"
model = "gpt-5-codex"

[agents.work-codex]           # a second OpenAI key, for client work
harness = "codex"
model = "gpt-5-codex"
credential = "work-openai"

[agents.local-pi]             # a model server on this machine — no key at all
harness = "pi"
model = "qwen3.8:latest"
endpoint = "http://localhost:11434"
```

```bash
lazy create "Ship the invoice fix" --agent work-codex
lazy create "Sweep the changelog"  --agent local-pi
```

Each task's traffic reaches its own upstream with its own credential, and the others are untouched.

### Migrating from role backends

Three older spellings were removed. Lazy **refuses to load** a `lazy.toml` that still uses one, rather than reinterpreting it — the keys still parse, so a tolerant reader would keep launching against a different upstream than the file says. Each refusal prints the exact replacement block:

| Removed | Replaced by |
|---------|-------------|
| `[models.roles.<role>] backend` / `model` / `endpoint` | An `[agents.<name>]` profile plus `[models.roles.<role>] agent = "<name>"` |
| The `[ollama]` block | One `[agents.<name>]` profile with that endpoint, plus `[agent] agent_id = "<name>"` |
| `[proxy] openai_upstream` | The `endpoint` of the codex profile |

There is one carve-out, and it is narrow: a bare `[ollama]` header with **no keys under it** — every line commented out, say — configured nothing before profiles either, so there is nothing to reinterpret. Lazy reports it as removed and carries on rather than refusing; delete the dead header whenever it suits you. Anything else written under that name still refuses, including the array-of-tables spelling `[[ollama]]`, which carries real settings however unusual it looks. `lazy doctor` names the section and prints the replacement in both cases — including for a file that no longer loads, which is exactly when you need it.

`lazy doctor` reports the same thing, and **`lazy doctor --fix agents` rewrites the file for you** — it shows the diff and asks before writing (`--yes` for scripts), preserves your comments and key order, and refuses to write anything it cannot re-validate. Where the rewrite would have to invent a model name it stops and tells you which key to add instead of guessing one.

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
| `backend`       | `string` | `"external"` | Storage backend. Only `"external"` (file storage outside the repo) is supported. |
| `external_path` | `string` | `""`         | Path for external storage. Defaults to `~/.lazy/<project-name>` if empty. Leading `~/` is expanded at load time. |

```toml
[storage]
backend = "external"
external_path = "~/.lazy/my-project"
```

To set this without the interactive prompt — provisioning a project from a script
or a fleet host — pass `lazy init --external-path <dir>`. It writes
`backend = "external"` and `external_path = <dir>` into the project's
`lazy.toml`, inserting the `[storage]` section or replacing an existing
`external_path`, and creates the directory. Because the flag exists to *repoint*
the store, it is also the one `init` invocation that skips the startup check
refusing to run against a configured storage path that does not exist.

Task state lives in the external store — tasks, sessions, turns, commits and the
rest. A few purely local, machine-describing streams stay on disk in the
project's own `.lazy/` directory: wait intervals (`.lazy/waits/`) and trace spans
(`.lazy/traces/`). They are append-only observability data with no relational
consumers, and they describe the machine that ran the work rather than the project.

The legacy `"in-repo"`, `"orphan-branch"`, and `"postgres"` backends have been removed; lazy fails hard if it sees them and prints migration guidance.

---

## `[git]`

Git-related configuration.

| Key                     | Type     | Default  | Description |
|-------------------------|----------|----------|-------------|
| `default_branch_prefix` | `string` | `"lazy"` | Prefix for task branches (e.g., `lazy/fix-bug`). Set it to `"wip"` and new task branches are named `wip/fix-bug`. A trailing slash is optional — `"wip"` and `"wip/"` mean the same thing. |
| `lfs_check`             | `string` | `"refuse"` | Start-time git LFS check on repos that use LFS: `"refuse"` blocks the start when the LFS filter would not run, `"warn"` starts anyway and records a warning, `"off"` disables it. Does not affect the accept-time guard, which always runs — see [LFS guard](lfs-guard.md). |

Changing `default_branch_prefix` renames nothing. Branches that already exist keep
their names and their tasks keep working; the new prefix applies to branches created
from then on. Change it between releases rather than with tasks in flight.

Two things to know before you pick a value:

- **Everything under the prefix is treated as a task branch.** Lazy merges task
  branches locally rather than opening a pull request for them, so don't point the
  prefix at a namespace you already use for real integration branches. With
  `default_branch_prefix = "release"`, a branch named `release/2.0` would be taken
  for a task branch. A namespace of your own — `wip`, `tasks`, `agent` — avoids this.
- **The prefix is project-wide.** Every task worktree shares one git repository
  and therefore one branch namespace; like every setting, the prefix is read
  from the project root's `lazy.toml`.

A prefix git cannot use in a branch name (spaces, a leading `/`, and so on) is
rejected when the config loads, naming the file and the key — rather than failing
later, partway through starting a task. An empty value means "unset": you get the
default `lazy`.

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
| `agent_id`                   | `string` | `"claude-code"` | Default [agent profile](#agentsname--named-agent-profiles) for task execution — a profile name, not a harness name. The built-in profiles `"claude-code"`, `"codex"` (OpenAI Codex CLI), `"cursor"` (Cursor CLI) and `"pi"` (Pi coding agent — see [pi-agent.md](pi-agent.md)) are always available; anything you declare in an `[agents.<name>]` block is equally valid here, so `agent_id = "local-ollama-pi"` is how you make a custom profile the default. Validated against the resolved profiles at load time; an unknown name is rejected and the available profiles are listed. Switch with `lazy system agent set <name>` (comment-preserving; takes effect on the next launch, no daemon restart); per-task override via `lazy create`/`start`/`edit`/`unblock --agent <name>`. This value is the default only for a task created from scratch: a subtask, clone, redo or rework inherits the profile of the task it came from, so a Cursor task's derivatives stay on Cursor. Switching profiles mid-task (via `edit` or `unblock`) starts a new session on the new profile; sessions are not migrated, and the task's model and effort are re-resolved unless you also pass `--model` / `--effort` on the same command. `lazy edit --agent` and `lazy start --agent` are refused while the task is `working` — wait for it to block, or run `lazy stop` first. The next prompt includes a distilled copy of the task's turn history plus a short branch orientation (commits and changed files). The task's profile also resolves merge conflicts when a sync pulls the parent branch in — a Cursor task's conflicts are resolved by Cursor, with the task's own model and session, under that harness's watchdog defaults. `lazy system agent set-key <profile>` stores the API key for a profile whose harness reads one out of its own config — Cursor and Codex (per-project, stored 0600 in `~/.lazy/daemon/<slug>/agent-credentials.json`, outside the repo, which every task container mounts read-only; read from a masked prompt or piped stdin, never an argument; `CURSOR_API_KEY` / `OPENAI_API_KEY` override, and a credential stored with `lazy auth set <name>` takes precedence over the file — see [Credentials](credentials.md)). Cursor also accepts `cursor-agent login` on the host, but containers need a key. Claude Code and Pi have no key of their own: `set-key` is refused for them and points you at `lazy auth set <credential>`, because lazy hands those harnesses the profile's credential through the proxy. Cursor, Codex and Pi tasks pair in-container ([Pairing](pairing.md)); conversation capture and the pairing summary are Claude Code and Pi only. |
| `by_type`                    | `table`  | *(empty)*       | Per-task-type agent overrides (`[agent.by_type]`). Keys are task type names (`fix`, `feature`, `spike`, …); values are agent profile names. Unmapped types use `agent_id`. An explicit `--agent` still wins; subtasks, clones, redo and rework inherit the source task's profile and ignore this table. Unknown type names or profile names are rejected at load time. See `lazy.toml.example` for the full list of task types and which dedicated commands (`lazy fix`, `lazy refactor`, …) exist. |
| `watchdog_output_timeout_ms` | `number` | `1800000`       | Hang backstop: kill the agent process after this many ms **without forward progress**. Resets on every completed step, so it bounds a single step, not the turn. A kill that captured nothing (no result, no new commits) is relaunched automatically with backoff; a kill after the agent had captured work stops for a human. `0` = use the agent's own default; the built-in agents all declare none (they stream their progress, so this value is the only guard), which means `0` switches the guard off. Default is 30 minutes. |
| `wind_down_timeout_ms`       | `number` | `60000`         | How long to wait for the agent process to exit *after* it has emitted its final result, before killing it. `0` = wait indefinitely. Default is 60s. |
| `effort`                     | `string` | `"medium"`      | Reasoning effort level passed to Claude Code via `--effort` for task agents. Valid: `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"`. Higher levels spend more tokens thinking before responding. |

```toml
[agent]
agent_id = "claude-code"
watchdog_output_timeout_ms = 3600000  # 1 hour without forward progress
wind_down_timeout_ms = 60000          # 60s to exit after the summary lands
effort = "medium"

[agent.by_type]
fix = "cursor"
feature = "claude-code"
```

`lazy start --effort <level>` overrides this for a task, and the level then
**persists on the task** — every later turn uses it. To dial a running task back
down (or up) between turns, use `lazy edit <task> --effort <level>` (or the
`effort` field of the `lazy_edit` MCP tool); like `--model`, it is one of the
few edits allowed on a task an agent has already worked on, and it takes effect
on the next turn.

### How a turn is guarded

The two timeouts above are deliberately different guards, and only one of them
is ever armed at a time:

- **While the agent is working**, `watchdog_output_timeout_ms` applies. It is a
  hang backstop, not a turn deadline — there is no time limit measured from
  launch, from a commit, or from any other event. The supervisor reads the
  agent's output stream and resets the timer on every step the agent
  *completes*, so a turn made of many long steps runs as long as it needs. What
  the value actually bounds is a **single step**: a tool call that runs longer
  than the timeout without finishing is killed. Keep-alive heartbeats emitted
  by a stuck tool call deliberately do **not** reset the timer — a wedged MCP
  call emits one every 30s forever, so counting them as progress would make it
  immortal. Every built-in agent streams its progress, so all of them are
  guarded this way; an agent that produced no stream would fall back to the
  cruder "any output counts", which cannot tell a working turn from a wedged
  one when the tool only prints at the end.
- **After the agent emits its final result**, the work is safe on disk and the
  summary is in hand, so `wind_down_timeout_ms` gives the CLI a short window to
  exit and then kills it (SIGTERM, then SIGKILL after 5s). A kill here is
  recorded as a *successful* turn — the summary is preserved.

Both guards cover merge-conflict resolution turns too: when a sync hits
conflicts an agent resolves them, and that is an ordinary agent turn.

A third clock covers the **wrap-up turn** — the closing steps that run once
after an agent (or a human) declares a task final. The daemon waits at most
`watchdog_output_timeout_ms` plus a 5-minute margin for the whole wrap-up, so
that backstop always fires *after* the agent's own watchdog rather than racing
it — the watchdog is the clock that can say something useful ("the agent stopped
producing output"), so it should be the one that fires first. Raising the
watchdog raises the wrap-up backstop with it; there is no separate knob.

`graceful_exit_timeout_ms` is the old name for `wind_down_timeout_ms` and is
still read, so existing configs keep working.

---

## `[review]`

How a task is reviewed once it declares its work finished. The full reasoning —
and the run that set the default — is [the review paradigm](review-paradigm.md).

| Key             | Type     | Default      | Description |
|-----------------|----------|--------------|-------------|
| `mode`          | `string` | `"low_high"` | `"low_high"`: the writer reviews its own work inside its own session — a draft at `draft_effort`, a hostile read-only self-review at `review_effort`, one revise pass. Fast; its outcome is recorded as a review and does not gate under the default `gate`, but `gate = "always"` makes it. `"separate"`: a reviewer runs afterwards in a new session, reads the branch cold, and its verdict **does** gate accept — three to four times the wall-clock and the tokens. `"off"`: no review, and nothing gates accept. Per task: `lazy create`/`start`/`edit --review off\|low-high\|separate`, which pins the mode on the task so a later change to this default leaves running tasks alone. |
| `auto_fix`      | `bool`   | `false`      | `"separate"` mode only: whether a review that found something starts a fix turn by itself. `false` parks the task with its findings attached and hands back to whoever is driving — a person, or a [cluster](cluster-tasks.md) driver — because whether another ~30-minute round is worth it is a judgement the daemon cannot make. The rounds that *are* started stay bounded by the two-round cap and `[cluster] max_child_fix_rounds`. In `"low_high"` mode the fix is in-session by definition and this key does not apply. |
| `gate`          | `string` | `"auto"`     | When a recorded review holds the merge. `"auto"`: the mode decides — `"separate"` gates, `"low_high"` and `"off"` do not — except that a review somebody explicitly asked for (`lazy review`, or a cluster driver's `lazy_review`) always gates. `"always"`: any recorded review gates, including the low-high self-review. `"never"`: nothing gates, in any mode. Per task: `--review-gate auto\|always\|never`. |
| `draft_effort`  | `string` | `"low"`      | Effort for the `low_high` draft and revise phases. When that mode is on, this **replaces** `[agent] effort` for work turns. |
| `review_effort` | `string` | `"xhigh"`    | Effort for the `low_high` self-review phase — a floor, not a fixed value: a draft running higher raises the review to match, so a review never runs weaker than the work it reviews. |

```toml
[review]
mode = "low_high"
auto_fix = false
gate = "auto"
draft_effort = "low"
review_effort = "xhigh"
```

**Which findings hold a merge.** When a review counts (see `gate` above), accept
is held by a finding at critical or high severity, a failed or never-dispatched
review, an outstanding blocking raise, or a report whose own security /
data-integrity sweep names something no finding covers. Findings at **medium or
below do not** — they are a reviewer's opinion about work you are about to read
anyway, and holding every merge on a style nit cost a full agent turn or a
person per finding. `lazy accept <task> --allow-review-issues` overrides what
does hold.

**Accept never silently disregards a review.** When your settings let a merge
through over a review that found something — the mode ignores it, or the gate is
`never` — accept says so in one line and points you at `lazy show`. A review that
gates refuses instead, which is its own notice; a clean one is not mentioned.

### Every review setting is resolved PER TASK

`[review]` is the project's **default**, not the last word. Each of `mode`,
`auto_fix` and `gate` resolves in three levels, independently of the others:

    project config  →  parent task  →  task

A task that says nothing about a setting inherits its parent task's value, and a
top-level task inherits the project's. So a [cluster](cluster-tasks.md) driver
sets a mode once on itself and every child follows unless it overrides — and a
child that overrides only the mode still inherits its parent's gate.

Only what somebody explicitly **set** is inherited, never a value an ancestor
merely ended up with, so a parent task nobody configured leaves its children on the
project default. A choice does travel the whole tree — configure a parent task and its
grandchildren follow. `lazy show <task>` says where each value came from, and
names the task the choice was made on — see
[reading the Review line](review-paradigm.md#reading-the-review-line).

Set any of them per task with `lazy create` / `start` / `edit`:

```
lazy create --review separate --review-gate always --goal "Rotate the signing keys"
lazy edit <task> --review low-high
lazy start <task> --review-auto-fix on
```

The MCP tools `lazy_create`, `lazy_start` and `lazy_edit` take the same three as
`review`, `review_gate` and `review_auto_fix`, and the web New-task form offers
them as three dropdowns with an **(inherit)** option.

The resolved values are **pinned on the task** the first time it launches, the
way `--model` and `--effort` are: sticky per task, last action wins. A project
default you change later moves new tasks and leaves running ones exactly where
they were. `lazy show <task>`, `lazy_show` and the task page all print the
effective values on one line.

**`--effort` survives `low_high` mode.** When somebody chose an effort for
THIS TASK — `--effort` on `create`, `start`, `edit` or an unblock — the low-high
draft runs at THAT effort. Running a task you set to `high` at `low` because the
project switched review modes would be a silent downgrade of your work.

A project-wide `[agent] effort` does not outrank `draft_effort` for the draft:
it is the fallback the other phases resolve from, and a project default is not
somebody deciding that one particular task deserves more thinking. If it did
outrank it, `draft_effort` would have no effect on any project that states an
effort at all.

**Migrating.** The three `[agent] low_high_loop*` keys moved here and are still
honoured meanwhile, with `lazy doctor` naming each replacement:
`low_high_loop = true` → `mode = "low_high"`, `low_high_loop = false` →
`mode = "separate"` (which is what `false` meant: no in-session loop, and the
daemon dispatching its own reviewer), `low_high_loop_draft_effort` →
`draft_effort`, `low_high_loop_review_effort` → `review_effort`. Setting both
spellings to values that disagree is refused at load rather than guessed.

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

## `[serve]`

Ports this project's dev servers listen on **inside a task's environment**. Not
to be confused with `[server]` below, which is lazy's own dashboard.

| Key        | Type       | Default | Description |
|------------|------------|---------|-------------|
| `ports`    | `number[]` | `[]`    | Container ports to publish. Each is addressed by its own number: `lazy url my-task 3000`. |
| `services` | `table`    | `{}`    | Named ports (`web = 3000`), addressed by name or number: `lazy url my-task web`. Names must start with a letter, so a name is never mistaken for a port. |
| `start_services_cmd` | `string` | *(unset)* | **Import only.** The **Start services** command is designated from a task's Services card and saved in the project's store, not here. If this key is set, the daemon imports it into the store once, the next time it starts, and does not read it again afterwards — change or clear the command from the Services card. Must be a non-empty single line. |

```toml
[serve]
ports = [5173]

[serve.services]
web = 3000
api = 8080
```

With no `[serve]` section nothing is published and container launch is byte-identical
to before — this is opt-in.

Each declared port is published to an **OS-assigned** host port bound to
`127.0.0.1` (`-p 127.0.0.1:0:<port>`). The OS-assigned half is what lets parallel
tasks all serve on 3000; the loopback half keeps a task's dev server off the
network the machine is on. The runtime is the source of truth for the mapping —
`lazy url <task>` asks it, so the answer is never stale:

```bash
lazy url my-task              # every service, name → URL
lazy url my-task web          # exactly one bare URL (scriptable)
```

`lazy show` lists the same mapping, and the dashboard's task detail page renders
it as clickable links. The task *list* deliberately does not — resolving the live
mapping costs a runtime call per task.

A malformed section (a non-array `ports`, a port outside 1–65535, a duplicate
port across the two spellings, a name that starts with a digit) fails at config
**load** time, naming the offending value.

**Changing `[serve]` takes effect on the next container.** Published ports are
fixed when a container is created — no container runtime can add one to a running
container. Recreate it with `lazy shell <task> --restart` (refused
while the agent is mid-turn).

`[serve]` is read from the **project root's** `lazy.toml`, like every other
setting — a task worktree's copy is ignored. A branch that adds a service sees
it once the change is on the root, which is also what the container actually
publishes: the ports a task's container exposes are fixed from the root's
`[serve]` when it is created. With docker/podman runners, published ports map
to loopback; `lazy url` prints the mapping.

For a port you did *not* declare — a database, a debug server, a one-off look —
use `lazy forward <task> <port>` instead of editing `[serve]`: it forwards on
loopback for as long as the command runs and needs no container restart.

See [Reaching a task's dev server](serve-ports.md) for the workflow.

---

## `[server]`

Web dashboard server settings. Unrelated to `[serve]` above: this is lazy's own
dashboard, not your project's dev servers.

| Key             | Type     | Default       | Description |
|-----------------|----------|---------------|-------------|
| `port`          | `number` | `26024`       | Starting port for the web dashboard server. If busy, the daemon tries the next few ports (a bounded window of 20) so several projects can run on one host. If the whole window is occupied — almost always stray daemons squatting the range — startup fails with an actionable error pointing at `lazy daemon kill-stray` rather than silently binding a far-off port. |
| `bind`          | `string` | `"127.0.0.1"` | Network interface the daemon's TCP server binds to. Loopback by default so the dashboard and the `/mcp` + `/rpc` endpoints are not reachable from other machines. Set to `"0.0.0.0"` to expose on all interfaces. The dashboard requires a signed-in browser, while daemon APIs use their own credentials. The dashboard URL printed by `lazy daemon status`/`lazy daemon dashboard-url` reflects this value; a loopback or `0.0.0.0` bind is shown as `lazy.localhost`, the dashboard's own local hostname. |
| `dashboard_url` | `string` | unset         | Exact public origin used to reach the dashboard through a trusted reverse proxy, for example `"https://lazy.example.com"`. A trailing slash is ignored and a port is kept (`"https://lazy.example.com:8443"`). When set, dashboard links use this origin and dashboard authentication accepts only its host and origin — the local `http://lazy.localhost:<port>` address is refused. Paths, queries, fragments, and credentials are rejected. Restart the daemon after changing it. |
| `sync_interval` | `number` | `60`          | Interval in seconds for the daemon's background sync. Set to `0` to disable. |

To use a tunnel such as ngrok or Tailscale serve, point it at the daemon's
local dashboard port, set `dashboard_url` to the tunnel's HTTPS origin, and
restart the daemon. Treat the tunnel as a trusted proxy: this setting
deliberately makes that public host the dashboard's sign-in and session
boundary. The dashboard still requires a one-time login link from
`lazy dashboard`.

- **The proxy must forward the original `Host` header.** ngrok, Caddy and
  Tailscale serve do by default. nginx's `proxy_pass` does not unless you add
  `proxy_set_header Host $host;`, and Apache needs `ProxyPreserveHost On`. A
  proxy that replaces it gets a "Wrong address" page naming the host that
  actually arrived.
- **Prefer an HTTPS origin.** The session cookie is marked `Secure` on HTTPS.
  Also, browsers only say which site a page load came from when the origin is
  secure. Lazy needs that signal to sign you in when you click a login link or
  a task link in another app, such as a chat or email. On a plain `http://`
  public origin, paste such links into the address bar instead of clicking them.
- **The daemon reads `dashboard_url` when it starts.** If you change it while
  the daemon is running, `lazy dashboard` and `lazy daemon dashboard-url`
  keep printing the address being served and add one line naming both
  addresses: run `lazy daemon restart` to apply it. They say so too when
  `dashboard_url` sits under a table other than `[server]`, where it is
  ignored.
- **`lazy doctor` shows what is in effect**: the origin that links and sign-in
  use and the local address that is refused, or what disagrees and how to fix
  it.

**Native Linux Docker note:** When `bind` is left at the loopback default and a container runner (`docker`/`podman`) is configured, on Linux the daemon *additionally* binds the detected docker/podman bridge gateway (`docker0`, typically `172.17.0.1`) on the same port. This is required because containers reach the host via `host.docker.internal` → the bridge gateway (a non-loopback interface), which a loopback-only daemon would refuse. The bridge interface is host-local and reachable only from the container network — **not** routable from the LAN — so it does not widen LAN exposure. macOS/Windows Docker Desktop need nothing extra (`host.docker.internal` is proxied to the host's loopback). If you set `bind` explicitly, that value is used as-is with no extra interfaces; if the bridge can't be detected on Linux the daemon logs an actionable warning rather than letting agents fail to reach it.

---

## `[runner]`

Controls how agent containers are executed.

Can also be specified as a top-level string for backward compatibility (e.g., `runner = "docker"`), which lazy translates into `[runner] type = "..."` at load time and warns about.

| Key    | Type     | Default    | Description |
|--------|----------|------------|-------------|
| `type` | `string` | `"docker"` | Runner type: `"docker"` or `"podman"`. |

Agents run in isolated containers. A lazy.toml that still requests the removed
host-process runner fails at load time with an actionable error naming Docker.

```toml
[runner]
type = "docker"
```

Legacy `[runner]` keys for host-process permission posture (`permission_mode`,
`sandbox_*`, `verify_sandbox_boundary`) remain in the schema and are still
validated if present, but only container runners are supported — remove unused
keys from new configs.

---

## `[remote]`

Remote integration for push, PR/MR creation, and comment syncing.

Comment syncing imports each PR/MR comment into the task exactly once, whenever it becomes visible. This includes line comments, general comments, and GitHub review summaries, and it includes review comments posted long after they were drafted, which is how bot reviewers post. Comments lazy wrote itself are skipped. Each imported comment remembers which forge comment it came from, so two comments with the same words stay two comments. When a comment is edited on the forge, the edit is imported too: if the agent has not been shown the comment yet, its copy is updated in place; if it has, the new version arrives as a new comment that names the one it replaces.

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

For a **top-level task created with `--parent <branch>`**, `--force-local` means *that branch's* local ref — never whatever the repository currently has checked out. If the stored target branch cannot be resolved at all (deleted, renamed, or never created locally), `lazy start` fails and names the branch rather than silently basing the task on the repository default; fetch or restore the branch, or retarget the task with `lazy reparent <task> <parent>`.

### `auto_approve` on protected branches

When the target branch (usually `main`) has protection rules requiring approval, the accept path has two modes:

- **`auto_approve = false` (default)**: lazy requires an *external* approval to exist on the PR/MR before merging. Without one, `lazy accept` fails with a `409` and tells you to run `lazy submit` and wait for review.
- **`auto_approve = true`**: lazy submits its own approving review immediately before evaluating the merge gates, and skips the `reviews` gate when computing whether the accept is blocked (because the approval may not have propagated through the forge API yet). This is aimed at sole developers who don't want to manually approve their own MRs. It does **not** bypass other gates (CI checks, unresolved threads, merge conflicts) — those still block the accept.

Use `auto_approve = true` only when self-approval is acceptable by your team and forge policy.

If the forge refuses the approval — because you authored the request, because an approval already exists, or because your account may not approve there — lazy stays quiet: that is the expected answer, not a fault, and warning about it on every accept would bury the warnings that matter. The accept then goes on to the merge exactly as described above — the `reviews` gate is skipped either way — so if the approval was genuinely required, it is the forge that refuses the merge, and the accept fails with the forge's own reason. Lazy does warn when the refusal turns out to be your credential: on GitLab, where every refusal and an expired token share the same `401` response, it checks `glab auth status` before deciding, and tells you to run `glab auth login` when that is what is wrong.

This approval is the **only** review lazy ever submits to a PR/MR, and it exists because the forge will not let the merge through without one. Lazy posts no review findings, no accept or reject reviews, and no comments of any kind — see [reviews stay on the task](review.md#reviews-stay-on-the-task). Everything else lazy writes to a pull request is creating it and keeping its own section of the description current.

### GitHub-specific options

Available when `driver = "github"`. Authentication is handled by `gh` CLI (`gh auth login`).

| Key                | Type   | Default | Description |
|--------------------|--------|---------|-------------|
| `github_auto_push` | `bool` | `true`  | Automatically push task branches (after each agent turn, on the background sync, and when a task starts). Set `false` to keep task branches local until you ask for a push — see [what `auto_push = false` covers](#what-auto_push--false-covers). |
| `github_dangerously_sync_comments_in_public_repos_and_open_yourself_to_prompt_injection` | `bool` | `false` | Sync PR comments in public repos. **Security risk** — enables prompt injection via public comments. |

#### GitHub Enterprise Server

`driver = "github"` also works against a GitHub Enterprise Server install — the
remote's hostname is read from the git remote, so `git@github.mycorp.com:team/app.git`
and `https://github.internal.example/team/app.git` resolve to `team/app` on that
host. Authenticate `gh` against the install first:

```bash
gh auth login --hostname github.mycorp.com
```

Nothing in `lazy.toml` needs to name the host. `lazy doctor` verifies that `gh`
is logged into *that* host specifically — `gh auth status` on its own exits 0
whenever gh is logged into any host, which on an Enterprise remote is usually
github.com — and fails the check by name if it is not:

```
✗ GitHub authentication (github.mycorp.com)
  gh is not authenticated to github.mycorp.com, the host of remote 'origin'. Run: gh auth login --hostname github.mycorp.com
```

Note that `gh` resolves a bare `owner/repo` and all `gh api` requests against
*its* default host, so if you are logged into both github.com and an Enterprise
install, lazy pins the Enterprise host explicitly on every call it makes, but
ad-hoc `gh` commands you run yourself will not be.

### GitLab-specific options

Available when `driver = "gitlab"`. Authentication is handled by `glab` CLI (`glab auth login`).

| Key                | Type   | Default | Description |
|--------------------|--------|---------|-------------|
| `gitlab_auto_push` | `bool` | `true`  | Automatically push task branches (after each agent turn, on the background sync, and when a task starts). Set `false` to keep task branches local until you ask for a push — see [what `auto_push = false` covers](#what-auto_push--false-covers). |
| `gitlab_dangerously_sync_comments_in_public_repos_and_open_yourself_to_prompt_injection` | `bool` | `false` | Sync MR comments in public repos. **Security risk** — enables prompt injection via public comments. |

```toml
[remote]
driver = "github"
git_remote = "origin"
auto_approve = false
# offline = true   # stay offline permanently (no midnight auto-expiry)
github_auto_push = true
```

#### What `auto_push = false` covers

`github_auto_push = false` (and `gitlab_auto_push = false`) means "don't push my task
branches behind my back". It turns off the pushes lazy fires on its own:

- publishing a task's branch when the task starts
- the push after each agent turn
- the branch export on the background sync
- the push at the end of a `lazy pair` session

Your task branches then stay local, and the forge never sees them until you ask.

It is not a global "never push". Commands you run by name still do what their name
says: `lazy submit` pushes the branch so it can open the PR/MR, and `lazy accept`
pushes the parent branch when a merge needs it — without that push the remote parent
would permanently diverge from your local one.

The driver-specific keys (`github_*`, `gitlab_*`) are always valid at the schema level — lazy won't warn about GitHub keys while you're temporarily using the `local` driver.

The legacy `[remote_github]` section is no longer supported; lazy fails hard if it sees one and tells you to move the keys under `[remote]` with a `github_` prefix.

---

## `[docker]`

Docker image configuration for agent containers.

| Key            | Type       | Default | Description |
|----------------|------------|---------|-------------|
| `dockerfile`   | `string`   | `""`    | Path to a custom Dockerfile, relative to the project root. If empty, lazy uses the base image (Ubuntu with Claude Code + passwordless sudo). Agents install what they need via `apt-get`. |
| `build_inputs` | `string[]` | `[]`    | Files whose **contents** are part of the image's identity, relative to the project root. Changing one rebuilds the image on the next container start, exactly as editing the Dockerfile does. |
| `run_args`     | `string[]` | `[]`    | Extra `docker run` arguments applied verbatim, in order, before the image name when a **task container** is created. They widen the container's privileges and apply to **every** task. |

```toml
[docker]
dockerfile = "Dockerfile.lazy"
build_inputs = ["Gemfile.lock", "yarn.lock"]
```

The path always resolves against the **project root** — a task worktree's copy of the Dockerfile never governs the image *automatically* (task branches are agent-writable, and an image derived from one without consent would let an agent's Dockerfile edits execute as build steps on the host).

Two human-consented ways to use a worktree's Dockerfile:

1. **Per-task pin** — from a terminal, `lazy create` / `start` / `edit` with cwd anywhere inside a task worktree can ask to build that worktree's `Dockerfile.lazy` and pin it on the task (subtasks inherit it; `lazy clone` / `lazy redo` start fresh with the root image and warn if the source had a pin). Later turns use the pin with no prompt.
2. **Upgrade adoption** — from a terminal, `lazy upgrade` (incl. `--images`) may ask to adopt a worktree's `Dockerfile.lazy` for the image build **and** the restarted daemon. Your cwd may be anywhere inside the task worktree (not only its root). Each rebuild first announces any existing adoption — on a TTY you choose whether to keep it (default yes); non-interactive runs keep and log. A new worktree Dockerfile is offered only when cwd is inside that worktree and its content differs (default no). Adoption is stored in daemon runtime state (not `lazy.toml`), applies to all launches that do not already have a per-task pin, and lasts until the next upgrade rebuild decides again. `lazy doctor` and the daemon startup log report it.

**The build context follows the Dockerfile.** A worktree's `Dockerfile.lazy` describes the tree it lives in — its `COPY` lines name files on that branch. So a consented build (either flow above) uses **that worktree directory** as the docker build context, not the project root, and the prompt names it before you answer:

```
Context:    /path/to/.lazy/worktrees/my-task (this worktree, as it is on disk)
```

Three things follow from that:

- **It is the directory as it is on disk**, exactly like running `docker build` in it yourself: uncommitted and untracked files are part of the build, and `.dockerignore`, submodules and Git LFS behave as they do in that checkout. The one thing that is not read live is `Dockerfile.lazy` itself — the exact bytes you were shown at the prompt are what gets built.
- **Two worktrees with the same `Dockerfile.lazy` build two different images**, instead of one silently reusing an image built from the other's files.
- **The worktree's commit at build time is recorded with the image** and shown by `lazy show`, `lazy doctor` and `lazy upgrade` as "HEAD when built". It tells you when the image was built, not what went into it — the build read the directory live.

A plain `dockerfile = "..."` in `lazy.toml` is unaffected: it lives at the project root and is built with the project root as its context, as before.

For a permanent project-wide custom image, set `dockerfile` in `lazy.toml` to a path under the project root.

`lazy upgrade` prints the exact `Config:` and `Dockerfile:` paths it reads, marking adoption when present, so the source is always visible.

### `build_inputs` — keeping the image in step with your lockfiles

Lazy rebuilds the agent image when the **Dockerfile text** changes, but on its
own it cannot notice when the build *context* changed: a Dockerfile that does

```dockerfile
COPY Gemfile.lock .
RUN bundle install
```

builds once, and a later `bundle update` changes neither the Dockerfile text nor
lazy's idea of the image — so the image silently drifts from the lockfile until
someone remembers to force a rebuild. Declaring the lockfile as a build input
closes that gap: its content hash is folded into the image identity, so the next
container start rebuilds and says why:

```
Rebuilding image lazy-custom-974539f11375:0.21: Gemfile.lock changed (this can take several minutes).
```

Things worth knowing:

- **Only meaningful for files the Dockerfile actually `COPY`s.** Docker keys a
  `RUN bundle install` layer on the Dockerfile text alone, so if the file never
  enters the build context, the rebuild this triggers is a guaranteed no-op.
- **A declared file that does not exist is a hard error** at container start,
  naming the file — the same way a missing `dockerfile` fails. The alternative
  ("hash it as absent") makes the case that actually happens — a typo — a
  permanent silent no-op with no signal anywhere.
- **Entries are project-root-relative**; absolute paths and `..` are rejected at
  config load.
- **The image name does not change.** A lockfile bump rebuilds the image *in
  place* rather than minting a new `lazy-custom-<hash>` per bump and leaving
  orphaned images behind. Only the Dockerfile text determines the image name.
- **Renaming a declared input is a change** even if the bytes are identical —
  the Dockerfile `COPY`s it by name, so the built image genuinely differs.
- **Rebuilds are serialized per image.** Starting eight tasks at once right
  after a lockfile bump triggers **one** build, not eight: the rest wait and
  then find the image current. This is an in-process lock in the daemon, which
  covers the fan-out that matters. A cross-process race remains — running
  `lazy upgrade` or starting a builder from the CLI while the daemon is fanning
  out can produce a second build — and is left open deliberately: it is rare,
  and the loser just rebuilds an image that is already correct.

### `run_args` — extra `docker run` arguments for task containers

Some projects need the task container itself to be created with extra Docker
flags. The motivating case: an app that runs scripts under a seccomp-notify
based sandbox (deno_sandbox and similar) supervises them over a seccomp
notification fd duplicated with `pidfd_getfd` — a syscall Docker's default
seccomp profile only allows with `CAP_SYS_PTRACE`, which is not in the
container's bounding set, so even `sudo` inside the container cannot acquire it.
The fix has to happen at container **creation**:

```toml
[docker]
run_args = ["--cap-add=SYS_PTRACE"]
```

Things worth knowing:

- **The args go to `docker run` verbatim, in order, just before the image
  name.** Lazy does not interpret them; Docker (or Podman) is the judge of
  whether each flag is valid.
- **They widen the container's privileges, and they apply to every task.**
  Add the narrowest flag that solves your problem.
- **Root config only** — like every setting in `lazy.toml`. A task worktree's
  copy is ignored: task branches are agent-writable, and a worktree config that
  could add `--privileged` or a host bind mount would let an agent escalate its
  own next container. (The same reasoning as the `dockerfile` anchoring above.)
- **`--cap-add` alone may not be enough** if the active seccomp profile still
  blocks the syscall. Check from inside a task container: `grep CapBnd
  /proc/self/status` shows the bounding set (bit 19 is `CAP_SYS_PTRACE`), and
  `grep Seccomp /proc/self/status` shows whether a seccomp filter is active.
  If the syscall is still denied with the capability present, you may also need
  a custom `--security-opt seccomp=...` profile.
- Configured args are logged at container creation and shown by `lazy doctor`.

---

## `[credentials]`

Where `lazy auth set <provider>` keeps this project's model-provider credentials. See [Credentials](credentials.md) for the commands and the full picture.

| Key       | Type     | Default  | Description |
|-----------|----------|----------|-------------|
| `backend` | `string` | `"auto"` | Secret backend: `"auto"`, `"keychain"`, `"libsecret"`, or `"file"`. `"auto"` picks the best available on this machine — macOS Keychain, else libsecret (`secret-tool`), else `"file"`. Any other value is rejected at load. |

```toml
[credentials]
backend = "auto"
```

Two behaviours worth knowing:

- **`"file"` is not encrypted.** It is the headless/container fallback: `~/.lazy/daemon/<project-slug>/credentials.json`, mode 0600. On a host with no secret service there is nowhere to keep an encryption key better protected than the ciphertext beside it, so encrypting there would buy obfuscation rather than security. `lazy auth list` and `lazy doctor` always name the backend actually in use, so you can see which one you got.
- **An explicit choice is never silently downgraded.** If you set `backend = "keychain"` on a machine where it is unavailable, `lazy auth set` fails and says so, rather than writing a plaintext file you did not ask for. Only `"auto"` falls back.

Environment variables always outrank the store, so adding this section changes nothing for a setup that exports `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`.

---

## Running on Ollama

There is no `[ollama]` section any more — a lazy.toml that still has one with keys in it is [rejected at load](#migrating-from-role-backends) with the replacement printed. An Ollama server is now just an endpoint a profile points at, which is what lets one project run some tasks on it and others on a hosted model:

```toml
[agents.local-ollama]
harness = "claude-code"
model = "qwen3.5:35b-a3b-coding-nvfp4"
endpoint = "http://localhost:11434"

[agent]
agent_id = "local-ollama"     # make it the default for new tasks
```

Requires Ollama v0.14+ running on the host with the Anthropic Messages API enabled. **Local** Ollama (`http://localhost:11434`, a LAN address) needs **no credential** — that is what the profile's inferred `credential = "none"` means, and the proxy strips the placeholder before forwarding. **Hosted** Ollama (`https://ollama.com`) is inferred as `credential = "ollama"` and needs a key: run `lazy auth set ollama` (never put a key in `lazy.toml`).

**Interaction with the daemon credential gate.** The daemon refuses to start without the credentials its configuration actually requires, on every start path — explicit start, restart, upgrade, and the auto-start that fires on any `lazy` command — because it launches task containers whose traffic it must be able to pay for. The gate is **provider-aware**: it reads the profile each role defaults to and asks for exactly the credentials those profiles name, so a project whose builder *and* agent both run on a local profile (`credential = "none"`) needs no Anthropic credential and starts with none. A **mixed** setup still needs one: if either role's profile bills Anthropic, the daemon requires an Anthropic credential, and the refusal names each missing provider and the command that stores one. The check is presence-only and never calls the API (a blank value counts as absent).

The gate reads the **role defaults**, not every profile you declare — adding `[agents.work-codex]` is not a statement that any task runs it, so it is not a reason to refuse a daemon. A task that *selects* such a profile resolves its credential at launch and fails there, naming the profile and the name to store.

A credential satisfies the gate from either source: the **environment** (`CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY`, or `LAZY_CREDENTIAL_<NAME>` for a credential you named yourself), or the **credential store** written by `lazy auth set <name>` — see [`[credentials]`](#credentials) and [Credentials](credentials.md). The store is what makes the daemon independent of the shell that starts it, which is why `lazy upgrade` no longer aborts when you run it from a terminal that never exported a token. Because it never calls the API, a credential that is present but *expired* passes the gate — the daemon starts and then every request 401s. `lazy doctor` covers that half: it reads the proxy's audit trail and reports a 401/403 that nothing has succeeded after, with the steps to re-mint. Both halves report on the **daemon's** environment, not the shell you happen to run `lazy doctor` in: the presence check asks the daemon over RPC (which returns presence and the variable *name*, never the credential itself) and labels the source it used — `daemon env: …`, or `shell env: …` plus a caveat when the daemon could not be asked.

---

## `[proxy]`

**The proxy is ALWAYS ON.** It is how lazy runs, the same way the daemon is: with **no `[proxy]` section at all**, the daemon starts the built-in Anthropic-native passthrough proxy on an OS-assigned port and routes **all agent model traffic through it**. You do not have to configure anything, and there is nothing to switch on — a project with no `[agents]` section at all is proxied automatically. This whole section is optional tuning, never an on/off switch.

What you get by default: SSE responses streamed through untouched, one asynchronously-logged audit record per request (model, request shape, extracted `tool_use` blocks — Read/Write paths, Bash commands, WebFetch URLs, inherited `mcp__claude_ai_*` connectors — and `tool_result` previews, attributed to the role and task that made the call), plus the mechanistic policy plane over every tool call, with inherited claude.ai connectors denied by default — see [`[proxy.policy]`](#proxypolicy--mechanistic-enforcement).

**The proxy holds the credential — the agent does not.** Your real API key or OAuth token never leaves the daemon. At launch, lazy mints a per-task **placeholder** credential and puts *that* in the agent's environment (and in the container's `docker run` argv); the proxy recognises the placeholder, identifies which task and role presented it, and swaps in the real credential just before forwarding upstream. Nothing else about authentication changes — the same account is billed, in the same wire form your client would have used. See [Just-in-time credential injection](./proxy-jit-credentials.md) for the full design, including what happens on a fallback reroute and how the placeholder is revoked.

Find the live address with `lazy daemon status` (it's also printed at daemon start). The port is OS-assigned because a hardcoded one conflicts across per-project daemons; set `port` only to pin it.

**Cursor traffic rides the same proxy.** A `cursor` task's API calls are routed through the daemon's proxy too, on the same port, under the path prefix `/_lazy/cursor/<placeholder>` — the same per-task placeholder credential lazy puts in `CURSOR_API_KEY`, which is what identifies the caller. Lazy sets `CURSOR_API_ENDPOINT` (and pins `--agent-endpoint`) at launch for both container and host launches, so you configure nothing. The route is deliberately **coarse and opaque**: requests are forwarded verbatim — method, path, headers, streamed body — with only the placeholder credential swapped for the real one, and audited by role, task, method, path, status and duration only. The Anthropic-shaped request extractor, the policy plane, and the failover chain do **not** apply to cursor traffic; the audit record carries no model or token usage. Attribution rides in the URL prefix rather than headers because `cursor-agent`'s `-H` flag does not cover every request it makes — and because a placeholder in the path is *authenticated* attribution, unlike a header the agent could set to any value it likes. As with Anthropic traffic, a cursor launch that cannot resolve the live proxy address **fails** rather than calling Cursor's servers unaudited.

Cursor's agent stream is forced onto HTTP/1.1 for this: lazy sets `network.useHttp1ForAgent` in the container's `~/.cursor/cli-config.json` before each turn, and says so in the supervisor log. Two reasons — lazy's proxy speaks HTTP/1.1 only, and on cursor's HTTP/2 path the CLI takes its agent URL from a *server-supplied* redirect, which would route around the proxy silently. Your real `CURSOR_API_KEY` stays on the host: the container gets a placeholder and the proxy substitutes the real key — in the header or in the request body, wherever the CLI put it — on the way out. A host `cursor-agent` session logged in *without* an API key has no key to swap, so its traffic is forwarded exactly as it arrives and recorded unattributed.

**Codex traffic rides the same proxy.** A `codex` task's OpenAI API calls go through the proxy's OpenAI-compatible route on the same port. The Codex CLI ignores `OPENAI_BASE_URL`, so lazy routes it the one way the CLI honors: before every turn it writes a managed `~/.codex/config.toml` in the task's sandbox whose provider block points `base_url` at the proxy and reads the credential from `OPENAI_API_KEY` — which holds the per-task **placeholder**, sent as the bearer token on every request and swapped for your real OpenAI key upstream. You configure nothing, your real key never enters the container, and a codex launch that cannot resolve the live proxy address **fails** rather than calling OpenAI's servers unaudited.

**Everything is proxied — a profile's `endpoint` chooses where the proxy forwards.** There is no configuration that opts out. A profile with an explicit `endpoint` is routed by the proxy to that upstream, **per caller**: the per-launch credential the agent presents identifies which task and which [profile](#agentsname--named-agent-profiles) made the request, so the proxy resolves profile → upstream + credential + wire at request time from evidence, not from a header the agent could set. Two tasks on different profiles therefore reach different upstreams with different keys on the same proxy port, in the same project. Traffic with no such credential (a host login session) goes to the primary upstream as before, and the audit record names the upstream that was actually called.

### There is no off switch

`[proxy] enabled` **was removed.** A lazy.toml that still carries it is never silently ignored — what happens depends on the value. `enabled = false` asks for something lazy no longer does, so it is **rejected at load** with an error naming the removed option; ignoring it would leave you believing traffic was unproxied when it is not. `enabled = true` asks for exactly what lazy already does, so the line is merely dead: you get a **warning** telling you to delete it, and the command carries on.

```toml
[proxy]
enabled = false   # ERROR: `enabled` has been removed — delete this line
enabled = true    # WARNING: dead line, the proxy is always on — delete it
```

This is what makes just-in-time credential injection possible: containers hold placeholder credentials and only the proxy holds the real one, so a proxy-less launch could not authenticate at all — "proxy off" is not a coherent state. To send a task somewhere else entirely, give its profile an explicit `endpoint` — that changes where the **proxy** forwards it, not whether it is proxied.

**If the proxy cannot start, the daemon fails to start** — it never falls through to a direct connection. A silent fallback would send agent traffic straight to Anthropic while the audit trail recorded nothing, so the trail would lie by omission and the connector deny-rules would silently not apply. The startup error says why the proxy did not bind.

**And if a launch cannot reach the running proxy, the launch fails too.** Every launch path (task agents, the builder, `lazy pair`, `lazy chat`) resolves the proxy's live address at launch time — from the daemon directly when it launches the agent itself, over the daemon's RPC port when the launch happens in a CLI client. If that resolution fails — daemon down, RPC blip, proxy not bound yet — lazy **refuses to launch** rather than connect direct:

```
lazy could not resolve the live proxy address.
Reason: Daemon is not running.
...
What to do:
  - Check the daemon:    lazy daemon status
  - Start / restart it:  lazy daemon start   (or: lazy daemon restart)
  - Still failing? Its startup log says why the proxy did not bind: lazy daemon logs
```

The reasoning is the same as for daemon startup: a transient daemon failure must not be able to drop you out of the audit plane — silently, on a single launch, with no trace afterward that the traffic went unaudited. This applies to every profile, local Ollama and explicitly-pinned endpoints included: they need the proxy's address too, because the proxy is what reaches their upstream.

**A resolved address is only good for the daemon that gave it out.** With the port OS-assigned, a restarted daemon serves the proxy somewhere else, so any address held across a restart is dead. This matters for `lazy upgrade`, which restarts the daemon while your builder session keeps running: the in-container supervisor notices the restart, re-resolves the address against the daemon that came back, and relaunches Claude with `--resume` — rather than leaving you on a dead port. If that re-resolve fails, the session is **not** silently degraded — you get the error above and a `lazy builder --resume <id>` to run once the daemon is healthy, instead of a session that comes back alive but unable to reach the API.

| Key        | Type     | Default                          | Description |
|------------|----------|----------------------------------|-------------|
| `port`     | `int`    | OS-assigned free port            | TCP port the proxy listens on. **Optional** — omit it to let the OS pick a free port (avoids conflicts across per-project daemons); the actual port is shown by `lazy daemon status` and at daemon start. Set it only to pin a specific port. |
| `bind`     | `string` | `"127.0.0.1"`                    | Bind address. Keep the default (loopback only) unless you deliberately expose the proxy to other machines. |
| `upstream` | `string` | `"https://api.anthropic.com"`    | Anthropic-compatible upstream the proxy forwards to (real Anthropic, Ollama, or another proxy). Anthropic-native targets only — the proxy never translates between API shapes. |
| `cursor_upstream` | `string` | `"https://api2.cursor.sh"` | Cursor API base URL the cursor passthrough route forwards to. Change it only to point cursor traffic at a different Cursor deployment or a local stand-in. |
| `retry_after_threshold` | `int` | `5` | On a **primary** 429 whose `Retry-After` is ≤ this many seconds, the proxy waits that long and retries the primary **once** before failing over. A larger `Retry-After` fails over immediately. Only applies when a fallback chain is configured. |
| `upstream_timeout` | `int` | `1800` | Seconds the proxy waits for an upstream to answer one request before giving up (`0` = wait indefinitely). Raise it for a local model that loads slowly, queues requests behind other sessions, or prefills very large prompts; when the proxy does give up it names the upstream and this ceiling, so a slow model never reads as a network fault. |

`openai_upstream` **was removed.** It was one global OpenAI upstream shared by every caller holding an OpenAI key, so two Codex setups could never differ. An upstream is a property of a [profile](#agentsname--named-agent-profiles) now: give the `codex` profile (or a profile of your own) an `endpoint`. A lazy.toml that still carries the key is reported by `lazy doctor` with that remedy, and `lazy doctor --fix agents` applies it.

```toml
# The default. No [proxy] section needed at all — the daemon starts the proxy on
# an OS-assigned port and routes agent traffic through it.
```

To pin a specific port and primary upstream instead (both are overrides):

```toml
[proxy]
port = 8766
bind = "127.0.0.1"
upstream = "https://api.anthropic.com"
```

Audit records are written to `.lazy/logs/proxy-audit.jsonl` (append-only JSONL, one record per line) in the project-local data dir — **not** into your task store. The audit trail is disposable telemetry, not durable state: it is gitignored, safe to delete at any time, and never travels with the store. Writes are serialised — no interleaving even under concurrent requests — and happen asynchronously so the proxy hot path is never blocked by disk I/O.

The file is **bounded**: it rotates to `proxy-audit.jsonl.1` at 4 MiB and only that one older segment is kept, so the audit trail can never exceed 8 MiB total. Retention is deliberately shallow — the only reader is the recent-history "is lazy's credential actually accepted?" verdict in `lazy doctor`. Anything wanting statistics should tap the stream as it flows rather than mine the file.

> **Upgrading from an earlier version:** the audit stream used to be appended, uncapped, into the task store itself (`<store>/proxy-audit.jsonl`), where it could grow large enough to break a store push. The daemon deletes that leftover file on startup and says so in its log — since it is cleanup of a file an older version wrote and has nothing to do with the proxy's current state. `lazy doctor` reports it if it is still there. If your store is a git repo, the oversized blob is also in its **history**, which lazy will not rewrite for you — use `git filter-repo` in the store repo to purge it.

Each record is **attributed to the role and task that made the request.** The attribution comes from the per-launch placeholder credential the agent presents, which the proxy resolves to the task and role it was minted for — evidence, not a claim the agent could forge. Traffic without a placeholder (for example a host session using its own login) falls back to the `x-lazy-role` / `x-lazy-task-id` hint headers lazy sets at launch; those headers are stripped before forwarding either way, so the upstream never sees them. This is what lets the audit trail (and every `DENY` log line) say *which* agent and task tried a given `tool_use`, not just that one did.

### Token accounting — `lazy stats tokens`

Every audit record also carries the **token usage** the upstream reported for that request, in the `usage` field: `inputTokens`, `outputTokens`, `cacheCreationInputTokens`, `cacheReadInputTokens`. Combined with the role/task attribution above, that gives per-role, per-task and per-model token accounting with no extra instrumentation.

Usage is captured on both response paths:

- **Non-streaming / enforcement path** — the body is already buffered, so `usage` is read straight out of the JSON. On an enforced (denied) request the counts come from the *original* upstream body, not the rewritten one: a denial changes content, never the tokens the upstream billed.
- **Streaming path** — the response body is passed through a tee that forwards each chunk to the client *before* inspecting it, watching the SSE stream for `message_start` (input/cache counts) and the final `message_delta` (cumulative `output_tokens`). Nothing is buffered and the client never waits on the scanner, so the streaming hot path keeps its zero-added-latency guarantee. The audit record is enqueued when the stream ends — including when the client cancels mid-stream, so a walked-away client never vanishes from the trail.

Requests that failed before any response (an unreachable upstream, a terminal error) legitimately have no usage and keep `usage: null`. They still appear in the trail, and `lazy stats tokens` counts them under "requests" but not under "with usage" — so a failure is visible rather than silently inflating or deflating the totals.

Read the trail with `lazy stats tokens`. It lives under `lazy stats`, the multiplexer for read-only analytics over what lazy recorded (alongside `lazy stats timings`, the request-trace readout) — top-level verbs are reserved for task-lifecycle operations:

```bash
lazy stats tokens                        # totals + by-role / by-task / by-model breakdowns
lazy stats tokens --since 24h            # only the last day
lazy stats tokens --role agent --top 20  # agent traffic only, 20 rows per breakdown
lazy stats tokens --task add-proxy       # one task's spend (short-id prefix match)
lazy stats tokens --task my-parent --subtree  # that task and every task nested under it
lazy stats tokens --json                 # machine-readable rollup
```

`--subtree` needs a `--task` to descend from, and folds in every descendant at every depth — what a parent task (a release task, a cluster) really spent, rather than the handful of turns it ran itself. The *By task* breakdown then has one row per task in the subtree.

Two scope caveats, both printed in the readout:

- **Every launch lazy makes is proxied**, whatever profile it runs, so all of it appears here. A process lazy did not launch does not.
- **Traffic with no `x-lazy-role`/`x-lazy-task-id` header is grouped under `(unattributed)`, not dropped.** It cost real tokens; hiding it would make the rollup under-report.

### Which tool filled the context — `lazy stats tools`

`lazy stats tokens` tells you how much a task spent. `lazy stats tools <task>` tells you **what filled its context** — the per-tool breakdown, the same numbers the task page's Stats tab shows, without leaving the terminal:

```bash
lazy stats tools add-proxy              # one task's tools, ranked by the context they added
lazy stats tools add-proxy --since 2h   # the last two hours of the audit window instead
lazy stats tools add-proxy --top 5      # the five heaviest tools
lazy stats tools my-parent --subtree    # the task and everything nested under it
lazy stats tools add-proxy --json       # machine-readable rollup
```

`--subtree` folds in every descendant at every depth, merging the rows by tool name — the same rollup the task page's Stats tab shows for a parent task.

It takes a task — a code or a short id — because the breakdown only exists per task; there is no meaningful cross-task version of it. The table gives, per tool:

| Column | What it is |
|--------|------------|
| `CALLS` | Distinct calls to that tool. A call replayed in later requests is still one call. |
| `TOKENS` | The size of what that tool's results put into the conversation, counted once per call. |
| `SHARE` | That tool's share of all attributed result tokens. |
| `PER CALL` | Average result size over the calls whose size was recorded. |
| `ERRORS` | Results that came back flagged as errors. |

**`TOKENS` is context the tool added, not a share of the model bill.** Those are different numbers, and the second one is not knowable: a request is billed as a whole, and one model response routinely asks for several tools at once, so splitting a request's usage across them would be invented. lazy does not do it.

The column to read for "which tool should I reduce" is usually `PER CALL`. Three cheap reads and one enormous fetch are not the same problem, and the call count alone cannot tell them apart.

The numbers cover the task's **whole life**: lazy's proxy folds each request it forwards into the task's own tool record as it goes, so nothing here expires with the audit trail. Three honesty rules, each printed in the readout when it applies:

- **No record is not the same as no tools.** A task that ran before lazy started keeping them — or whose traffic never went through the proxy — gets a line saying exactly that instead of an empty table, and it never claims the task called nothing.
- **A result whose size was never recorded reads `not recorded`, never `0`.** A zero would say the output was free, which is a different and false claim about an unmeasured value.
- **A result answering a call lazy never saw is reported as unattributed**, in its own line under the table, rather than filed under a guessed tool name.

`--since` and `--limit` ask a different question — what a task's tools cost over a stretch of time — which only the proxy's bounded, disposable audit trail can answer. Either flag reads that recent window instead of the task's record, and the readout says so.

Expect the tokens the proxy observed for those requests — printed above the table — to be far larger than the tool totals. That is not a contradiction: every request re-sends the whole conversation those results sit in, so a large result is paid for again, more cheaply, on every turn after it. That is exactly why a verbose tool is worth finding.

### Reading the trail record by record — `lazy stats audit`

`lazy stats tokens` rolls the trail up. `lazy stats audit` is the other half: **one row per proxied request**, so you can answer "what did the policy engine deny on that turn?" or "which requests failed over to the fallback?" without hand-reading `proxy-audit.jsonl`.

```bash
lazy stats audit                          # the newest 20 proxied requests, one row each
lazy stats audit --denied                 # every policy denial recorded
lazy stats audit --task add-audit --last 2h
lazy stats audit --errors --limit 50      # recent failures — e.g. the 401s that mean an expired credential
lazy stats audit --reroutes --json        # failovers, machine-readable
lazy stats audit 3f9a1c2b                 # full detail for one record
```

The listing shows time, record id, role, task, model, tool_use/tool_result counts, total tokens and duration, plus a `NOTES` column that flags the rows worth opening: `DENY(n)`, `REROUTE`, and `FAIL(<status>)` (or `FAIL(no-response)` when the request never got one). Filters — `--task` (short-id prefix), `--role`, `--model` (substring), `--since`/`--last`, `--denied`, `--reroutes`, `--errors` — all combine.

Passing a record id (the short form from the `ID` column is enough) opens the **detail view** for that request: routing and upstream, request shape and declared tools, token usage, the `tool_use` blocks the agent intended with their paths/commands, `tool_result` previews, the reroute's source and target, and each denial with the rule that fired and the reason given back to the agent. `--json` emits the row list, or — with a record id — the raw record.

Two deliberate behaviors worth knowing:

- **`--limit` keeps the newest records, not the oldest.** The trail reads like a log; when the listing is capped the tail is what you want, and the footer says how many older records were hidden.
- **An ambiguous record-id prefix is an error, not a best guess.** Showing the wrong request's denials would be worse than failing.

Like `lazy stats tokens`, this is read-only and covers proxied traffic — which, since every launch lazy makes is proxied, is all of it.

### Smart routing — `[[proxy.fallback]]` failover chain

By default, when the upstream returns **429** (rate limited) / **529** (overloaded) or is unreachable, the proxy fails the request and the agent's turn fails with it. A `[[proxy.fallback]]` chain lets the proxy instead **reroute** the request to an alternate Anthropic-native target — a different model tier, a different endpoint (e.g. a locally-served Ollama model), or a different account. Each entry is tried in order until one responds.

Failover is **explicit and opt-in.** With no `[[proxy.fallback]]` entries the proxy fails hard exactly as before — it never invents a fallback or silently retries (per lazy's no-silent-fallback rule). Every reroute is **logged** as a warning **and recorded** in the audit trail: each audit record carries a `reroute` field with the original upstream/model, the fallback upstream/model actually used, the trigger (`"429"`, `"529"`, or `"unreachable"`), and the number of targets attempted. So you can always see afterward which turns ran on a fallback model.

| Key        | Type     | Default | Description |
|------------|----------|---------|-------------|
| `upstream` | `string` | — (required) | Anthropic-native base URL to reroute to. Anthropic-native only — no translation layer. |
| `model`    | `string` | (keep original) | Optional. When set, the request body's `model` is rewritten to this before re-sending — use it to fail over to a different tier or to name the model a different backend expects. Omit it to keep the original model (e.g. a hot spare on the same model). |
| `credential` | `string` | `"none"` | Which credential the proxy presents to this target: `"anthropic"` (the same real credential it uses for the primary), `"ollama"` (your Ollama Cloud key, for `https://ollama.com`), `"openrouter"` (your OpenRouter key — OpenRouter's `https://openrouter.ai/api` serves an Anthropic-compatible Messages endpoint, so it works as a fallback with no translation), `"openai"`, or `"none"` (send no credential at all). The default is `"none"` because a fallback is a *different* server — a local Ollama, someone else's endpoint — and forwarding your Anthropic credential there by default would leak it. Any other value is rejected at load. |

```toml
[proxy]
port = 8766
upstream = "https://api.anthropic.com"
retry_after_threshold = 5

# First fallback: a local Ollama model (free). No API spend.
[[proxy.fallback]]
upstream = "http://localhost:11434"
model = "qwen3.5:35b-a3b-coding-nvfp4"

# Second fallback: a cheaper Anthropic tier, only if the local one is also down.
# It is really Anthropic, so it gets the real credential.
[[proxy.fallback]]
upstream = "https://api.anthropic.com"
model = "claude-haiku-4-5-20251001"
credential = "anthropic"
```

**Guarantees and constraints:**

- **Streaming is never interrupted.** Failover keys only on the upstream's *status line*. Once a `200` response has started streaming back to the client, it is never rerouted mid-stream — an error partway through a successful turn surfaces to the client as-is.
- **Respect `Retry-After`.** On a primary 429 with a short `Retry-After` (≤ `retry_after_threshold`, default 5s), the proxy waits it out and retries the primary once before failing over — a brief rate-limit blip is cheaper to wait than to reroute. A longer `Retry-After`, or a 529, fails over immediately.
- **Paid-API guard.** A fallback chain is itself explicit config, but mind the *ordering*: putting a paid Anthropic target as the fallback for a local/free primary means an overloaded local model silently escalates to billed API usage. That is allowed (you configured it) but should be intentional — order free/cheap targets first if that is what you want.
- **A fallback that shares an origin with a credentialed target is rejected at startup.** The credential map is keyed by *origin* (scheme + host + port), so a fallback at `https://api.anthropic.com/v2` cannot receive "no credential" while `https://api.anthropic.com/v1` receives one — it would inherit it, and the startup log would print `→ none` while the opposite happened. Rather than let the config lie, lazy refuses to start: give the fallback a distinct host or port, or declare `credential = "anthropic"` and mean it.
- **Each target gets its own credential, or none.** The proxy does not forward whatever the client presented — it looks up the credential for the target it is actually calling. A fallback with no `credential` receives **no** credential, so the placeholder never escapes to a third-party endpoint and your real key is not handed to a server you only listed as a spare.
- **Anthropic-native only.** Fallback targets speak `/v1/messages` natively; the proxy never translates between API shapes.

### `[proxy.policy]` — mechanistic enforcement

Beyond passive audit, the proxy runs a **deterministic, injection-proof rule engine** that inspects every `tool_use` an agent proposes *before it executes*. On a policy violation it **rewrites the response** so the call never runs and injects an explanatory assistant text block, so the agent learns why and course-corrects. Rules are model- and backend-independent — a prompt-injected agent cannot argue its way past a static rule.

**Enforcement is ON by default** (the proxy always runs), with a closed posture. The load-bearing rule: inherited **claude.ai account connectors (`mcp__claude_ai_*`) are denied by default, allowlist-only** — these Gmail/Drive/Calendar/Spotify tools are injected server-side from the authenticated account and are invisible to the OS sandbox and Claude Code's own permission model, so the proxy is the only `lazy`-controlled place that can stop them. Reads of secret/credential paths are also denied by default.

Only a `/v1/messages` response to a request that *declared tools* is buffered for possible rewriting; every other response streams through untouched, and when nothing is denied the original bytes are forwarded verbatim.

| Key                      | Type       | Default | Description |
|--------------------------|------------|---------|-------------|
| `enforce`                | `bool`     | `true`  | Master switch. `false` = pure passthrough/audit, no enforcement. |
| `connector_allowlist`    | `string[]` | `[]`    | Exact `mcp__claude_ai_*` tool names to re-allow despite the default-deny posture. Exact match, not prefix. |
| `deny_secret_path_reads` | `bool`     | `true`  | Deny reads of `~/.ssh`, `.env`, `.aws/credentials`, private keys, `.npmrc`, kubeconfig, etc. Template files (`.env.example`, `*.sample`, `*.template`) are allowed — they hold placeholders, not secrets — except inside credential directories like `~/.ssh` and `~/.aws`. |
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

Denials are recorded on the request's audit record (`enforcement` field: which tool, which rule, why). This is the **mechanistic floor**: deterministic rules, evaluated on every request.

### Outbound request plugins are NOT configured here

The proxy can run **request plugins**: transforms applied to the outbound request body before it is forwarded. They are loaded by convention from the project's `.lazy/plugins/` directory — presence is the enable switch, and there is no `lazy.toml` key for them. With no such directory the proxy forwards request bodies byte-identically, which is the default.

See [Proxy plugins](proxy-plugins.md), or scaffold one with `lazy customize proxy-plugin <name>`.

---

## `[documents]`

Mount additional documents into agent containers.

| Key    | Type     | Default | Description |
|--------|----------|---------|-------------|
| `path` | `string` | `""`    | Path to a directory of documents to mount into the agent container. |

---

## `[docs]`

Where the `Check documentation at <url>` pointers in error messages, warnings and command help point.

Not to be confused with `[documents]` above — that mounts a directory of reference material into agent containers. `[docs]` is only the documentation link domain.

| Key   | Type              | Default                                | Description |
|-------|-------------------|----------------------------------------|-------------|
| `url` | `string \| false` | `"https://docs.getlazy.dev/v<major.minor>"` | Base URL for documentation links. `""` or `false` turns pointers off. |

```toml
[docs]
# Point at your own mirror (a fork, or an internal copy of the docs)
url = "https://docs.internal.example.com/lazy"

# ...or turn documentation pointers off entirely
# url = ""
```

Links are composed as `<url>/<page>` — the `protected-branches` page renders as `<url>/protected-branches`. Set `url` to the root of whatever serves the documentation; a trailing slash is ignored.

**The default is version-pinned; a configured value is not.** With no `url` set, lazy points at `https://docs.getlazy.dev/v<major.minor>` — the snapshot of the docs published alongside the build you are running. The docs site keeps one directory per minor release and never rewrites an old one, so a pointer printed by any build that ever shipped keeps resolving.

A `url` you configure is used **exactly as written**: lazy appends the page path and nothing else, and never adds a version segment. Appending our layout to someone else's site would produce 404s they could not fix from their side, so a mirror owns its own paths. If you want your mirror version-pinned too, put the version in the URL yourself.

Pointers are always a **supplement**. Every message that carries one is fully actionable with the pointer removed, so disabling them costs you a link and nothing else.

A value that is neither an `http(s)` URL nor the empty string fails the config load with a message naming the section — an unusable URL is reported at load time rather than silently degrading into "links never appear".

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

**A second host path is refused the same way: the builder scratch directory** (`~/.lazy/scratch/`, or wherever `LAZY_SCRATCH_BASE_DIR` points). That directory is the builder's scratchpad for handing documents to *you*, and is deliberately unreadable by agents — a builder that can pass code to an agent through a shared directory stops delegating and starts implementing. A bind `source` inside it, or one that contains it, fails with an error naming the entry. See [builder-scratch-dir.md](./builder-scratch-dir.md).

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
| `protected` | `string[]` | `[]`    | Glob patterns for files agents should not modify or delete. Agents can still *add* new files matching these patterns — only modifications and deletions are flagged as violations for human review. User patterns are merged additively with the built-in defaults. After `lazy sync` merges your parent branch, protected files whose content matches upstream are not flagged — only changes your task made on top of upstream count. |

```toml
[permissions]
protected = ["README.md", "test/**/*.ts", "*.spec.*"]
```

### Resolving a conflict task

A turn that violates these patterns leaves the task in `conflict`. That status
means one thing: **a decision is owed at merge time**. Nothing is reverted for
you, ever, on any surface.

While the task is still open to revision — at the wrap-up that closes a declared-final turn — a task whose range violates a pattern gets a push-back asking the agent to revert the file itself or record a short reason for keeping it. Those reasons are what you read when you decide. The exchange runs once, over the task's whole range. The range is branch-wide: at a parent task's final it includes the changes of its accepted subtasks, so a subtask's protected-file edit that nobody has asked about yet is asked here, where the whole work is being reviewed. The violation itself is detected no matter when it happens: every end-of-turn park scans the task's own changes, so a protected edit still parks the task in `conflict` mid-task, before the agent has had its say — that is exactly what the wrap-up's exchange is for.

**Unblock asks nothing.** `lazy unblock` has no `--approve-file` /
`--no-approve-files` flags and `lazy_unblock` has no `approved_files`
parameter — a conflict task is unblocked exactly like a blocked one, as many
times as the work needs, and the violated files keep the agent's content
throughout. (Passing a retired flag or parameter is an error pointing at accept,
not a silent no-op.)

**Accept is the one gate:**

| | `lazy accept` | `lazy_accept` |
|---|---|---|
| How to approve | `--approve-file <file>` (repeatable) | `approved_files: [...]` |
| Required? | Yes, while any violation is pending | Yes, while any violation is pending |
| A pending file left out | makes accept **refuse**; nothing is reverted | makes accept **refuse**; nothing is reverted |

The web review page carries the same decision per file, next to the rendered
diff: ✅ approves, ⛔ returns the record to *pending*. Accept reads those stored
decisions, so a file you ticked there needs no flag at the terminal.

**Approval is sticky.** A file already approved stays approved; only a turn that
touches it again raises a fresh pending violation to decide. Approving in the
feedback *text* has no effect anywhere — the flag, the parameter and the page
are the only channels that are read.

To reverse an approval, un-approve the file on the review page: that puts the
record back to `pending` rather than to a settled refusal, so accept asks again.
Or simply ask the agent, in unblock feedback, to revert the file itself. The
absence of a CLI/MCP un-approve is deliberate; see
[CLI and MCP surface asymmetries](./surface-asymmetries.md).

**Which files count is a question about the task's own changes, not the last
turn.** The agent is scanned after every turn, but the set you are asked to
approve is re-detected across everything the task itself is about to merge.
Work that arrived from an accepted subtask that was itself asked is not
re-asked, since it was decided at that subtask's own merge. But a subtask whose
wrap-up skipped the exchange (one an agent runs and reviews — see the wrap-up
section below) was never asked about its files: those questions are **deferred
to the parent task's own accept**, which keeps asking until a human decides — with
the agent getting its say at the parent's final first. That is what makes the
answer stable across a long task:

- a protected file changed on turn 1 still needs approving at turn 20, even
  though a dozen later turns touched nothing protected;
- a protected file the agent *reverted itself* after the push-back drops out on
  its own, because it is no longer part of the diff — nobody has to un-ask it;
- approvals are remembered per file, so nothing you have already decided comes
  back;
- but a decision you made at a subtask's merge covers *that subtask's* edit of
  the file. If the parent task later changes the same protected file itself, you
  are asked about that change — nobody has decided about it yet. The same goes
  for a second subtask that touched the file and whose own merge asked nobody:
  approving one subtask's edit of `CHANGELOG.md` does not decide another's.

The same answer is used by `lazy accept`, the `conflict` label, and the review
page's "Before you can accept" block, so a file can never be refused by one and
invisible to another.

---

## `[protection]`

Protected branches — accepting a task into a protected branch requires a human approval: `lazy accept` prompts for the approval passphrase and merges in the same invocation. This is friction against an over-eager builder, not a security boundary; the full story is in [Protected branches](./protected-branches.md). Not to be confused with `[permissions].protected`, which guards *files* from agent edits.

**Opt-in — off by default.** A project with no `[protection]` section has no protection at all: accepts behave exactly as if the feature didn't exist. `enabled` is the single master switch, and while it is off every other key in this section has no effect. The one command that turns it on is `lazy protect main on`, which lists the branch **and** sets `enabled = true`; `lazy protect <target> off` never touches the switch, so toggling never loses a list. Because the feature is invisible while off, a successful `lazy accept` into the repo's default branch prints a one-line tip pointing at `lazy protect` — suppressed as soon as `enabled` appears in this section with either value. `lazy doctor` warns when other `[protection]` keys are configured while the switch is off, since they are inert.

| Key                   | Type       | Default                    | Description |
|-----------------------|------------|----------------------------|-------------|
| `enabled`             | `boolean`  | `false`                    | Master switch. Off by default; set `true` (or run `lazy protect <branch> on`) to engage protection — that alone protects the repo's default branch (e.g. `main`). While false, nothing else in this section has any effect. |
| `gate_default_branch` | `boolean`  | `true`                     | When protection is enabled, protect the repo's default branch. On by default; set `false` to protect only the branches listed in `protected_branches`. |
| `protected_branches`  | `string[]` | `[]`                       | Additional protected branches, for projects with more than one sensitive branch. Merges **into** them need approval. Exact branch names, no globs. |
| `protected_tasks`     | `string[]` | `[]`                       | Protected tasks, by task code or short id. Merging that task's work **out** — upward into any target — needs approval. The branch is resolved from the task at decision time. |

**The approval passphrase is not configured here.** It lives nowhere in the repository: enroll it once per *machine* with `lazy system passphrase set`, which stores a hash (never the passphrase) at `~/.lazy/passphrase.json`, mode `0600`. Older versions had a `passphrase_file` key pointing at a plaintext file inside the repo — that key is **removed**, and a config still carrying it gets a one-line warning at load naming the new command, plus the full remedy in `lazy doctor`. A file in the tree was readable by every agent, and a repo-controlled path let an agent point the key at a file it had just written. See [protected-branches.md](./protected-branches.md#enrolling-the-passphrase-lazy-system-passphrase).

Both lists are managed by **`lazy protect <branch|task> on|off`**, which edits this section in place and preserves its comments; `lazy protect` with no arguments prints the current state. Hand-editing works too — this section is the one and only store.

When enabled, protection applies on **all** remote drivers, including `local`, and regardless of who calls accept (CLI `--yes`, the builder over MCP, automation). Subtask merges into intermediate `lazy/*` parent branches are never protected — no friction in the inner loop — with one deliberate exception: a task listed in `protected_tasks` gates its own outgoing merge even into a `lazy/*` parent. The passphrase is typed at the accept that merges, so each protected accept is approved individually and nothing is stored; `--yes` skips other prompts but never the passphrase, and there is no non-interactive route for it.

`gate_default_branch` protects a branch that appears in no list: the default branch is resolved from `refs/remotes/<remote>/HEAD` at decision time, so it stays correct if the repo's default branch changes. `lazy protect` shows it under Protected branches marked as implicit, and `lazy doctor` warns when that remote ref is missing (resolution then falls back to the literal `main`, which would gate nothing on a `master` repo).

Once anything here is protected, the gates are **visible before they bite**: `lazy show` and `lazy status` print a `Protected:` line, `lazy list` and the dashboard mark the task `[P]`, `lazy browse` shows it in the header, and MCP `lazy_show` returns a read-only `protection` object (including any builder review captured by a refused accept, waiting for yours). A project that protects nothing sees no change at all. See [protected-branches.md](./protected-branches.md#seeing-a-gate-before-it-bites).

On GitHub and GitLab projects, **approving the task's PR/MR satisfies this same gate** — it is a satisfier resolved inside the gate, not a parallel mechanism, so a `local` project and a forge project reach the identical decision. The forge is checked first (so an approved PR merges without a passphrase prompt) and fails closed if the forge is unreachable. See [protected-branches.md](./protected-branches.md).

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

The follow-up exchanges — protected-file push-back (under `[permissions]`), the maintained-files nudge and the reactive automations — run **once**, in the wrap-up that closes a declared-final turn: the turn where the agent said the task is done with `lazy_final`. Until that declaration none of them fire; the scans they would run are skipped. (The review walkthrough is the exception: it is produced on every park a person will open, because it is what you decide from.) Two things happen outside the wrap-up: protected-file edits are still detected at every end-of-turn park (the scan runs over the task's own change range, so the task still parks in `conflict` mid-task), and a plan-mode final gets the accept-time remedies instead of the exchange, since a plan-mode agent cannot revert anything.

### Maintained files (`[[automation.maintain]]`)

Maintained files — the inverse of `[permissions].protected`. Patterns agents are *expected* to keep up to date as they work (docs, CHANGELOG, architecture diagrams). Agents *may* skip them, but when the task's whole change range touches none of an entry's files, the supervisor prompts the agent once, at the wrap-up, to either make the update or record why it skipped — turning a silent omission into a deliberate, reviewable decision. It is a nudge, not a gate: the task still blocks normally (it does not become a `conflict`). The range is branch-wide: at a parent task's final it covers its accepted subtasks' work too — a subtask whose own wrap-up skipped this check has its changes checked here instead, where the whole work is being reviewed.

`maintain` is an array of tables (`[[automation.maintain]]`), each with:

| Key            | Type     | Description |
|----------------|----------|-------------|
| `title`        | `string` | Short label for the group (shown to the agent and in review). |
| `pattern`      | `string` | Glob matched against the turn's changed files. |
| `instructions` | `string` | What/why to maintain — shown to the agent verbatim, up front and in the follow-up. |

Opt-in: empty by default. The check runs once, during the wrap-up, over the task's whole change range — the same range `lazy diff` and the reviewer are about to see — not just the final turn. It is skipped entirely when the task changed nothing at all (a no-op turn, or one that only drove subtasks, has nothing to maintain alongside).

When the task's range also has protected-file violations, the maintain nudge runs **after** the push-back exchange and is **independent of its outcome** — it fires whether the agent resolved the violations or kept them. Ordering within the wrap-up is: work → push-back → agent reply → maintain nudge → agent reply (→ react nudge when configured → the uncommitted-work check → the presentation step on human-audience tasks). The uncommitted-work check is what stops an update made *here* from being written and never committed: it reads the working tree, and if anything is loose it asks the agent once to commit or discard it, before the walkthrough is written over the final file list. See [Work left uncommitted when the turn ends](state-machine.md#work-left-uncommitted-when-the-turn-ends). The push-back never re-runs because of the maintain or react steps (it is single-shot). The maintain response does not carry the violation set; when a react follow-up also runs, that response re-detects and carries the final set. Otherwise the push-back response does — so a still-violating task still becomes a `conflict` even though it also got nudged.

The follow-up is recorded as its own discrete turn pair — a `supervisor`-authored prompt turn (under a "Maintained Files Review" heading) followed by the agent's reply turn — so the turn history reads cleanly: work turn → supervisor nudge → agent reply. The nudge text is **not** appended to the work turn's response. The reply turn carries its own token usage (including cache tokens) and any commits the follow-up made are attributed to it, not the work turn. The protected-file push-back behaves the same way ("Permission Violation Review"). In `lazy show` and the dashboard these prompt turns are labelled `supervisor` (not `human`), so you can tell "the human said" from "the supervisor pushed back".

```toml
[[automation.maintain]]
title = "docs"
pattern = "docs/**/*"
instructions = "Search for docs and update any that have gone out of date due to your work, OR create new docs if needed."

[[automation.maintain]]
title = "changelog"
pattern = "CHANGELOG.md"
instructions = "Add ONE line under Added/Changed/Fixed describing the user-visible effect; update an existing line rather than adding a second."
```

### Reactive automations (`[[automation.react]]`)

The other direction from maintain: when the task's commits *touch* a configured pattern, the supervisor prompts the agent once with that entry's instructions. Use it for follow-up work that should happen whenever certain paths change — UI screenshots, regenerating a derived artifact, and similar. Same three fields as maintain (`title`, `pattern`, `instructions`). Opt-in: empty by default. Each field is required (non-empty string); a malformed entry fails when lazy loads the config, not mid-turn. Like the maintained-files check, this runs once, at the wrap-up on the declared-final turn — not on every work turn.

This is a generalized form of protected-file push-back (match → prompt), but with your own instructions. The react nudge itself is not a `conflict` gate and never re-runs push-back; after it finishes, lazy re-checks protected files on the new HEAD. Edits made during the nudge that still touch protected paths park the turn in `conflict`; if nothing protected remains (including when the nudge cleaned an earlier pending set), the task blocks normally for review. A failed re-check does not clear an earlier conflict.

Ordering within the wrap-up when push-back and/or maintain also run: work → push-back → maintain → react. The react scan covers the task's whole change range (including commits made during the wrap-up's earlier steps), fires at most once, and is recorded under a "Reactive Automation" heading as its own supervisor/agent turn pair.

```toml
[[automation.react]]
title = "take-UI-snapshots"
pattern = "src/ui/**/*"
instructions = "You updated UI — start the app in demo mode and take Playwright screenshots of the screens you changed."
```

### `[automation.pre_accept]`

**Opt-in — `enabled` defaults to `false`.** The gate blocks every accept on running the commands and costs commands-time each time, so accept is fast by default; set `enabled = true` to turn the gate on.

When enabled, the configured commands run **mechanically** as a task is being **accepted**, BEFORE the merge — the home for expensive one-time validation (full test suite, build). **No agent runs here.** The commands execute in an ephemeral gate container next to the task's own (same runner, same project image) against the task's worktree, in order, and the first non-zero exit — or a command that exceeds its timeout — **aborts the accept** and returns the task to the status it held before the accept, with the failed command, its exit code and an output tail recorded as a comment. There is never a silent merge: nothing merges until this independent run passes, and nothing "fixes" anything first — if the branch fails the gate, you fix it (or send the task back with `lazy unblock`) and accept again.

Because no agent runs, the gate has no session, no system prompt, no `LAZY.md` and no turn in the task history — the outcome appears in the accept output and on the task as a comment. It also means **maintained-files completeness has moved out of accept time**: the maintained-files nudge (`[[automation.maintain]]`) runs once at the wrap-up that closes a declared-final turn, not here.

| Key        | Type       | Default | Description |
|------------|------------|---------|-------------|
| `enabled`  | `boolean`  | `false` | Run the acceptance gate at all. Default `false`: accept merges directly with no gate. Set `true` to opt in. |
| `commands` | `string[]` | `[]`    | Gate commands, run in order. The first non-zero exit **aborts the accept** and returns the task to the status it held before the accept with the failure surfaced as a comment — never a silent merge. An enabled gate with no commands passes trivially (no container is launched). |
| `timeout`  | `number`   | `600`   | Timeout in seconds for **each** gate command. A timed-out command counts as a failure and aborts the accept. |

**Failure semantics.** If a gate command exits non-zero, times out, or fails to execute; if the gate container cannot launch; or if the daemon's wait budget expires without a verdict, the accept is aborted, the task returns to the status it held before the accept — `blocked`, `conflict`, or `submitted`, whichever it actually was — and the reason is recorded as a comment on the task (so a caller that has gone away still finds out why the merge never happened) and reported to the caller. Fix the issue and re-run `lazy accept` — every accept runs a fresh gate.

**How long the daemon waits.** The wait budget is derived from the work itself: the number of commands times each command's `timeout`, plus a small supervisor-startup margin. There is deliberately no agent watchdog involved — no agent is running, so `[agent].watchdog_output_timeout_ms` does not apply here. The failure message names the deadline that fired.

```toml
[automation.pre_accept]
enabled = true
commands = ["bun test", "bun run build"]
timeout = 600
```

### Per-turn hooks — `pre_turn` / `post_turn`

Two commands that bracket every agent turn. Both are plain keys on `[automation]`, both are opt-in (empty by default), both run through `sh -c` in the task worktree, and both capture **stdout and stderr** as separately-labelled blocks (never interleaved — the two streams are drained concurrently, so an interleave would be invented rather than observed).

This is where a full test suite or build belongs. Agents are instructed to verify with the tests covering what they changed and *not* to run the whole suite as routine verification — it would cost minutes on every turn. Configure `post_turn` and the sweep happens once, after the turn, without the agent paying for it.

| Key                 | Type      | Default | Description |
|---------------------|-----------|---------|-------------|
| `pre_turn`          | `string`  | `""`    | Setup command run BEFORE each agent turn, after the upstream merge. Empty means no hook and no phase. |
| `pre_turn_timeout`  | `number`  | `120`   | Timeout in seconds for `pre_turn`. Exceeding it is a failure (recorded as exit code `-2`). |
| `pre_turn_required` | `boolean` | `false` | `false`: a failing hook is loud but non-fatal. `true`: a failing hook fails the turn — the agent is never launched. |
| `post_turn`         | `string`  | `""`    | Command run after each agent turn. Output is attached to the turn for reviewers. Does NOT block the agent or trigger retries. |
| `post_turn_timeout` | `number`  | `300`   | Timeout in seconds for `post_turn` (default: 5 minutes). |

```toml
[automation]
pre_turn = "bin/lazy-services"
pre_turn_timeout = 120
pre_turn_required = false
post_turn = "bun test --bail"
post_turn_timeout = 300
```

**`pre_turn` is "ensure services are up", not "start services" — write it idempotent.** Nothing sweeps up processes between turns: a database, dev server, or compose stack the agent (or a previous hook run) started keeps running across the turn boundary and across the whole task. So on the overwhelming majority of turns the hook has nothing to do. It exists for the cases where something genuinely is missing — the first turn of a task, a fresh container, or a service that crashed. It runs on *every* turn, so it must also be cheap in the common "already up" case.

**Failure is non-fatal and loud by default.** When the hook exits non-zero (or times out), the exit code and captured output are recorded on the turn — visible in `lazy show <task>` and in the review TUI — and a short `## Environment warning` block is prepended to the agent's prompt, so the agent knows the environment is degraded before it starts guessing. The turn still runs. Set `pre_turn_required = true` when the turn is pointless without the environment; then the same failure ends the turn instead, with the hook output as the error.

**On container runners, automation hooks run inside the task container.** Anything a `pre_turn` hook starts there is scoped to that container's lifecycle unless you deliberately run host-side tooling from the hook (unusual and not recommended).

**`post_turn` is not a teardown hook.** It runs on clean turns only. A turn that failed, timed out, or was stopped is hard-killed, and `post_turn` does not run for it. That is accepted behavior today, not an oversight: if you need cleanup that must always happen, do it outside lazy (or make the next `pre_turn` reconcile the state).

### The accept check — `accept_check`

A command run in the **task's** worktree at accept time, before the merge. Unlike `post_turn`, which is advisory, a non-zero exit **refuses the accept**: a task that does not build would break the branch it is merged into. See [The accept check](accept-check.md) for why it exists and the full refusal text.

| Key                     | Type     | Default | Description |
|-------------------------|----------|---------|-------------|
| `accept_check`          | `string` | `""`    | Command run in the task worktree at accept time. Non-zero exit refuses the merge. Empty means no gate — accept reports the step as skipped rather than guessing a build command. |
| `accept_check_timeout`  | `number` | `300`   | Timeout in seconds. Exceeding it is a **refusal**, not a pass. |

```toml
[automation]
accept_check = "bun run typecheck"
accept_check_timeout = 300
```

**Run the command the way a human would** — `bun run typecheck`, `make check`. Do not name a binary under `node_modules/.bin` directly: those are `#!/usr/bin/env node` shims that exit **127 before reading a single file** wherever `node` is not on PATH. Exit 127 gets its own refusal wording ("COULD NOT RUN"), and it still refuses — a gate that passes because nothing ran is the defect it exists to prevent.

Override a refusal knowingly with `lazy accept <task> --allow-broken`. The failure is still reported as a warning; the flag suppresses the refusal, never the fact. There is deliberately no config key that turns the gate into a silent pass, and the flag is CLI-only — over MCP the refusal says so instead of naming it.

**Before enabling this on a container-runner project, read the trust boundary in [The accept check](accept-check.md#where-it-runs-and-what-an-agent-can-influence).** The command comes from your committed config, but it runs on the daemon **host** with the agent-written worktree as its working directory — so what it resolves (`package.json` scripts, `Makefile`, `tsconfig.json`) is authored by the branch under review. Unlike `pre_accept`, it does not go through the runner.

---

## `[checks]` (deprecated)

**Deprecated — folded into `[automation]`.** `[checks] post_turn` and `[checks] post_turn_timeout` are now `[automation] post_turn` and `[automation] post_turn_timeout`, so every declarative hook lives in one table.

The old spelling still **works**: an existing `[checks]` value is applied to the corresponding `[automation]` key, because silently dropping a configured check would remove a project's only per-turn gate without a word. But it is deprecated —

- loading a config that uses it prints one generic line pointing at `lazy doctor`;
- `lazy doctor` reports the exact keys to move and where to move them;
- setting the same key in **both** sections to **different** values is a hard config error. lazy refuses to load rather than guess which one you meant. Delete the `[checks]` entry and keep the `[automation]` one.

```toml
# Old (deprecated)          # New
[checks]                    [automation]
post_turn = "bun test"      post_turn = "bun test"
post_turn_timeout = 300     post_turn_timeout = 300
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

The builder concurrency cap. Agent tasks are **uncapped**: every `lazy start`
launches immediately, no task ever queues, and a `blocked` task's container
stays warm until the task reaches a terminal state (accept/reject/close clean
it up). There is no agent concurrency setting; a leftover
`max_concurrent_agents` key is reported by `lazy doctor` as an unknown option.

| Key                       | Type     | Default | Description |
|---------------------------|----------|---------|-------------|
| `max_concurrent_builders` | `number` | `8`     | Max concurrent interactive builder containers. New `lazy builder`s beyond this **fail fast** with an actionable message — an interactive session a human is waiting on is never queued. |
| `max_turns_without_human` | `number` | `10`    | Max *consecutive* work turns a task may run without a human in the loop. Only builder (MCP) and agent-driven turns count — system/supervisor turns (auto-resume, watchdog restarts, sync turns, auto-react) are not double-gated here, since they have their own budgets. `0` = unlimited. |

```toml
[limits]
max_concurrent_builders = 8
max_turns_without_human = 10
```

The cap must be a **positive integer** (a cap `< 1` is rejected at load time).

**What counts as a live builder, and who enforces it.** The builder cap counts the live builder containers for this project plus any launch the daemon has admitted but whose container is not up yet (an in-flight reservation, dropped automatically after 60s if the launch never completes). Both the count and the verdict live in the **daemon**, which admits each builder atomically — so the cap holds for *any* launcher, not just `lazy builder`, and two launches racing for the last slot cannot both win. `lazy builder` still prints a friendly "limit reached" message before doing any work, but that check is a convenience: bypassing it (a script, a future web UI, a second copy of the CLI) does not bypass the cap. If the daemon or the container runtime is unreachable, an interactive builder launch is allowed through rather than blocked on infrastructure that is already broken.

**All builders are container-enumerable.** With `type = "docker"` or `"podman"`,
builder sessions appear as named containers and count toward the cap. There is
no separate uncapped host builder path.

This is the **permanent** cap. To steer it at runtime without editing
`lazy.toml`, use `lazy daemon config`:

- `lazy daemon config get` — configured value, ephemeral override, effective limit, and current running count.
- `lazy daemon config set max_concurrent_builders <value>` (alias `builders`) — set an **ephemeral** override for the current daemon session. This does **not** change `lazy.toml` and resets on daemon restart.
- `lazy daemon config reset [key]` — clear the override, reverting to `lazy.toml`.
- `lazy daemon config set usage_pause_threshold <percent|off>` — a **one-shot** override of [`[usage_pause]`](#usage_pause), used up by the first turn you start, unblock, resume, review or ask for that it lets past a pause.

**Turn cap (`max_turns_without_human`).** The counter is per-task and increments on every builder- or agent-initiated `lazy unblock`/`lazy resume`/`lazy start`; a **human**-initiated one always resets it to 0. At the cap, the daemon refuses a builder/agent-initiated unblock/resume/start with a `409` naming the task, the count, and the config key — the task stays `blocked` awaiting a human. A human action is never blocked by this cap.

## `[cluster]`

Bounds how much one child of a [cluster task](cluster-tasks.md) may cost.

| Key                     | Type     | Default | Description |
|-------------------------|----------|---------|-------------|
| `max_child_fix_rounds`  | `number` | `3`     | How many times a cluster may send the **same child** back with review feedback before lazy refuses and makes it decide. `0` = unlimited. |

```toml
[cluster]
max_child_fix_rounds = 3
```

A cluster drives its children unattended, and a child that keeps not-quite-passing
review can absorb any number of full agent turns with nobody watching the spend.
At the budget, lazy refuses the cluster's next send-back of that child and tells
it to accept the child, close it, or set it aside with a question for you.

The count is **per child**, so one stubborn child never spends another's budget
and children running at the same time never interfere with each other's.

The bound is on the **cluster's** judgement, never on yours. Unblocking that child
yourself is never refused, and doing so starts a fresh budget — as does starting
the child again, accepting it, or reopening it. The daemon's own recovery turns
are exempt for the same reason.

This section was called `[loop]` before the task type was renamed. A lazy.toml
still using the old name is reported by `lazy doctor` with the replacement.

## `[usage_pause]`

Stop **starting** turns on a credential once a subscription usage window is
nearly used up. It is useful when your account has overage (usage credits)
turned on and you would rather wait than pay for it. Without overage, the
provider already stops you at 100%. **Off by default.**

| Key                 | Type     | Default | Description |
|---------------------|----------|---------|-------------|
| `threshold_percent` | `number` | `0`     | Percent (0–100) of a usage window at which new turns wait. `0` = off. |
| `credentials`       | table    | `{}`    | Per-credential thresholds, named as `lazy stats limits` prints them. An entry wins over `threshold_percent` for that credential; `0` means never pause it. |

```toml
[usage_pause]
threshold_percent = 95
credentials = { "credential:CLAUDE_CODE_OAUTH_TOKEN" = 90 }
```

**What it reads.** The lazy proxy records the usage headers every model
response carries (see [proxy credentials](proxy-jit-credentials.md)). A
credential is paused while its latest reading has a subscription window at or
past its threshold, or a window the provider already reports as `rejected`.
Which windows count depends on the agent:

- **Claude Code:** the Claude subscription 5-hour and 7-day windows.
- **Codex:** the ChatGPT subscription windows.
- **Other agents:** never paused, because lazy has no usage signal for them.

Per-minute API-key rate limits never cause a pause. They refill within a
minute and are not overage.

**What happens while a credential is paused:**

- **You ask for something that runs a model** — refused before anything is
  written. That covers starting, unblocking or resuming a task, `lazy review`,
  `lazy ask`, a `lazy sync` whose merge conflicts (a sync only runs the agent
  to resolve a conflict; a clean one goes ahead), a message in a review
  conversation, `lazy describe` (and the description `lazy link` writes),
  `lazy memory compact` with a model, `lazy report`, `lazy pair` and
  `lazy chat` (and the dashboard's Pair and Chat terminals). The error names the credential, the window, the reading, the
  threshold and when the window resets. `lazy unblock` and `lazy ask` check
  this before they open your editor — including `lazy ask` on a finished task,
  which is answered from the task's record on the builder's credential. A
  command that makes several model calls, such as `lazy report`, is judged
  once when it starts, so a started report finishes; a `lazy pair` or
  `lazy chat` session is judged once when it opens. `lazy reparent` still
  moves the task when its sync conflicts; that sync waits and runs by itself
  after the reset.
- **An agent starts one of its own subtasks** (a cluster task starting its
  children) — the start waits instead of failing: nothing launches, the agent
  is told the start is held, and the subtask starts by itself when the window
  resets. The agent is told to end its turn rather than wait — waiting would
  spend a model request on the paused credential every few minutes. Once the
  subtask has started, lazy wakes a cluster task; any other task finds a note
  about it on its next turn. A `lazy wait` on the subtask still
  treats it as running in the meantime.
- **Agents and the builder never get the override** through their tools
  (described below): their refusals only say when the window resets.
- **Lazy launches a turn by itself** (resuming an interrupted task,
  delivering CI results or pull-request comments, restarting a cluster for a
  new child, the automatic review after a task declares it is done, the fix
  turn after a review with `auto_fix` on, a sync that hits a conflict) — the
  turn waits instead, and nothing is used up while it waits: no review round
  and no auto-react budget is counted until the turn actually starts. These
  turns never use your one-shot override. The turn goes ahead by itself when
  the window resets. `lazy show` on the task says what is waiting, and the
  first wait of a pause is announced in `lazy messages`. A review that is
  waiting is recorded on the task as not run yet, so `lazy accept` holds the
  unreviewed work meanwhile.
- **A turn already running** — never stopped, and neither is anything lazy
  sends inside it.

A reading is only as fresh as the last request. Once a window's reset time
has passed, the reading no longer pauses anything. If the provider gave no
reset time, the pause lasts at most 30 minutes after the reading. Lazy keeps
the latest reading for each credential in its store, so a paused credential
stays paused across a daemon restart or upgrade, even days into a 7-day
pause.

**Armed, but no reading.** Pausing can only act on a credential whose
responses carry a subscription usage window. If lazy has spent turns on a
credential and none of them brought one back — an API key, or a provider
that sends its usage headers under names lazy does not recognise — pausing
cannot engage for it, and every turn on it starts. Lazy says so rather than
staying quiet: `lazy doctor` warns "armed, NO READING" for that credential,
and `lazy stats limits`, `lazy daemon config get` and the dashboard show it
too. `lazy stats limits` also marks a window whose reset has passed since its
reading as STALE instead of showing the old percentage.

**Saved readings lazy cannot read.** Lazy keeps the latest reading per
credential in its task store, so a pause survives a restart. If that file is
damaged, lazy does not treat it as "no readings": it refuses every launch the
pause would judge, and `lazy doctor`, `lazy stats limits`,
`lazy daemon config get`, the dashboard and the Lazy Teams project page say
"saved usage readings unreadable at <path>". Move the file aside or restore it;
launches go ahead again at the next check. The one-shot override below does not
lift this.

**Letting one turn through.** To go past the threshold once, for example to
finish a task, run this yourself, at your own terminal:

```sh
lazy daemon config set usage_pause_threshold off
```

It is refused without an interactive terminal, from inside a container, and
from anything that is not you, because the override is how a person decides
to spend past the limit. The agent tools never set or use it. `lazy report`,
`lazy ask` on a stored conversation, `lazy pair` and `lazy chat` use it only
from your own terminal too; other commands you run on the host use it
whenever they are the first paused launch. The dashboard's Pair and Chat
buttons use it as well (you are signed in to the dashboard), and on a Lazy
Teams host so does a member's own request, which Lazy Teams sends on that
member's own token.

The override is used up by the **first** thing you ask for that it lets past
a pause — a start, unblock, resume, review, ask or any of the others above. Then `lazy.toml` applies again. A launch that
was not paused anyway (another credential, an agent lazy cannot measure,
pausing off) does not use it, and neither does one it would not let through.

`off` is the value to use: it lets the next paused turn start whatever the
reading. A number is a threshold for that one turn, so it only helps when it
is above the reading. Even `100` still pauses at a full window, or one the
provider already refuses.
Turns lazy starts by itself never use it. It is also dropped if the daemon
restarts. `lazy daemon config reset usage_pause_threshold` clears it unused.

**Where to look.** `lazy stats limits` marks paused credentials.
`lazy daemon config get` shows the thresholds, a pending override (and when
it was set), and what is waiting. The dashboard home page and the Lazy Teams
project page show paused credentials and ones with no reading. On Lazy Teams a
member sees only their own credential, the project's service credential and
credentials not tied to a member; a site administrator in admin mode sees them
all, including where the saved readings file is when it cannot be read.
`lazy doctor` explains an active pause, a pending override and a missing
reading in full.

**Paid overage.** When Claude reports whether paid overage is enabled on a
credential, every one of those places says so: "overages ENABLED on this
credential: the pause is what keeps you under", or that overage is off, with
the reason Claude gives (the provider then stops at the limit itself). This is
information only; it never changes when a credential pauses.

**Reading the numbers from the builder.** The builder has a `lazy_usage_limits`
tool that returns exactly what `lazy stats limits --json` prints: for each
credential, every window's `usedPercent` and `resetsAt`, the provider's
status, whether paid overage is enabled, and whether `[usage_pause]` is
holding it — plus the configured thresholds, the tasks waiting on a pause, and
every credential the pause is armed for with whether it has a usable reading
(one armed with no reading is listed, not just missing). While lazy cannot
read its saved readings, both refuse and name the file rather than answer with
an empty list. Ask the builder to check it before planning a large batch of work, and it can
size the batch to what is left in the window. On a shared Lazy Teams host the
builder sees the project's service credential and its own member's, never
another member's. A task's own agent can call the same tool but sees only the
credential its current turn is spending.

On a shared Lazy Teams host, each member's turns spend that member's own
credential, so each member is paused on their own reading. Turns lazy starts
by itself are paused on the project's service credential.

## `[daemon]`

Controls the daemon's auto-react behavior — automatically unblocking tasks in response to CI failures, PR/MR comments, and other triggers.

**A lazy task comment never starts a turn.** Comments you add with `lazy comment`, in the web UI, or through the `lazy_comment` MCP tool are feedback: they are delivered in the prompt of the next `lazy unblock`, under a "notes added since your last turn" heading. `lazy ask` and `lazy sync` do not carry comments — and never consume them, so a comment queued before an ask still reaches the agent on the unblock that follows. `auto_react_comments` covers only comments made on the task's pull/merge request on the forge, where nobody is about to resume the task by hand.

| Key                       | Type     | Default         | Description |
|---------------------------|----------|-----------------|-------------|
| `auto_react_ci`           | `bool`   | `true`          | React to CI failures (auto-unblock blocked tasks when CI fails). |
| `auto_react_comments`     | `bool`   | `true`          | React to comments on the task's **pull/merge request** on the forge (auto-unblock the task when someone comments there). Lazy's own task comments are not covered — see below. |
| `auto_react_max_retries`  | `number` | `3`             | Max auto-unblocks per task *per trigger type* before the task is paused for human review. |
| `auto_react_backoff`      | `string` | `"exponential"` | Backoff strategy between repeated auto-unblocks of the same trigger: `"none"`, `"linear"`, or `"exponential"`. |
| `auto_react_daily_budget` | `number` | `50`            | Max auto-triggered turns per day across all tasks in the project. Resets at **local midnight** (machine timezone). |
| `max_auto_turns`          | `number` | `3`             | Max *consecutive* auto-triggered turns per task before the task is paused for human review. The counter resets whenever a human manually unblocks the task or the task reaches a terminal state. |
| `auto_resume`                      | `bool`   | `true`  | Master switch for auto-resuming interrupted tasks (both the fast lane and the slow lane below). `false` disables both — a crashed task then waits for a manual `lazy resume`. |
| `auto_resume_interval_minutes`     | `number` | `30`    | Once a task's fast-lane retries are spent (its circuit breaker tripped), how often it is retried on the slow lane. |
| `auto_resume_gap_minutes`          | `number` | `5`     | Minimum spacing between ANY two auto-resumes project-wide, fast lane or slow lane — a fairness floor so a burst of simultaneous crashes can't relaunch every task at once. |
| `auto_resume_max_attempts`         | `number` | `24`    | Slow-lane attempts before a task gives up for good (default: 24 × 30 min ≈ 12 hours). If a task hasn't recovered by then it needs a human — resume it manually with `lazy resume`. |

```toml
[daemon]
auto_react_ci = true
auto_react_comments = true
auto_react_max_retries = 5
auto_react_backoff = "exponential"
auto_react_daily_budget = 100
max_auto_turns = 3
auto_resume = true
auto_resume_interval_minutes = 30
auto_resume_gap_minutes = 5
auto_resume_max_attempts = 24
```

### Auto-resume: fast lane and slow lane

A crashed or interrupted task first tries the **fast lane**: an immediate resume, up to 3 consecutive interruptions. If it keeps crashing, that circuit breaker trips and the task falls to the **slow lane** — a round-robin retry queue, each task retried on its own `auto_resume_interval_minutes` cadence (counted from when it entered the queue, not from whenever it's next inspected), up to `auto_resume_max_attempts` before it stops for good. `auto_resume_gap_minutes` is a single project-wide throttle shared by BOTH lanes — at most one auto-resume, fast or slow, happens per gap window — so a burst of simultaneous crashes can't relaunch every task at once on the fast lane before any of them even reaches the slow lane. Any healthy turn — a successful resume, a completed sync, daemon-restart recovery — clears a task out of both the fast-lane counter and the slow-lane queue. A resumed turn continues the agent conversation the crashed turn was in, not a fresh one: lazy records the session id from the failed turn's own output, so the agent picks up its context instead of receiving the prompt again from scratch.

Inspect the current slow-lane queue with:

```
lazy daemon resume-queue
```

which lists each queued task's attempts used/max, last attempt time, next eligible time, and whether the project-wide gap or its own retry interval is what's currently holding it back. `lazy show`/`lazy list` also surface a queued task's next auto-resume window inline. `lazy daemon health` flags interrupted tasks that nothing will resume any more — auto-resume gave up on them, or `auto_resume` is off — so they can be resumed by hand with `lazy resume <task>`.

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
  root). A daemon whose project root has been deleted is marked `(stray)`, and state
  dirs with no daemon behind them are reported as orphans.
- `lazy daemon kill-stray` — reap only stray daemons (those whose project root no longer
  exists). A daemon whose root still exists is **never** touched. Requires confirmation;
  pass `--yes` for non-interactive callers and `--prune-dirs` to also remove orphaned
  state dirs.

A state dir counts as *running* only if the process behind its recorded PID is verified
to be that daemon — by answering `/daemon/status` on its recorded TCP port for the right
project, by holding the dir's daemon lock, or by
its command line. A PID alone proves nothing: the OS reuses PIDs, so a dir left behind
months ago will eventually record a PID that belongs to some unrelated process. Such a
dir is reported as an orphan (and is removable with `--prune-dirs`), and its recycled
PID is never signalled. When two dirs record the same PID, only the one that verifies is
listed. If none of those signals can be evaluated at all, the daemon is assumed alive —
the safe direction, since a wrong "dead" verdict would let `--prune-dirs` delete a live
daemon's state and token.

Daemon state lives under `~/.lazy/daemon/<slug>/` by default. Set the
`LAZY_DAEMON_BASE_DIR` environment variable to relocate it — useful for isolated test
runs or custom operator setups. It is honored by every daemon path, including the
`list`/`kill-stray` scan, so all daemons agree on a single location.

### Surviving a daemon restart (running agents and builders)

A running agent or builder talks to the daemon through a small config file minted at
launch and bind-mounted into its container: its own MCP token (minted per task
session and per builder session, so an agent can only ever act as itself) plus a target of
`http://host.docker.internal:<web port>`. Restart the daemon (an upgrade, a crash, `lazy
daemon restart`) and that file can go stale, which would leave **every** `lazy_*` tool
in the live session returning `Unauthorized` until the session was relaunched.

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
