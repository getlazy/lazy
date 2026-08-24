# Just-in-time credential injection

**No agent process ever holds your real Anthropic or Cursor credential.**

Lazy's proxy is always on and every agent's model traffic goes through it. That
makes one more thing possible: the credential can stay with the proxy. At launch
lazy hands the agent a **placeholder** — a per-task token minted by the daemon —
and the proxy swaps in the real credential in the last hop before the request
leaves the machine.

The property this buys: a task container's environment, its `docker run` argv,
its process listing, anything it writes to a log or a file, and anything a
prompt-injected agent can exfiltrate contain a placeholder that is worthless
anywhere except against this machine's proxy — and only until the task ends.

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

Before this, the proxy learned who was calling from `x-lazy-role` and
`x-lazy-task-id` headers that lazy set at launch — self-reported, and any value
the agent cared to send would have been believed. Now the placeholder *is* the
identity: the proxy resolves it to a grant and takes role and task from there.
The headers remain as a fallback for traffic with no grant (a host session on
its own login), and are ignored whenever a grant is present.

The grant carries the caller's **role**, which is also how the proxy decides
*where* to forward: role → configured upstream, resolved per request. Routing on
authenticated evidence rather than a self-reported header is the same argument
as attribution — an agent that could name its own role could pick its own
upstream. Traffic with no grant goes to the primary upstream, as before.

## Per-target credentials are data

