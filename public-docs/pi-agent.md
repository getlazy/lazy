# Running tasks with the Pi coding agent

Lazy can run task agents on [Pi](https://pi.dev) (`pi`, the Pi coding agent
CLI) as an alternative to Claude Code. Pi is a first-class task agent: turns,
session resume across turns, `lazy ask`, merge-conflict turns, pairing, the
`lazy_*` tool set, and the audit proxy all work the same way they do for other
agents.

## Switching to Pi

```bash
lazy system agent           # readiness view: profiles, harness, upstream, auth
lazy system agent set pi    # project default
lazy create --agent pi "…"  # or per task
```

The built-in `pi` profile runs a local Ollama (see below), so this needs Ollama
running with that model pulled — no API key, and nothing hosted.

`pi` here is the name of the built-in [agent
profile](lazy-toml.md#agentsname--named-agent-profiles) whose harness is Pi.
Subtasks, clones, redo and rework inherit the profile of the task they came
from, exactly as with other agents.

## Upstreams and models

Pi itself can talk to many model providers. Under lazy, every byte of agent
traffic leaves through lazy's audit proxy, so where a Pi task's traffic goes is
decided by its profile's `endpoint`.

**Out of the box, Pi runs on your own machine.** The built-in `pi` profile
points at a local Ollama — `http://localhost:11434`, model `qwen3.8:latest` —
and spends no credential at all. Pi is lazy's local-model agent, so
`lazy create --agent pi "…"` does not quietly bill a hosted provider. You need
Ollama running with that model pulled:

```bash
ollama pull qwen3.8:latest
```

Everything else is a profile you declare:

- **A different Ollama, or a different local model** — the same shape as the
  built-in, with your address and model:

  ```toml
  [agents.remote-ollama-pi]
  harness = "pi"
  model = "qwen3:32b"
  endpoint = "http://ollama.lan:11434"
  ```

  Then `lazy create --agent remote-ollama-pi "…"`, or make it the project
  default with `lazy system agent set remote-ollama-pi`. Because the upstream
  is a property of the profile, one project can run some Pi tasks on one server
  and others somewhere else at the same time.

- **Anthropic** — available, but never the default, because it spends your
  Anthropic credential. Note the `endpoint` line: a profile that omits it
  inherits Pi's default (the local Ollama), so it is what keeps this one on
  Anthropic:

  ```toml
  [agents.anthropic-pi]
  harness = "pi"
  model = "claude-opus-5"
  endpoint = "https://api.anthropic.com"
  ```

- **OpenAI** — a profile pointed at `api.openai.com` runs Pi's OpenAI provider
  instead, over the OpenAI wire:

  ```toml
  [agents.openai-pi]
  harness = "pi"
  model = "gpt-5.2"
  endpoint = "https://api.openai.com"
  ```

  The key comes from `lazy auth set openai` (or `OPENAI_API_KEY` in the
  daemon's environment), and the turn is proxied and audited exactly like an
  Anthropic one.

- **OpenRouter** — a profile pointed at `openrouter.ai` runs the same OpenAI
  provider against OpenRouter, billed to `lazy auth set openrouter` (or
  `OPENROUTER_API_KEY`). OpenRouter's model ids are used as they are, slash
  and all:

  ```toml
  [agents.openrouter-pi]
  harness = "pi"
  model = "anthropic/claude-sonnet-4.5"
  endpoint = "https://openrouter.ai/api"
  ```

Those two wires are all Pi speaks under lazy, and the endpoint's hostname
decides which one a profile gets: `api.openai.com` and `openrouter.ai` put Pi
on the OpenAI wire, any other host on the Anthropic one. So a self-hosted
gateway, or any host lazy does not know by name, runs Pi's Anthropic-wire
provider — point such a profile at the upstream's Anthropic-compatible path. A
gateway that speaks only the OpenAI API is not reachable from Pi today. There
is no Pi-specific model syntax: models and upstreams are chosen through lazy's
normal configuration, never per prompt. On an Anthropic profile a model name
carrying a Pi provider prefix (`openai/gpt-4o`) is rejected, because it is not
an Anthropic model.

A profile with an explicit `endpoint` runs under a custom Pi provider, which
only offers the models it declares — so such a profile is required to set
`model`, and config load rejects it otherwise. A task-level model override still
works: lazy declares both the profile's model and the turn's own on every turn.

Lazy pins Pi's provider endpoints to the proxy on every turn (via Pi's own
`models.json` override mechanism, written into the task's sandbox home), so a
Pi task cannot dial a model provider directly.

**A Pi profile pointed at a hosted provider bills the same credential Claude
Code turns do**, including a Claude subscription token: lazy presents it to the
upstream in the full form that kind of credential requires, so such a Pi task is
not treated as some other kind of traffic. The default local profile bills
nothing — a local model server takes no key, and lazy does not send it one.

**If you already had a Pi profile that omitted `endpoint`, it moved with the
default.** A block like `[agents.my-pi] harness = "pi", model = "claude-opus-5"`
used to mean Anthropic and now means the local Ollama, which does not have that
model. Lazy warns at startup when a profile pairs a harness default upstream
with a recognizably Anthropic model, naming the profile and the
`endpoint = "https://api.anthropic.com"` line that puts it back. It warns rather
than refuses: only you can say which service you meant.

**If the model and the profile disagree, the turn stops instead of retrying.**
Giving a task a model its profile's upstream does not have — an Anthropic model
name on a profile pointed at Ollama, or a model you never pulled — gets a `404`
from that upstream. Lazy reports it as a configuration failure naming both
halves, and the traffic view (`lazy net`) carries a line saying which upstream
has no such model. The fix is either a model that upstream serves, or a profile
whose `endpoint` points at the server that has it.

**A slow local model is allowed to be slow.** A large model that is still
loading, queued behind other sessions on the same GPU, or prefilling a very
large prompt can take minutes before it emits its first byte, and lazy waits:
the proxy's ceiling is half an hour by default, and it keeps the connection to
the agent alive while the model thinks. If your upstream legitimately needs
longer, raise `[proxy] upstream_timeout` (seconds; `0` waits indefinitely). When
the proxy does give up it says so in those words — naming the upstream, the
ceiling that fired and the setting that changes it — rather than reporting a
network failure. Pi itself gets the same grace on the client side: lazy raises
Pi's own request idle timeout (five minutes by default) to sit above the proxy's
ceiling with an extra minute of headroom, so the client cannot give up before
the proxy does. Raising `[proxy] upstream_timeout` moves both together.

## Pi on a managed installation

On an installation that [manages configuration for you](managed-config.md) —
Lazy Teams is one — a repository is not allowed to choose an agent profile's
`endpoint`, because that endpoint receives the installation's model credential.
Every example on this page that sets `endpoint` is therefore something to keep
out of a managed project's `lazy.toml`: committing one does not just fail to
take effect, it stops the project loading at all, with `managed config refused`
naming the key.

That leaves the built-in `pi` profile and its local Ollama, so Pi runs there
only if whoever operates the installation runs an Ollama the project's daemon
can reach. If they do not, **creating** a Pi task is refused — not just starting
one — so you are told before you have a task that nothing will run, and the
message points at the operator rather than at your `lazy.toml`. Pick an agent
the installation does provide, or ask them for a model server.

The create-time refusal is deliberately narrow. It applies only where
configuration is managed for you, and only when the upstream actively refuses
the connection: if the probe is merely slow or cannot answer, the task is
created and the launch check remains the backstop, as it has always been. On
your own machine nothing is refused at create time at all — an Ollama you have
not started yet is a normal thing to create a task against.

## Thinking effort

A task's effort (`lazy create --effort high`, or `[agent] effort` in
lazy.toml) sets how hard a Pi turn thinks: lazy's `low`, `medium`, `high`,
`xhigh` and `max` are passed to Pi as its own thinking levels, and lazy declares
the model as reasoning-capable so the level actually applies rather than being
dropped.

What the top two levels do depends on the upstream, because Pi maps its levels
onto each provider's own controls: on an Anthropic-wire upstream (Anthropic, a
local or hosted Ollama, a gateway) `xhigh` and `max` arrive as themselves, while
on an OpenAI or OpenRouter profile — where the provider's scale stops one step
lower — a `max` task runs at `xhigh`. A model that cannot reason at all simply
answers without thinking; on a legacy OpenAI model that rejects the reasoning
parameter outright, the turn fails with that provider's error, and the fix is a
model that supports reasoning.

