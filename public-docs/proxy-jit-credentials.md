# Just-in-time credential injection

This page explains how lazy keeps your real model credentials out of every
agent process: **no agent ever holds your real Anthropic, Cursor, or OpenAI
credential.**

Lazy's proxy is always on and every agent's model traffic goes through it. That
makes one more thing possible: the credential can stay with the proxy. At launch
lazy hands the agent a **placeholder** — a per-task token minted by the daemon —
and the proxy swaps in the real credential in the last hop before the request
leaves the machine.

The property this buys: a task container's environment, its `docker run` argv,
its process listing, anything it writes to a log or a file, and anything a
prompt-injected agent can exfiltrate contain a placeholder that cannot authenticate to the provider. It is still a live token for this machine's proxy until the task ends, and is pinned to its container only where Docker allows (see below).

This covers every model call lazy makes, including the short-lived ones it makes
on its own behalf — see [Lifetime](#lifetime).

## The flow

```
launch                         request                        upstream
──────                         ───────                        ────────
daemon mints a placeholder
for (role, task, env var)
        │
        ├─► agent env: ANTHROPIC_API_KEY=sk-ant-api03-lazy-<random>
        │
        └─► registry: ~/.lazy/daemon/<slug>/proxy-tokens.json (0600)

                    agent ──── x-api-key: sk-ant-api03-lazy-… ──► proxy
                                                                    │
                                              look the value up in the registry
                                              → grant: role=agent, task=abc123
                                                                    │
                                              look up the credential for the
                                              target this request is going to
                                                                    │
                    proxy ──── Authorization: Bearer <your real token> ──► Anthropic
```

The placeholder goes into the **same environment variable** the real credential
would have used (`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN`, `CURSOR_API_KEY`), and mimics that credential's shape —
`sk-ant-oat01-lazy-…`, `sk-ant-api03-lazy-…`, `key_lazy_…`. Clients validate the
format of the key they are handed, and they choose their auth header from *which*
variable is set, so keeping both means the agent's request is byte-identical to
what it would otherwise have sent. The proxy's job is a substitution, not a
protocol change.

## Attribution comes from the token, not from the agent

The placeholder *is* the identity: the proxy resolves it to a grant and takes
role and task from there, rather than trusting anything the agent says about
itself. The self-reported `x-lazy-role` and `x-lazy-task-id` headers serve only
as a fallback for traffic with no grant (a host session on
its own login), and are ignored whenever a grant is present.

The grant carries the caller's **role**, which is also how the proxy decides
*where* to forward: role → configured upstream, resolved per request. Routing on
authenticated evidence rather than a self-reported header is the same argument
as attribution — an agent that could name its own role could pick its own
upstream. Traffic with no grant goes to the primary upstream.

## Per-target credentials are data

The proxy does not forward whatever the client presented. It looks up the
credential for the target it is **actually** calling, which matters on a
[`[[proxy.fallback]]`](./lazy-toml.md#smart-routing--proxyfallback-failover-chain)
reroute: the primary is Anthropic, but the fallback may be a local Ollama or
someone else's endpoint.

| Target's configured credential | What the proxy sends |
|---|---|
| `credential = "anthropic"` | your real Anthropic credential, in the form that target expects |
| `credential = "none"` | nothing — the presented credential is *stripped*, not passed along |
| resolvable but missing/expired | 401 if it is the primary; that hop is skipped if it is a fallback |

The map is keyed by **origin** (scheme + host + port), so two upstreams that
differ only in path are the same target as far as credentials go. A fallback
whose origin collides with an already-credentialed upstream while declaring
`credential = "none"` would silently inherit that credential, so lazy refuses
to start rather than run a credential map that does not mean what it says.

**Profile upstreams are targets too.** An [agent
profile](./lazy-toml.md#agentsname--named-agent-profiles)'s `endpoint` is the
upstream the proxy forwards that profile's launches to, so it enters the same
map under the same rules. A profile or endpoint you define must name
the credential that pays for it — `credential = "work-openai"`, or
`credential = "none"` for an unauthenticated local model server. Lazy refuses to
load a config where it does not. Naming credentials per profile is also how two
profiles on the same provider carry different keys. Only the built-in profiles,
which use a fixed endpoint of their own, fall back to a default credential for
that provider. Credentials are sent as the header form each target expects; the placeholder in the
container mimics the real key's shape (`sk-proj-lazy-…`, `sk-or-v1-lazy-…`) so
clients that validate key formats still launch. An origin collision with an
already-credentialed upstream is refused at startup rather than silently
inherited.

Profiles on a local Ollama stay launchable without an Anthropic credential:
their placeholder is minted over synthetic values, and the upstream receives no
credential. Hosted Ollama needs `lazy auth set ollama` (or `OLLAMA_API_KEY` in
the daemon's environment) and mints a placeholder over that key like any other
credential — the container still never holds the real value.

## What the proxy forwards

The proxy scopes **what** it forwards, not just where. It is a model-API proxy,
so only the model API rides through it. This covers everything sent to the
Anthropic upstream and to a profile upstream — that is, every request except the
Cursor passthrough described below:

| Request | Anthropic upstream | Profile upstream (e.g. Ollama) |
| --- | --- | --- |
| `POST /v1/messages` | forwarded | forwarded |
| `POST /v1/messages/count_tokens` | forwarded | forwarded |
| `HEAD`/`GET /api/hello` (reachability probe) | forwarded | forwarded |
| `GET /v1/models…` | forwarded | refused |
| anything else on these two upstreams | refused | refused |

A profile whose upstream speaks the **OpenAI wire** (the built-in `codex`
profile, or one you point at OpenRouter's OpenAI API) gets its own list, with no
overlap on the inference paths: `POST /v1/chat/completions`, `POST /v1/responses`
and the documented follow-ups on a stored response, `GET /v1/models…`, and the
reachability probe. The Anthropic paths are refused there and these are refused
on the Anthropic upstreams — a client pointed at the wrong wire gets lazy's
actionable 403 rather than an upstream 404 that reads as an outage.

A refused request comes back as a **403** with a `permission_error` body naming
the method and path that was refused and listing what that upstream does
forward. The request never reaches the upstream, and the refusal is written to
the audit trail — visible in `lazy stats audit` and live in `lazy watch` — with
the same grant-derived attribution as any other proxied request.

**The Cursor route is the one exception.** Requests under
`/_lazy/cursor/<placeholder>/…` ([see below](#cursor)) go to a third upstream,
Cursor's own API, and are forwarded verbatim — the table above does not apply to
them. Those requests are still audited.

Anthropic-wire profile upstreams are held tighter than the Anthropic one: only
inference and the reachability probe are forwarded, so a model server's
administrative endpoints (for Ollama, `/api/pull`, `/api/delete`, `/api/create`)
are never reachable through the proxy. The list is fixed in lazy and is not
configurable.

For failed Cursor requests, Watch and the proxy audit log show a credential-redacted upstream error message when the response is small enough to inspect. Large or streamed error bodies still reach Cursor unchanged; oversized bodies are identified without recording their contents.

## Usage-limit readings

Model APIs report how close a credential is to its limits in response headers:
a Claude subscription reports how much of its 5-hour and 7-day windows is used,
an Anthropic or OpenAI API key reports its remaining request and token budget,
and a refusal (HTTP 429) carries `retry-after`. The proxy records these headers
on every response it forwards, including streamed responses and refusals. It
records them in the audit trail, next to the credential they describe.

Only a fixed allowlist of header names is kept: `anthropic-ratelimit-*`,
`anthropic-priority-*`, `anthropic-fast-*`, `retry-after`, `x-ratelimit-*` and `x-codex-*`. Any other
header, including cookies and request or organization ids, is never recorded.
A value that looks like a credential is dropped even under an allowlisted name.
The credential itself is never written. Each reading is named by who owns the
credential (`user:<id>`), the variable it came from
(`credential:CLAUDE_CODE_OAUTH_TOKEN`), or, for traffic that brought its own
credential, the upstream (`upstream:https://api.anthropic.com`).

`lazy stats limits` shows the latest reading for each credential, with each
window as a percentage used, its status and when it resets. `--json` adds the
raw headers.

These readings are what [`[usage_pause]`](lazy-toml.md#usage_pause) acts on: set a
threshold and lazy stops starting turns on a credential whose subscription
window is that full, until the window resets. `lazy stats limits` marks a
paused credential `PAUSED`.

In Lazy Teams, a project admin can set the threshold under **Settings →
Configuration**:

```toml
[usage_pause]
threshold_percent = 95
```

Once a subscription window reaches 95%, new turns using that credential wait
until the window resets.

## Failure semantics

Every failure is loud, per lazy's no-silent-fallback rule.

- **Unknown or revoked placeholder** → `401` from the proxy with an
  `authentication_error` body naming the remedy (the task's grant is gone; start
  the task again). The request never reaches an upstream: a placeholder is not a
  credential anywhere else, and forwarding it would surface as *your* key being
  rejected.
- **No credential mapped for the target** → `401` naming the missing credential
  slot. There is no fallback to some other account's credential, ever — a turn
  either bills the acting user or fails.
- **Launch cannot mint a placeholder** → the launch fails; it does not fall back
  to the real credential.

Every 401 above is written to the audit trail as well as logged, so a revoked
task hammering the proxy leaves evidence in `lazy stats audit`, not just warn
lines. A refusal for an unknown placeholder is recorded with no role or task id
— the whole point is that lazy cannot vouch for who sent it.

They also show up live: because attribution here is derived from the grant
rather than a self-reported header, `lazy watch` can stream this proxy's
traffic per task (`net>` lines) and flag a credential refusal with its actual
cause — a container presenting a placeholder whose grant is gone.
The grant carries the task's code (or its short id when it has none), so
filtering proxy traffic by task accepts either form. A task code must match
exactly, because codes often share prefixes (`fix-login` vs `fix-login-2`) and
a filter that merged two tasks' traffic would be worse than one that found
none; prefix matching applies only to a hex short id, with a minimum length. A
filter that names no task at all (an empty string or list) is refused rather
than treated as "no filter".

- **A request with no credential at all** is forwarded unchanged with nothing
  added. Claude Code probes `HEAD /api/hello` before authenticating; 401-ing it
  would break startup. It still has to be a path the proxy forwards — the
  surface above is not scoped to credentialed callers.
- **A real credential presented by something with no grant** (a host
  `cursor-agent` login session) is forwarded as-is and recorded unattributed.
  Only a value that *looks* like a lazy placeholder yet fails lookup earns a 401.

## Lifetime

Grants live in `proxy-tokens.json` in the daemon's per-project state directory
(`~/.lazy/daemon/<slug>/`, mode 0600) — the same posture and location as the
daemon auth token and the MCP token registry, and deliberately **not** under the
project root, which every task container bind-mounts.

- Minting is **per identity and reuses**: the same (role, task, container,
  agent profile, env var) gets the same value back. A task's work container
  keeps one name across turns; its review and accept-check containers each get
  their own placeholder. A live container holds its placeholder in
  memory across turns, so re-minting per turn would either invalidate a running
  turn or pile up equally-valid placeholders. The profile is part of that
  identity because it decides which upstream the placeholder redeems against —
  switch a task to another profile and it gets a new placeholder.
- **Task grants are revoked** when the task's session ends (accept, reject,
  close) — alongside its MCP tokens, in the same place, and independently, so a
  failure in one does not skip the other. Every grant naming the task goes,
  whichever task reference it was minted under.
- **Task grants are pinned to their container.** On Linux with Docker, once a
  task's container is up its placeholders are bound to that container's network
  address, and the proxy refuses them from any other address (a `401` that is
  logged and audited). A placeholder that leaks out of one task's container
  cannot be spent from another's. Each turn's new container is pinned afresh.
  Grants are pinned only where the container's network gateway is an address
  of the host itself — native Docker. Docker Desktop (on any OS), rootless
  runtimes and a remote Docker host present every container from one other
  address, so there grants are not pinned.
- **Placeholders never reach the audit log.** Every placeholder shape lazy mints
  is replaced by `<lazy-placeholder>` in recorded tool commands, tool results and
  errors, because the log lives in the project, which task containers can read.
- **Builder grants are revoked** when the builder session's MCP token is revoked,
  keyed by the same session name.
- Interactive host launches (`lazy pair`, `lazy chat`) share one grant per
  project, because nothing signals when such a session ends. Builder-role grants
  are bounded by a cap with oldest-first eviction, and the grant just minted is
  never the one evicted.
- **Lazy's own model calls get a placeholder too.** The summary `lazy accept`
  writes, `lazy ask`, `lazy report` and memory compaction each run a single
  prompt in a throwaway container, and it is launched the same way an agent turn
  is. These run on the profile `[models.roles.agent]` names, so a call made about
  a task shares that task's grant when the task runs that same profile and gets
  its own otherwise — either way it is attributed to the task and revoked with
  it. One that is not about a task shares a single grant per project, because
  nothing signals when such a call's work is done.
- The registry survives a daemon restart. It is not in Storage: it is local
  machine state about local processes, the way the daemon's own token is.

## Cursor

`cursor-agent` sends its key in more than one place and its `-H` flag does not
cover every request, so the placeholder rides in the URL instead:
`/_lazy/cursor/<placeholder>/<upstream path>`. The proxy resolves that segment to
a grant, substitutes the real key wherever the CLI put it — header **or** request
body — and forwards the rest verbatim. Body substitution is bounded to requests
declaring `content-length` ≤ 64 KiB, so the bidirectional agent stream is never
buffered. The token in the path is never logged; a malformed route is reported by
segment count only.

`cursor-agent` trades its API key for a session (an access token and a refresh
token) before it starts work. That session is a real Cursor credential, so the
proxy never hands it to the container: it replaces both tokens in the answer
with placeholders bound to the launch's grant, and swaps them back on that
launch's later requests. The access token keeps its readable expiry, so the CLI
still renews on time. Session placeholders are revoked with the grant, one
presented by any other launch is refused with `401`, and if the launch's grant
is gone by the time the answer arrives the session is withheld (`502`) rather
than forwarded.

## Codex

The Codex CLI reads its key from `OPENAI_API_KEY` — where lazy puts the
launch's placeholder — and sends it as `Authorization: Bearer …` on every
request to its model provider. Lazy owns the provider configuration
(`~/.codex/config.toml` in the task's sandbox, rewritten before every turn), so
that provider is always the proxy's OpenAI-compatible route: the proxy
authenticates the bearer placeholder, attributes the traffic to the grant's
profile, role and task, and swaps in the real credential that profile bills —
the OpenAI key by default, or whichever name the profile's `credential` selects.
That is also what decides the upstream, so two codex profiles can reach two
different services with two different keys. No placeholder in the
URL is needed — unlike `cursor-agent`, the bearer header covers every request
the CLI makes. Containers always require a key; a codex launch that cannot
resolve the proxy address fails rather than dialing OpenAI unaudited.

**Exception — a host login session.** `cursor-agent login` produces a session
credential rather than an API key. There is no key to replace, so lazy routes
that traffic under `/_lazy/cursor/-/…`, forwards the session credential
untouched, and records the request unattributed. Containers always require an API
key, so a container always gets a placeholder; this case only arises on the host.

## OAuth token refresh

The placeholder is swapped per request, so a rotated real credential is picked
up on the next request with no relaunch.

## Scope

Every credential that goes through a launch path — agent turns and lazy's own
one-shot model calls alike — reaches `docker run` argv only as a placeholder. A
credential you export into a container yourself is out of scope here.
