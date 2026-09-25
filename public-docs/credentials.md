# Credentials

Lazy's daemon holds the model credential for a project. It launches every task
container, and those containers reach the model API through the daemon's proxy —
so if the daemon has no credential, nothing lazy runs can talk to a model. That
is why the daemon **refuses to start** without one.

A credential that lives only in an exported environment variable ties the
daemon's ability to start to the shell that started it. `lazy auth` removes
that dependency: store a credential once and the daemon reads it at startup,
from any shell.

## Quick start

```bash
claude setup-token | lazy auth set anthropic
lazy daemon restart
```

That is the whole setup. Nothing needs to be exported in your shell profile, and
nothing lands in a file you might commit.

## Commands

```
lazy auth list                 # what is stored, and what is actually in effect
lazy auth set <name>           # store or rotate a credential
lazy auth import <name> [path] # store a ChatGPT subscription session from `codex login`
lazy auth refresh <name>       # renew a self-refreshing credential (chatgpt) now
lazy auth rm <name>            # remove one
```

`lazy auth list` shows, per credential: whether this project requires it, what is
in effect right now (environment, store, or nothing), which backend the stored
credential lives in, and a last-four hint. It never prints a credential.

`<name>` can be a credential name — `anthropic`, `openai`, `chatgpt`, or one you
picked yourself — **or the name of an agent**. Naming an agent stores the
credential that agent bills, and says which one it used:

```
$ lazy auth import codex-subscription
The "codex-subscription" agent profile bills the "chatgpt" credential — using that.
Stored the ChatGPT subscription session from /Users/you/.codex/auth.json …
```

One exception, so nothing moves under you: if you already have a credential
stored under that exact name, it stays that credential. An entry you made is
never redirected somewhere else because an agent happens to share its spelling —
`lazy auth rm` still reaches it, and `lazy auth set` still rotates it in place.

The two vocabularies differ because a ChatGPT subscription is a service any agent
can be pointed at, not something that belongs to Codex. Either name gets you to
the same place.

```
anthropic  ● required by this project
  In effect:  store (keychain)
  Stored:     oauth …7f3a in keychain, updated 2026-08-29T09:14:02.118Z
```

### Storing a credential

`lazy auth set` reads the secret from a **masked prompt** or from **piped
stdin** — never from an argument:

```bash
lazy auth set anthropic                        # masked prompt
claude setup-token | lazy auth set anthropic   # piped
pass show anthropic | lazy auth set anthropic  # from your own password manager
```

There is deliberately no `lazy auth set anthropic <secret>` form. A secret on
the command line is written to your shell history and is visible in `ps` to
every user on the machine for as long as the command runs; there is no way to
make that safe, so the form does not exist. If you type one anyway, lazy refuses
outright, stores nothing, and tells you to rotate the credential — because by
then it is already exposed.

Use `--kind api-key` to store an API key rather than an OAuth token (the
default). The kind decides which environment variable the daemon presents it as.

### When a stored credential takes effect

Straight away, for everything except the Anthropic credential. Agents read their
credential through lazy's proxy, which resolves it from the store on every
request, so a key stored or rotated now is used by the next turn with nothing to
restart.

The Anthropic credential is the exception: the daemon loads it into its own
environment at startup, so a running daemon needs `lazy daemon restart` to pick
up a new one. `lazy auth` says which case you are in after every write.

Replacing a credential the daemon already had when it started is no different:
it takes effect on the next turn too. A variable *you* export still overrides
the store, but the daemon's own copy of a stored
credential never outranks the store it came from.

### Named credentials

