# lazy auth

This page is generated from `lazy auth --help`.

```text
Usage: lazy auth [list|set <name>|import <name> [path]|refresh <name>|rm <name>]

Store this project's model credentials in OS secure storage, so the daemon no
longer depends on the shell it was started from.

Subcommands:
  list (default)     Which credential is in effect for each name, where it came
                     from (environment or store), and which ones this project
                     actually uses.
  set <name>         Store a credential. Read from an interactive masked prompt
                     or piped stdin — never from an argument, which would land
                     in shell history and in `ps`. Add --kind <kind> to choose
                     between an OAuth token and an API key.
  import <name> [path]
                     Store a ChatGPT subscription session from the file
                     `codex login` wrote (default ~/.codex/auth.json), or from
                     piped stdin. The file is validated and re-serialized, so a
                     wrong or incomplete one is refused here rather than at the
                     first turn.
  refresh <name>     Renew a session lazy keeps alive (today: chatgpt) right now,
                     against the real service, instead of waiting for the token
                     to age out mid-turn. A renewal RETIRES the token it used, so
                     do not run it idly.
  rm <name>          Remove the stored credential (the environment is untouched).

Providers: anthropic, chatgpt, cursor, fireworks, ollama, openai, openrouter

A name can also be one you pick — `lazy auth set work-openai` — and reference
from a profile: [agents.work-codex] credential = "work-openai". That is how two
profiles on the same provider get billed to different keys; profiles that name
no credential share the provider's one.

Or name the AGENT PROFILE you are setting up and lazy stores the credential that
profile bills, saying which one it used: `lazy auth import codex-subscription`
stores the `chatgpt` session, `lazy auth set codex-api` stores the `openai`
key. The vocabularies differ because a ChatGPT subscription is a service any
harness can be pointed at, not a property of codex.

Storage backend: macOS Keychain, or libsecret / Secret Service on Linux. On a
host with neither, lazy falls back to a mode-0600 file in the daemon state
directory, outside the repository — `lazy auth list` always names the backend
actually in use. Choose explicitly with [credentials] backend in lazy.toml.

The environment always wins: an exported CLAUDE_CODE_OAUTH_TOKEN or
ANTHROPIC_API_KEY overrides the store, so existing setups keep working unchanged.

Examples:
  lazy auth                                    # what is in effect
  lazy auth set anthropic                      # masked prompt
  claude setup-token | lazy auth set anthropic # piped stdin
  lazy auth set anthropic --kind api-key
  lazy auth import chatgpt                     # from ~/.codex/auth.json after `codex login`
  lazy auth import codex-subscription          # same thing, named by agent profile
  lazy auth refresh chatgpt                    # prove the renewal works now
  lazy auth rm anthropic

Human/CLI-only — agents must never write credentials, so there is no MCP tool.
```
