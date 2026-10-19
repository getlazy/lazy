# Managed mode: which parts of `lazy.toml` a shared host honours

Normally, `lazy.toml` is yours. You committed it, you run lazy on your own
machine, and every key in it is honoured exactly as written. **Nothing on this
page applies to that.** Managed mode is off by default and, when off, changes
nothing at all.

Managed mode is for a **shared host** — any fleet where one machine runs
daemons for projects belonging to different people. There,
`lazy.toml` arrives with the repository, and a repository is untrusted input.
A committed config that says "run agents outside the container, as the fleet
user" is not a preference; it is an escape. So on a managed host lazy sorts
every config key into three buckets:

| | what happens | how you find out |
|---|---|---|
| **Respected** | honoured exactly as written | — |
| **Overridden** | the fleet's value is used; your ask is recorded | `lazy doctor` |
| **Refused** | kept in the file but **not used**; the project still starts | `lazy doctor`, the provisioning log, and the Lazy Teams Configuration page |

## Why override some keys and refuse others

Both are equally safe — neither honours the repository. The choice is about
**diagnosability**:

- **Override** when the fleet's value is a drop-in substitute and your project
  still does what you meant. You asked for a specific `[server] port`; you get
  a different one; everything works. Silently substituting is fine because
  nothing about your project's behaviour changed.
- **Refuse** when the fleet does not offer the capability at all. A refused
  setting is never used, but it never stops the project either: it stays in
  the file and is named, with the reason, wherever you would look — `lazy
  doctor`, the provisioning log, and on Lazy Teams the Configuration page. A
  refused agent profile, or one that uses a refused endpoint, is not
  available, and a task on it says why.

## Unclassified keys fail closed

A config key with no entry in the classification is **refused**, not
overridden. Overriding to a default asserts that the default is safe — which is
exactly the judgement nobody made for a key that nobody classified.

In practice you should never see this: lazy's own test suite fails when a
config key it knows has no classification, so an unclassified key cannot reach
a release. The runtime refusal is the backstop.

A key lazy does not know at all — a typo, or a stale option from an older
version — is **not** refused. Lazy never reads it, so it cannot do anything.
Those still show up in `lazy doctor` as unknown options, exactly as they always
have.

## Finding out why your config is being ignored

Run `lazy doctor` in the project. On a managed host it prints one line per key
the fleet is not honouring:

```
⚠ lazy.toml 'runner.type'
  This repository's lazy.toml asks for "host"; managed mode uses "docker".
  A host runner would run agent code outside any container, as the fleet user,
  on a machine shared with other projects.
```

That is the only surface that explains it. Everything else — a start failure, a
provisioning error — carries one generic pointer here rather than repeating the
diagnosis, because an override warning printed on every config load would land
in the middle of every agent turn.

A **refused** setting is reported the same way: `lazy init` lists every one it
finds in the repository's committed config, and `lazy doctor` names each one
with the reason. The project starts without them.

## How a host becomes managed

Four environment variables, read at daemon start:

| variable | required | meaning |
|---|---|---|
| `LAZY_MANAGED` | — | `1` or `true` arms managed mode. Anything else, including unset, leaves lazy completely unchanged. |
| `LAZY_MANAGED_STORAGE_PATH` | yes | Absolute path to the store the fleet assigned this project. |
| `LAZY_MANAGED_RUNNER` | no | `docker` (default) or `podman`. Nothing else is accepted — including `host`. |
| `LAZY_MANAGED_BACKEND` | no | Where this project's container builds run. `microvm`: the project has its own virtual machine, so a committed `Dockerfile.lazy` at the project root is built automatically. `local-docker`, anything else, or unset: builds would run on a machine shared with other projects, so a root `Dockerfile.lazy` is never built automatically (tasks use the default image and a system message says so). An explicit `[docker] dockerfile` in the project configuration is honoured either way. |

Deliberately **not** a `lazy.toml` key: `lazy.toml` is the untrusted input this
whole mechanism exists to bound. A managed host armed without a storage path
refuses to run rather than falling back to the repository's `external_path`.

A fleet host sets these in the environment of each project's daemon when it
starts it; Lazy Teams does this for every project it runs.