Lazy also raises the output-token ceiling it declares for Anthropic-wire Pi
profiles, because on that wire thinking is funded out of the same budget as the
answer — without the headroom, a high-effort turn can spend nearly all of it
thinking and get cut off mid-answer.

Pi turns run with its own startup network activity disabled (`PI_OFFLINE`,
`PI_SKIP_VERSION_CHECK`, `PI_TELEMETRY`): no update check, no model-catalog
refresh, no telemetry, so nothing leaves the task container outside lazy's
proxy. This is not an offline model: the turn's model traffic is unaffected and
goes to the profile's upstream through the proxy as usual.

## Credentials

Pi has no API key of its own. Its turns run on the same credentials lazy
already manages:

- Anthropic — `lazy auth set anthropic` (or the environment the daemon runs in),
- hosted Ollama — `lazy auth set ollama`; local Ollama needs no credential,
- OpenAI — `lazy auth set openai`; OpenRouter — `lazy auth set openrouter`
  (inferred from the profile's endpoint, or named by its `credential` key).

`lazy system agent set-key pi` is refused by design — there is nothing
pi-specific to store. As with every agent, the task container only ever holds
a per-launch placeholder; real credentials stay with the daemon and are
attached per request at the proxy.

## Lazy tools

Pi has no built-in MCP support. Lazy bridges its tool server into Pi with a
small Pi extension written into the task's sandbox home on every turn, so a Pi
task gets the full `lazy_*` tool set (read-only on `lazy ask` turns), with the
same per-task scoping as other agents.

## Read-only turns

Pi has no plan mode and no permission prompts. On `lazy ask` (and other
read-only turns) lazy disables Pi's write-capable built-in tools (`bash`,
`edit`, `write`) and the lazy tool server withholds its write tools, so the
agent can read code and task state but not change anything.