A credential name does not have to be a provider. `anthropic`, `openai`,
`openrouter`, `ollama`, `cursor` and `chatgpt` are just the names lazy knows how
to infer; `lazy auth set <name>` stores **any** name (lowercase letters, digits, `.`, `_`
and `-`, up to 64 characters), and an
[agent profile](lazy-toml.md#agentsname--named-agent-profiles) picks one up with
`credential = "<name>"`:

```toml
[agents.work-codex]
harness = "codex"
model = "gpt-5-codex"
credential = "work-openai"    # lazy auth set work-openai
```

That is how two profiles on the same provider bill different accounts. Profiles
that do **not** name a credential share the one inferred from their endpoint, so
the common case stays a single key per provider.

A named credential has an environment form like every other:
`LAZY_CREDENTIAL_WORK_OPENAI` for an API key, `LAZY_CREDENTIAL_WORK_OPENAI_OAUTH`
for an OAuth token — the name uppercased with everything else turned into `_`.
The environment still wins over the store, so a CI job can export one without
lazy having to know the name in advance.

## Where credentials are stored

Per project, per credential name, in OS secure storage:

| Backend     | Where                                                     |
|-------------|-----------------------------------------------------------|
| `keychain`  | macOS Keychain                                            |
| `libsecret` | Linux secret-service (`secret-tool`, from `libsecret-tools`) |
| `file`      | `~/.lazy/daemon/<project-slug>/credentials.json`, mode 0600 |

`auto` (the default) picks the first one available. Pin one with
[`[credentials] backend`](lazy-toml.md#credentials).

**`file` is a fallback, and it is not encrypted.** It exists for headless hosts
and containers with no secret service at all. On such a host there is nowhere to
keep an encryption key better protected than the ciphertext next to it, so
encrypting the file would be obfuscation rather than security — 0600 and a
location outside the repository are the real protections. `lazy auth list` and
`lazy doctor` always name the backend in use, so you can tell which one you got.
If you asked for a specific backend and it is unavailable, `lazy auth set` fails
rather than quietly writing a plaintext file instead.

A long secret — a ChatGPT subscription session is a few kilobytes — is stored in
the macOS Keychain as more than one item: `chatgpt`, then `chatgpt#2`, and so on.
That is an implementation detail of the `security` command line, which cannot
carry more than 4 KB at a time; lazy joins the pieces back together on the way
out. If you are browsing Keychain Access, they belong together — remove them with
`lazy auth rm`, which clears all of them.

### If a stored credential goes bad

Store it again — that is the whole remedy, and you never have to clear anything
out of the keychain by hand first. Storing overwrites whatever was there, intact
or not, including leftovers from a write that failed partway.

```
codex login && lazy auth import codex-subscription
```

`lazy doctor` checks that a stored subscription session still reads back as a
valid session, so you find out before a task does. If it cannot be read, the
check names the command above. Tasks running on an unusable credential fail with
an authentication error that says the same thing, rather than leaving you to
work out what a parse error means.

Nothing is ever stored **in the project**: `lazy.toml` is committed, and every
task container mounts the repository read-only, so a credential inside the
repository would be readable by every agent on the project.

Alongside the secret, lazy keeps a small **non-secret index** recording which
credentials are stored, in which backend, and a last-four hint. That is
what the startup gate and `lazy auth list` read, so neither has to open a
keychain item — on macOS, opening one from a background daemon can block on an
unlock dialog nobody is there to answer.

A [Lazy Teams login](teams-login.md) is kept here too, and split the same way:
the token in the backend, and which install and project the clone is bound to in
the index. That is what lets `lazy login` with no arguments tell you where a
clone points without reading a secret to do it.

## Precedence: the environment always wins

```
environment variable  →  credential store  →  (nothing: refuse)
```

If `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` is set and non-blank, it is
used and the store is ignored. This is deliberate: an exported token keeps working
without any `lazy auth` setup, and exporting one
stays the way to try a different account for one session. `lazy auth list` tells
you when the environment is shadowing something you stored, so you never have to
discover it by debugging a 401.

A **blank** export (`export CLAUDE_CODE_OAUTH_TOKEN=` — the shape a failed
`$(claude setup-token)` leaves behind) counts as *absent*, not as a credential.

## Which credential does your project actually need?

The daemon works this out from your configuration rather than assuming
Anthropic. It resolves the agent profile each **role defaults to** — the builder
and new task agents — and requires the credential each of those profiles bills:

- Both role defaults on a local model server → **no credential needed**, and the
  daemon starts with an empty environment and an empty store.
- Either one on Anthropic → an Anthropic credential is required.
- Either one on hosted Ollama (`https://ollama.com`) → the `ollama` credential
  (`OLLAMA_API_KEY` or `lazy auth set ollama`).
- Either one on an OpenAI-compatible endpoint → the `openai` credential
  (`OPENAI_API_KEY`) — or the `openrouter` credential (`OPENROUTER_API_KEY`)
  when the endpoint is `openrouter.ai`. The same hostname rule applies to a
  profile pinned at OpenRouter's Anthropic-compatible endpoint: it bills your
  OpenRouter key, never your Anthropic one.
- Either one on the ChatGPT subscription backend
  (`https://chatgpt.com/backend-api/codex`) → the `chatgpt` credential. See
  [Running Codex on a ChatGPT subscription](#running-codex-on-a-chatgpt-subscription).

So a mixed setup — builder on Anthropic, new tasks on Ollama — still asks for
the one credential it will really use, and an all-local setup is never asked for
a token it would never present.

The gate reads the **role defaults**, not every profile the project declares.
Adding an `[agents.work-codex]` block is not a statement that anything runs it
today, so it never blocks daemon startup; a task that actually selects that
profile resolves its credential at launch and fails there, naming the profile. A
profile whose `credential` is a name of your own is in the same position: there
is no provider-level gate for one. Cursor is excluded for the same reason — a
Cursor key is resolved per launch and a missing one warns there, rather than
refusing a daemon for every task that is not a Cursor task. See
[`[agents.<name>]`](lazy-toml.md#agentsname--named-agent-profiles).

## When something is wrong

`lazy doctor` is the diagnosis surface. It prints one line per credential your
agent profiles bill — the role defaults plus every `[agents.<name>]` block, so a
declared profile whose credential is missing shows up here even though it never
blocks daemon startup — naming where the daemon found each one (its
environment, the store and its backend, or the agent key file) and which
profiles need it. A missing one is named, with the `lazy auth set` command that
stores it. And — because the startup check is presence-only and never calls the
API — doctor separately reports a credential that is present but *expired*, by
reading the proxy's record of recent 401/403 responses.

`lazy auth` itself never needs a credential to run, and never starts a daemon:
it is the command that fixes not having one.

### "The credential store says a credential is stored, but it could not be loaded"

The daemon refuses to start with this message when `lazy auth list` shows a
credential in the store but the store cannot hand the secret over. It does not
start anyway: a daemon with no usable credential answers RPC and launches
containers perfectly happily, and then fails every model request with an
authentication error that says nothing about the real cause.

Two things cause it:

- **The store is locked.** A login keychain or keyring that no one unlocked in
  this session — the usual answer over SSH, on a headless host, or for a daemon
  started outside a desktop login. Unlock it (`security unlock-keychain` on
  macOS, or start a keyring for the session on Linux) and start the daemon
  again. Nothing is lost.
- **The secret is gone but the record is not** — a keychain edited by hand, or a
  home directory restored without its keyring. Re-store it with
  `lazy auth set <provider>`, or drop the stale record with
  `lazy auth rm <provider>` and go back to an environment variable.

The refusal quotes the underlying error, so it tells you which of the two you
are looking at.

## Agent API keys

Some harnesses read a key out of their own config rather than being handed one
by the proxy. For those, `lazy system agent set-key <profile>` stores it per
project, against the profile's credential slot.

Cursor is one: `lazy system agent set-key cursor` (or any profile whose harness
is `cursor`). A key stored with `lazy auth set cursor` takes precedence over it,
and `CURSOR_API_KEY` still outranks both.

Codex works the same way: `lazy system agent set-key codex` stores an OpenAI
API key. A credential stored with `lazy auth set openai` takes precedence over
it, and `OPENAI_API_KEY` outranks both. A codex profile that names its own
credential (`credential = "work-openai"`) stores under that name instead.

## Running Codex on a ChatGPT subscription

Codex can be paid for two different ways, and they are two different
credentials: a metered **OpenAI API key**, billed per token at
`api.openai.com`; or your **ChatGPT Plus/Pro subscription**, which is included
in what you already pay and is usually far cheaper.

There are two built-in agents, named for what each one spends:

| Agent | Bills | Credential |
|---|---|---|
| `codex-api` | OpenAI API, per token | `openai` |
| `codex-subscription` | your ChatGPT Plus/Pro plan | `chatgpt` |

Same Codex CLI behind both. You can hold both credentials at once and choose per
task, and the agent name on a task says which one it spends — you never have to
work that out from which credential happens to be stored.

(`codex` still works and still means the API key; `codex-api` is the same thing
under a name that says so.)

**1. Log in on this machine**, with the Codex CLI's own flow:

```
codex login                 # opens a browser
codex login --device-auth   # headless: prints a code to enter on another device
```

**2. Import the session into lazy:**

```
lazy auth import codex-subscription   # or: lazy auth import chatgpt
```

Both spellings store the same thing — the second names the credential, the first
names the agent that bills it. What you cannot do is import a subscription into
the slot that holds an API key: `lazy auth import codex-api` (or `codex`) is
refused, because storing a session there would look fine and then fail upstream
hours later.

That reads `~/.codex/auth.json` — the file the login just wrote — validates it,
and stores it in the same OS secure storage as every other credential. Pass a
path if your session is somewhere else, or pipe the JSON in on stdin. A file in
the wrong mode (an API key rather than a subscription session) is refused here,
naming the command that does work.

**3. Run a task on it.** Nothing to configure:

```
lazy create --agent codex-subscription "…"
```

Or make it this project's default:

```
lazy system agent set codex-subscription
```

**Which one is in use.** The agent name on the task is the answer. `lazy auth
list` shows both credentials and which is stored; `lazy system agent status`
shows, per agent, the credential it bills and the kind stored for it (`oauth` is
the subscription, `api-key` is the metered key).

**Precedence** is the same rule as everywhere else, applied per credential:
the environment beats the store. `OPENAI_API_KEY` overrides a stored `openai`
key; `CHATGPT_AUTH` overrides a stored `chatgpt` session. The two never
compete with each other — which one a task uses is decided by the agent it runs,
not by which happens to be set.

The `CHATGPT_AUTH` override has one limitation worth knowing, and it is the
reason the store is the documented home. Renewing a ChatGPT token *replaces* it,
and lazy cannot write a replacement back into an environment variable — so a
session supplied that way is renewed only for as long as that daemon runs, and
the value in your variable stops working once it has been renewed. A stored
session has no such limit: the renewal is written back.

**Check the renewal works, once, straight after importing:**

```
lazy auth refresh chatgpt
```

That renews the session against the real service now, and prints the new
expiry — rather than leaving you to find out hours later, mid-turn, if something
about your session is not renewable. It is a check, not a repair: each renewal
retires the previous token, so there is no reason to run it on a schedule.

**lazy takes over the session, and your own `codex` may ask you to log in
again.** Renewing a ChatGPT token *replaces* it, and the copy the Codex CLI keeps
in `~/.codex/auth.json` is the one being replaced — so within a few hours of your
first subscription turn, running `codex` on this machine may send you through
`codex login` once more. That is expected, and logging in again does **not**
disturb lazy: it has its own copy in the credential store and keeps renewing
that. You do not need to re-import after a `codex login`, and re-importing every
time would just swap which copy goes stale first.

**Keeping it alive.** A ChatGPT access token expires within hours. lazy renews
it for you from the refresh token and stores the renewed session, so you should
not have to re-import. If the session is revoked, or sits unused long enough
to lapse, turns fail with a message saying so — run `codex login` and
`lazy auth import chatgpt` again.

Your session never enters a task container. The container is handed a
placeholder, exactly as for an API key, and lazy's proxy swaps in the real token
on the way upstream.

Claude Code and Pi have no key of their own: `set-key` is refused for them and
points you at `lazy auth set <credential>`, because lazy hands those harnesses
the profile's credential through the proxy — see [pi-agent.md](pi-agent.md). It
is also refused for a profile whose endpoint authenticates nobody
(`credential = "none"`, the default for a local model server): there is no key
to store.

## Human-only, by design

There is no MCP counterpart to `lazy auth`. Writing credentials is a human
decision; agents must never store, read, or rotate one. See
[surface asymmetries](surface-asymmetries.md).