The proxy does not forward whatever the client presented. It looks up the
credential for the target it is **actually** calling, which matters on a
[`[[proxy.fallback]]`](./lazy-toml.md#smart-routing--proxyfallback-failover-chain)
reroute: the primary is Anthropic, but the fallback may be a local Ollama or
someone else's endpoint.

| Target's configured credential | What the proxy sends |
|---|---|
| `credential = "anthropic"` | your real Anthropic credential, in the form that target expects |
| `credential = "none"` (default) | nothing — the presented credential is *stripped*, not passed along |
| resolvable but missing/expired | 401 if it is the primary; that hop is skipped if it is a fallback |

The map is keyed by **origin** (scheme + host + port), so two upstreams that
differ only in path are the same target as far as credentials go. A fallback
whose origin collides with an already-credentialed upstream while declaring
`credential = "none"` would silently inherit that credential, so lazy refuses
to start rather than run a credential map that does not mean what it says.

A target that needs no credential today (local Ollama) and one that will need
its own tomorrow (hosted Ollama) differ only in the data, not in the code path —
the credential is looked up per target, never inferred from the backend type.

**Role upstreams are targets too.** A role's `endpoint` under
[`[models.roles.*]`](./lazy-toml.md#modelsroles--per-role-model-targets) is the
upstream the proxy forwards that role to, so it enters the same map under the
same rules: an `ollama` role's upstream gets **none**, an Anthropic-native one
gets the real credential, and an origin collision with an already-credentialed
upstream is refused at startup rather than silently inherited.

This is also what makes an ollama role *launchable* without an Anthropic
credential at all. Its placeholder is minted over synthetic values rather than
the user's token — the grant exists so the proxy can authenticate the caller and
learn which role it is, not to carry a secret — and the ollama upstream then
receives no credential. An ollama-only project stays exempt from the daemon's
credential gate while being fully proxied.

## Failure semantics

Every failure is loud, per lazy's no-silent-fallback rule.

- **Unknown or revoked placeholder** → `401` from the proxy with an
  `authentication_error` body naming the remedy (the task's grant is gone; start
  the task again). The request never reaches an upstream: a placeholder is not a
  credential anywhere else, and forwarding it would surface as *your* key being
  rejected.
- **No credential mapped for the target** → `401` naming the missing credential
  slot. Per the per-user-token-billing mandate there is no fallback to some other
  account's credential, ever — a turn either bills the acting user or fails.
- **A caller of the `getAuthEnv` RPC that omits `proxied`** is rejected at the
  boundary. That parameter chooses between a placeholder and the human's real
  credential, so there is no safe default: a caller who forgot it would silently
  have received the real one and shipped it into a container.
- **Launch cannot mint a placeholder** → the launch fails; it does not fall back
  to the real credential.
Every 401 above is written to the audit trail as well as logged, so a revoked
task hammering the proxy leaves evidence in `lazy stats audit`, not just warn
lines. A refusal for an unknown placeholder is recorded with no role or task id
— the whole point is that lazy cannot vouch for who sent it.

They also show up live: because attribution here is derived from the grant
rather than a self-reported header, `lazy watch` can stream this proxy's
traffic per task (`net>` lines) and flag a credential refusal with its actual
cause — a container presenting a placeholder whose grant is gone. That is what
makes watch agent-agnostic; see the module header of `src/proxy/activity.ts`.

Note what the attribution IS: the grant carries the task **ref** the agent was
launched with — `taskRef(task)`, i.e. the task's code, or its short id when it
has none — not the full task id. Anything filtering proxy traffic by task must
accept every form the task answers to; matching a full id against a ref finds
nothing, which is exactly how `lazy watch` once printed its traffic header and
then stayed blank for a whole turn.

Accepting every form does NOT mean loose prefix matching in both directions: a
task's *code* must match exactly, because codes collide by prefix in practice
(`add-agent-to-unblock` vs `add-agent-to-unblock-clone-1`) and a filter that
merges two tasks' traffic is worse than one that finds none. Prefix matching
survives only for the hex-shaped short id an operator types, with a minimum
length. Relatedly, a filter parameter that names no task at all (an empty string
or list) is refused rather than treated as "no filter" — silently widening a
scoped request to every task's traffic is the opposite of what was asked for.

- **A request with no credential at all** is forwarded unchanged with nothing
  added. Claude Code probes `HEAD /api/hello` before authenticating; 401-ing it
  would break startup.
- **A real credential presented by something with no grant** (a host
  `cursor-agent` login session) is forwarded as-is and recorded unattributed.
  Only a value that *looks* like a lazy placeholder yet fails lookup earns a 401.

## Lifetime

Grants live in `proxy-tokens.json` in the daemon's per-project state directory
(`~/.lazy/daemon/<slug>/`, mode 0600) — the same posture and location as the
daemon auth token and the MCP token registry, and deliberately **not** under the
project root, which every task container bind-mounts.

- Minting is **per identity and reuses**: the same (role, task, env var) gets the
  same value back. A live container holds its placeholder in memory across turns,
  so re-minting per turn would either invalidate a running turn or pile up
  equally-valid placeholders.
- **Task grants are revoked** when the task's session ends (accept, reject,
  close) — alongside its MCP tokens, in the same place, and independently, so a
  failure in one does not skip the other.
- **Builder grants are revoked** when the builder session's MCP token is revoked,
  keyed by the same session name.
- Interactive host launches (`lazy pair`, `lazy chat`) share one grant per
  project, because nothing signals when such a session ends. Builder-role grants
  are bounded by a cap with oldest-first eviction, and the grant just minted is
  never the one evicted.
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

**Exception — a host login session.** `cursor-agent login` produces a session
credential rather than an API key. There is no key to replace, so lazy routes
that traffic under `/_lazy/cursor/-/…`, forwards the session credential
untouched, and records the request unattributed. Containers always require an API
key, so a container always gets a placeholder; this case only arises on the host.

## Verified: OAuth token refresh does not touch the proxy

The design raises an obvious question — if Claude Code holds an OAuth token, does
it perform a refresh flow, and would that refresh arrive at the proxy carrying a
placeholder that is not a refreshable token?

**It does not.** Checked empirically against roughly 8 MB of this project's own
live proxy audit records: every request to `ANTHROPIC_BASE_URL` is
`POST /v1/messages` (173), `HEAD /api/hello` (19), or
`POST /v1/messages/count_tokens` (8). No auth, token, or refresh endpoint appears
at all. Refresh flows target `console.anthropic.com`, which is a different host
and is not what `ANTHROPIC_BASE_URL` points at — and a token minted by
`claude setup-token` carries no refresh token to exchange in the first place.

Two consequences worth stating, in case this changes:

1. If Anthropic ever routes refresh through the messages base URL, the proxy
   would see it as an unrecognised path carrying a placeholder. The right handling
   then is to answer it from the proxy with the *real* credential's refresh
   result, not to forward the placeholder — the client must never be handed a
   real token in the response either.
2. Nothing here depends on the token being non-refreshable; the placeholder is
   swapped per request, so a rotated real credential is picked up on the next
   request with no relaunch.

## What this supersedes

`cursor-hardening-batch` item 8 — "real secrets in `docker run` argv" — is
resolved by this change for every credential that goes through a launch path:
the argv now carries a placeholder. Any credential that does *not* go through
these paths is out of scope here and still belongs to that task.