## Project trust

Pi can load extensions, skills, and system-prompt overrides from a `.pi/`
directory inside a repository. Lazy always launches Pi with that loading
disabled (`--no-approve`): a task branch is agent-writable, and a checked-in
`.pi/extensions/` must never execute on checkout. `AGENTS.md` context files
still load normally.

## Sessions and pairing

Pi sessions persist in the task's sandbox and resume across turns. When a turn
dies partway — a crash, a watchdog kill, a model error — the session id it was
using is kept, so the resumed turn (automatic or `lazy unblock`) continues that
same conversation with its history instead of re-sending the prompt from
scratch. `lazy pair`
on a Pi task launches Pi interactively inside the task container, resuming the
task's session with its history when it has one (otherwise a fresh session
starts, and pairing says which). When the session ends, every session file it
wrote is captured into lazy's conversation store — searchable with
`lazy search` — and the end-of-session AI summary is synthesized from that
transcript, the same as for Claude Code. This holds for any profile whose
harness is Pi, not only the built-in `pi` profile. See
[Pairing](pairing.md#pi-pairing) for the details.

## Container image

The default lazy runner image family gets Pi installed automatically when a
project's agent is `pi` (a `lazy-runner-pi` image is built from the default
Dockerfile plus Pi's install). Projects with a custom `Dockerfile.lazy` add
Pi's install line themselves — `lazy` prints it when the image is missing the
binary. The install is pinned to a specific Pi version that lazy's
integration was verified against.