## Code from the repository

The same reasoning covers code a repository ships, not just settings:

| what the repository ships | on a managed host |
|---|---|
| `.lazy/plugins/` (proxy request plugins) | **Not run — here or on your own machine.** They would run inside the daemon process itself, unsandboxed, on the host. The daemon log and `lazy doctor` name any that are ignored. |
| `Dockerfile.lazy` / `[docker] dockerfile` | Built by docker, never run by the daemon; a root `Dockerfile.lazy` is built automatically only where the project has its own virtual machine (see `LAZY_MANAGED_BACKEND` above). |
| `[automation] pre_turn` / `post_turn`, `[checks] post_turn`, `[serve] start_services_cmd` | Run inside the task's container. |
| `[automation.pre_accept]` commands | Run in their own short-lived container. |
| `[automation] accept_check` | Runs in the same short-lived container as `[automation.pre_accept]` — the scripts it calls come from the task's branch, so it never runs on the host. |

## The classification, in full

Every key lazy resolves appears below. Non-respected keys carry the reason.

### Refused

| key | why |
|---|---|
| `agents.*.endpoint` | An [agent profile](lazy-toml.md#agentsname--named-agent-profiles)'s endpoint is the upstream the proxy forwards to, carrying the real model credential — a repository choosing it is credential redirection. A profile with no `endpoint` is fine. Allowed in the host's own config file, including a copy a team admin imported (below). |
| `agents.*.credential` | A credential name the fleet did not assign reaches for a secret slot nobody gave this repository. Naming one of lazy's own providers (`anthropic`, `openai`, `openrouter`, `ollama`, `cursor`) or `none` is fine. Allowed in the host's own config file, including a copy a team admin imported (below). |
| `endpoints.*.url` | A [named endpoint](lazy-toml.md#endpointsname--named-endpoints)'s URL is an upstream the proxy forwards to with the real model credential, exactly like `agents.*.endpoint`, and allowed in the same places. |
| `endpoints.*.credential` | A named endpoint's credential name selects a secret slot, exactly like `agents.*.credential`, and allowed in the same places. |
| `models.roles.*.backend` | A non-Anthropic role backend sends the model credential somewhere the fleet did not choose; team-level backends are configured by the team, not by a repository. Stating `"anthropic"` explicitly is fine. (The key was since removed from lazy.toml altogether — a config that still has it does not load.) |
| `models.roles.*.endpoint` | An arbitrary endpoint URL from a repository receives the real model credential. (Also removed from lazy.toml — see `agents.*.endpoint` above.) |
| `proxy.upstream` | The daemon fetches this URL from the host carrying the real model credential — a repository choosing it is credential redirection. |
| `proxy.cursor_upstream` | Same, for the cursor passthrough route: the fleet host dials it carrying the real cursor credential. |
| `proxy.fallback[].upstream` | A failover target receives the same credential as the primary upstream. |
| `proxy.fallback[].model` | A failover entry cannot exist without the upstream it belongs to, which is refused. |
| `[[mounts]]` (whole section, every field) | A repository cannot mount host paths into its agent container on a shared machine. This is the worst case in the whole file: mounts are read-write by default, and the mount validator is a denylist, not an allowlist. |
| `remote.github_dangerously_sync_comments_in_public_repos_…` | Feeds public comment text to the agent as instructions; on a shared host a prompt-injected agent is a foothold. The key's own name is the argument. Stating `false` is fine. |
| `remote.gitlab_dangerously_sync_comments_in_public_repos_…` | Same. |
| *anything unclassified* | See "fail closed" above. |

### Overridden

| key | why the fleet's value wins |
|---|---|
| `runner.type` | A host runner would run agent code outside any container, as the fleet user, on a machine shared with other projects. **This is the linchpin of the whole classification** — every "safe because it runs in the container" judgement below rests on it. |
| `runner.permission_mode` | The permission posture is the fleet's, and `bypass` removes the sandbox the host relies on. |
| `runner.sandbox_allowed_domains` | The reachable-domain list is host policy; a repository widening it widens the host. |
| `runner.sandbox_deny_read` / `runner.sandbox_deny_write` | Sandbox denials are the fleet's floor and are not negotiated per repository. |
| `runner.sandbox_allow_weaker_nested` | Permitting a weaker nested sandbox is exactly the escalation a shared host must not accept from a repository. |
| `runner.verify_sandbox_boundary` | Has no effect. |
| `proxy.port` | A fixed port collides across the projects sharing this host. |
| `proxy.bind` | The bind address decides who else on the host can reach this project's proxy. |
| `proxy.policy.enforce` | Enforcement is the fleet's posture; a repository turning it off would disable its own tool-call policy. |
| `proxy.policy.deny_secret_path_reads` | The secret-path denylist is the fleet's floor, not a project preference. |
| `proxy.policy.connector_allowlist` | Re-allowing a denied connector widens what agents on this host can reach. |
| `proxy.policy.egress_allowlist` | The egress posture belongs to the host every project shares. |
| `credentials.backend` | Which secret store the daemon writes to is a property of the host it runs on: a fleet host has one secret service, or none, and a repository asking for the plaintext `file` fallback would write a credential onto a machine it does not own. |
| `storage.backend` | The project's store is assigned by the fleet, not stated by the repository. |
| `storage.external_path` | A repository naming a store path could point the daemon at another project's state. |
| `storage.backup_keep` | The fleet keeps the count: the host backs the store up before every roll, and on the local-docker backend the daemon also takes one before it starts on a new version. |
| `data.path` | The daemon's state directory is placed by the fleet, and a repository-chosen path writes wherever it points. |
| `server.port` | A fixed port collides across the projects sharing this host. |
| `server.bind` | The bind address decides who else on the host can reach this project. |
| `server.dashboard_url` | The dashboard is disabled on a managed host, so a public dashboard origin has no effect. |
| `server.sync_interval` | The poll interval is load on a machine shared with every other project. |
| `limits.max_concurrent_builders` | Concurrency is host capacity, and one repository must not be able to claim it all. |
| `[features]` (whole section) | Feature flags are freeform, so none of them can be classified in advance; a managed host runs the fleet's set. This is the fail-closed rule applied to a section that can never be enumerated. |

### Respected, with a containment guard

These are honoured, but the value must stay inside the project directory. An
absolute path or a `..` that escapes the checkout is refused — it would reach
host files that are not this project's.

`docker.dockerfile` · `worktree.include` · `documents.path`

### Respected

Everything else. In full:

`models.default` · `models.roles.*.model` · `models.roles.*.agent` ·
`agents.*.harness` · `agents.*.model` · `agents.*.description` · `agents.*.named_endpoint` · `agents.*.tiers[].endpoint` · `agents.*.tiers[].model` · `agents.*.tiers[].threshold_percent` · `endpoints.*.description` ·
`proxy.retry_after_threshold` · `proxy.tier_retry_interval` · `proxy.upstream_timeout` ·
`proxy.audit_retention_days` · `proxy.audit_retention_mib` ·
`proxy.policy.deny_path_globs` (it can only ever
ADD denials) · `docker.build_inputs` · `docker.run_args` · `remote.driver` · `remote.git_remote` ·
`remote.auto_approve` · `remote.offline` · `remote.github_auto_push` ·
`remote.gitlab_auto_push` · `automation.maintain` · `automation.react` · `automation.pre_accept` ·
`automation.pre_accept.enabled` · `automation.pre_accept.commands` ·
`automation.pre_accept.timeout` · `automation.pre_turn` ·
`automation.pre_turn_timeout` · `automation.pre_turn_required` ·
`automation.post_turn` · `automation.post_turn_timeout` ·
`automation.accept_check` · `automation.accept_check_timeout` · `checks.post_turn` ·
`checks.post_turn_timeout` · `session.verbose` · `session.debug` ·
`session.auto_commit_instructions` · `git.default_branch_prefix` ·
`git.lfs_check` · `git.coauthor_trailer` · `output.shortid_length` · `agent.agent_id` ·
`agent.by_type` · `agent.watchdog_output_timeout_ms` · `agent.wind_down_timeout_ms` ·
`agent.graceful_exit_timeout_ms` · `agent.effort` · `agent.low_high_loop` ·
`agent.low_high_loop_draft_effort` · `agent.low_high_loop_review_effort` ·
`builder.effort` · `chattiness.default` · `chattiness.builder` ·
`chattiness.agent` · `permissions.protected` · `protection.enabled` ·
`protection.protected_branches` · `protection.protected_tasks` ·
`protection.gate_default_branch` ·
`serve.ports` · `serve.services` · `serve.start_services_cmd` · `serve.main_service` ·
`memory.warn_bytes` · `docs.url` ·
`daemon.auto_react_ci` · `daemon.auto_react_comments` ·
`daemon.auto_react_max_retries` · `daemon.auto_react_backoff` ·
`daemon.auto_react_daily_budget` · `daemon.max_auto_turns` ·
`limits.max_turns_without_human` · `cluster.max_child_fix_rounds` ·
`loop.max_child_fix_rounds` (the deprecated spelling, still honoured) ·
`usage_pause.threshold_percent` · `usage_pause.credentials` ·
`review.mode` · `review.auto_fix` · `review.gate` · `review.draft_effort` ·
`review.review_effort` ·
`agent.low_high_loop` · `agent.low_high_loop_draft_effort` ·
`agent.low_high_loop_review_effort` (the deprecated spellings of the three
`[review]` keys above, still honoured) ·
`daemon.auto_resume` ·
`daemon.auto_resume_interval_minutes` · `daemon.auto_resume_gap_minutes` ·
`daemon.auto_resume_max_attempts`

A resolved role is a flattened agent profile, so lazy's own resolution puts a
few more fields on it than any `lazy.toml` key spells —
`models.roles.*.harness`, `models.roles.*.credential`, `models.roles.*.wire`,
`models.roles.*.pinned` and `models.roles.*.profile`. They are classified as
respected because their values come from asks that were already classified
above (`models.roles.*.agent` and the `[agents.<name>]` block it names), never
from a string a repository put there.

The automation hooks deserve a note, because "does this run on the host?"
is the question that decides the whole table. `automation.pre_turn` and
`automation.post_turn` run **inside the agent container** — but only because
`runner.type` is overridden. Under a host runner
they would execute on the fleet machine. `automation.pre_accept` — the
acceptance gate — runs in its own ephemeral gate container (same runner type,
no agent inside), so it never executes on the fleet machine either way. That
is why the runner is the linchpin,
and why it is not negotiable.

## What lives where

The classification is a property of **lazy** itself, not of any one fleet
product: a self-hosted single-tenant managed install needs exactly the same
table, and `lazy doctor`
needs to point somewhere that renders. So the table and the mechanism live in
lazy itself; the fleet-side decisions (how the daemon is
armed, how a refusal is surfaced in the UI) belong to the managed product
itself.

## When the host owns the config file

A host can take ownership of a project's `lazy.toml` altogether. It sets
`LAZY_MANAGED_CONFIG_PATH` in the daemon's environment to an absolute path
**outside** the project checkout (a path inside it is refused). Until that file
exists, lazy reads the repository's `lazy.toml` as usual. Once it exists, lazy
reads only that file — changes to the repository's `lazy.toml` no longer have any
effect, and nothing is ever written into the checkout.

Lazy Teams uses this for its project **Settings → Configuration** page:

Repositories may set `[docker] run_args` on a managed host. These arguments
apply to every task container and can grant access to other containers or the
host. Adopt projects only after reviewing their Docker arguments; the
Configuration page displays a persistent warning when the saved configuration
sets non-empty arguments.

- When a project is set up, its repository's `lazy.toml` is copied once, exactly
  as written — nothing in it is refused or dropped. Later changes to the
  repository's file are not picked up, except that endpoints and agent profiles
  it adds are offered on the Endpoints and agent profiles page (below); copy anything else in on
  the page.
- Settings this installation does not allow (for example an endpoint URL) are
  kept in the file but not used. The page lists every agent profile the file
  defines as usable, not used (with the reason), and notes
  each setting that is kept but not used. An edit is refused only for such a
  setting it adds.
- **Importing is consenting to the project's endpoints.** An endpoint's URL and
  credential, and a profile's own endpoint and credential, decide where requests
  go and which key pays for them. When a team admin (or a site admin) creates
  or adopts the project, the import of its `lazy.toml` is their choice, so its
  endpoints and agent profiles can be used straight away. The configuration's
  history records who imported it, when, and every endpoint (URL and credential
  name) it brought in. Because the repository's file is read only that once, a
  later push to the repository cannot change where requests go. Each member
  still connects their own key for each endpoint under **Your credentials**, and
  a key is only ever used for the endpoint address it was connected for.
- Projects imported before imports recorded who did them are treated the same
  way when the admin who created the project is known; the history says so in a
  version of its own. Where nobody is recorded, the copy's endpoints are not
  used until a team admin confirms them under **Settings → Configuration →
  Endpoints and agent profiles**, which lists each one (URL, credential name, the
  profiles using it) and records who confirmed. That page also offers blocks the
  repository's `lazy.toml` added after the copy was made, brought in when
  confirmed. There is no CLI or MCP way to confirm. A task on a profile still
  waiting says so wherever it is refused, with a link to that page.
- The page shows what the project is actually running on — the file, the saved
  version it came from and a hash of its contents — and warns when that is not
  the newest saved version, with the reason when a version was refused.
  `lazy daemon status` shows the same file, hash and version.
- A task can only be given an agent profile this configuration defines; any
  other name is refused when the task is created or edited, and the message
  names the configuration that was loaded.
- The team's owner edits it on the page; every member can read it, and anyone who
  can read it can download it as a `lazy.toml` to commit if they wish. Every save
  is kept as a new version with who saved it and when, and the history shows
  what each version changed as a diff against the one before it.
- Settings are edited in a form, grouped by what they are for. Each shows what it
  does, lazy's default, and when a change to it is picked up. Settings with list
  or table values (protected files, maintained files, agent profiles) are edited
  in the `lazy.toml` text, which stays available underneath the form; comments
  in the file are kept when the form saves.
- **Check** judges a change without saving it and lists what saving would change.
  Each save is checked by lazy first too, with the same rules a load uses: an
  error names the setting it is about, and a configuration with errors is not
  saved. Settings the host decides (see the tables above) and settings lazy does
  not recognise are reported as notes — they are kept in the file but have no
  effect.
- lazy re-reads the configuration every time it does something, so a saved change
  needs no restart: it is picked up the next time lazy does what that setting
  governs. After a save the page names each changed setting and when that is —
  when the next turn starts (models, effort, usage pause), when the next turn
  finishes (after-turn checks, protected files), at the next review or accept,
  within a minute for background behaviour such as resuming interrupted work, or
  immediately for settings like the forge driver.
  The exception is what lazy's proxy is set up with when the project starts:
  `[proxy] retry_after_threshold`, `tier_retry_interval`, `upstream_timeout`,
  `audit_retention_days`, `audit_retention_mib`,
  `[proxy.policy] deny_path_globs`, and agent profiles (`[agents.<name>]`)
  that send their traffic to their own endpoint. Changing any of those restarts
  the project, which pauses work in progress and resumes it.
- Agent profiles in this file may set `endpoint` and `credential` (including
  ones copied from the repository at setup), although a repository's own
  `lazy.toml` may not: on a managed host a profile's own endpoint is paid
  **only** by the credential each member connects for that profile — never by
  the host's own credentials — and members see the endpoint before they connect
  one. A member's
  credential is sent only to the endpoint the profile had when they connected
  it; if the owner points the profile elsewhere, it is not used until they
  connect it again.
- It is one-way: a downloaded or committed copy is never read back.
- If a saved configuration stops loading after an upgrade, the project cannot
  start. The owner fixes it on the same page: the correction is checked by
  lazy, saved, and — unless the project was stopped on purpose — the project is
  started with it. When another project on the
  installation already runs the current version of lazy, it checks the fix
  before it is saved. Otherwise the project's own start is the check: if the
  configuration still cannot be loaded, lazy's reason is shown on the page
  next to the saved version, so it can be corrected and saved again.
