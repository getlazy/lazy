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
| **Refused** | the project does not start until the key is removed | the start/provisioning error, and `lazy doctor` |

## Why override some keys and refuse others

Both are equally safe — neither honours the repository. The choice is about
**diagnosability**:

- **Override** when the fleet's value is a drop-in substitute and your project
  still does what you meant. You asked for a specific `[server] port`; you get
  a different one; everything works. Silently substituting is fine because
  nothing about your project's behaviour changed.
- **Refuse** when the fleet does not offer the capability at all. Silently
  dropping `[[mounts]]` would leave your project running as something
  materially different from what you configured, with no failure to trace. A
  refusal is loud, once, at the moment you'd otherwise start debugging.

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

A **refusal** is different: it is not a warning to go looking for, it is the
error you already got. It fires at the earliest possible moment — `lazy init`
checks the repository's committed config before it writes anything — and then
on every command afterwards, naming each refused key and what to do about it.

## How a host becomes managed

Three environment variables, read at daemon start:

| variable | required | meaning |
|---|---|---|
| `LAZY_MANAGED` | — | `1` or `true` arms managed mode. Anything else, including unset, leaves lazy completely unchanged. |
| `LAZY_MANAGED_STORAGE_PATH` | yes | Absolute path to the store the fleet assigned this project. |
| `LAZY_MANAGED_RUNNER` | no | `docker` (default) or `podman`. Nothing else is accepted — including `host`. |

Deliberately **not** a `lazy.toml` key: `lazy.toml` is the untrusted input this
whole mechanism exists to bound. A managed host armed without a storage path
refuses to run rather than falling back to the repository's `external_path`.

A fleet host sets these in the environment of each project's daemon when it
starts it; Lazy Teams does this for every project it runs.

## The classification, in full

Every key lazy resolves appears below. Non-respected keys carry the reason.

### Refused

| key | why |
|---|---|
| `agents.*.endpoint` | An [agent profile](lazy-toml.md#agentsname--named-agent-profiles)'s endpoint is the upstream the proxy forwards to, carrying the real model credential — a repository choosing it is credential redirection. A profile with no `endpoint` is fine. |
| `agents.*.credential` | A credential name the fleet did not assign reaches for a secret slot nobody gave this repository. Naming one of lazy's own providers (`anthropic`, `openai`, `openrouter`, `ollama`, `cursor`) or `none` is fine. |
| `models.roles.*.backend` | A non-Anthropic role backend sends the model credential somewhere the fleet did not choose; team-level backends are configured by the team, not by a repository. Stating `"anthropic"` explicitly is fine. (The key was since removed from lazy.toml altogether — a config that still has it does not load.) |
| `models.roles.*.endpoint` | An arbitrary endpoint URL from a repository receives the real model credential. (Also removed from lazy.toml — see `agents.*.endpoint` above.) |
| `proxy.upstream` | The daemon fetches this URL from the host carrying the real model credential — a repository choosing it is credential redirection. |
| `proxy.cursor_upstream` | Same, for the cursor passthrough route: the fleet host dials it carrying the real cursor credential. |
| `proxy.fallback[].upstream` | A failover target receives the same credential as the primary upstream. |
| `proxy.fallback[].model` | A failover entry cannot exist without the upstream it belongs to, which is refused. |
| `[[mounts]]` (whole section, every field) | A repository cannot mount host paths into its agent container on a shared machine. This is the worst case in the whole file: mounts are read-write by default, and the mount validator is a denylist, not an allowlist. |
| `docker.run_args` | Extra `docker run` arguments shape the container itself: `--privileged` or a `-v /:/host` from a cloned lazy.toml would be a host handover — the same class of ask as `[[mounts]]`. Stating an empty array is fine. |
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
| `runner.verify_sandbox_boundary` | The boundary self-check spends real agent sessions on the host, so the fleet decides when it runs. |
| `proxy.port` | A fixed port collides across the projects sharing this host. |
| `proxy.bind` | The bind address decides who else on the host can reach this project's proxy. |
| `proxy.policy.enforce` | Enforcement is the fleet's posture; a repository turning it off would disable its own tool-call policy. |
| `proxy.policy.deny_secret_path_reads` | The secret-path denylist is the fleet's floor, not a project preference. |
| `proxy.policy.connector_allowlist` | Re-allowing a denied connector widens what agents on this host can reach. |
| `proxy.policy.egress_allowlist` | The egress posture belongs to the host every project shares. |
| `credentials.backend` | Which secret store the daemon writes to is a property of the host it runs on: a fleet host has one secret service, or none, and a repository asking for the plaintext `file` fallback would write a credential onto a machine it does not own. |
| `storage.backend` | The project's store is assigned by the fleet, not stated by the repository. |
| `storage.external_path` | A repository naming a store path could point the daemon at another project's state. |
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
`agents.*.harness` · `agents.*.model` ·
`proxy.retry_after_threshold` · `proxy.upstream_timeout` ·
`proxy.policy.deny_path_globs` (it can only ever
ADD denials) · `docker.build_inputs` · `remote.driver` · `remote.git_remote` ·
`remote.auto_approve` · `remote.offline` · `remote.github_auto_push` ·
`remote.gitlab_auto_push` · `automation.maintain` · `automation.react` · `automation.pre_accept` ·
`automation.pre_accept.enabled` · `automation.pre_accept.commands` ·
`automation.pre_accept.timeout` · `automation.pre_turn` ·
`automation.pre_turn_timeout` · `automation.pre_turn_required` ·
`automation.post_turn` · `automation.post_turn_timeout` ·
`automation.accept_check` · `automation.accept_check_timeout` · `checks.post_turn` ·
`checks.post_turn_timeout` · `session.verbose` · `session.debug` ·
`session.auto_commit_instructions` · `git.default_branch_prefix` ·
`git.lfs_check` · `output.shortid_length` · `agent.agent_id` ·
`agent.by_type` · `agent.watchdog_output_timeout_ms` · `agent.wind_down_timeout_ms` ·
`agent.graceful_exit_timeout_ms` · `agent.effort` · `agent.low_high_loop` ·
`agent.low_high_loop_draft_effort` · `agent.low_high_loop_review_effort` ·
`builder.effort` · `chattiness.default` · `chattiness.builder` ·
`chattiness.agent` · `permissions.protected` · `protection.enabled` ·
`protection.protected_branches` · `protection.protected_tasks` ·
`protection.gate_default_branch` ·
`serve.ports` · `serve.services` · `serve.start_services_cmd` ·
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
