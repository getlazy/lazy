# lazy system agent

This page is generated from `lazy system agent --help`.

```text
Usage: lazy system agent [status|set <agent>|set-key <agent>|clear-key <agent>]

See which agent PROFILES are ready and switch the project's default.

An agent is a profile — a harness, a model, an upstream and a credential. The
built-ins (claude-code, codex, cursor, pi) are joined by any [agents.<name>]
block in lazy.toml, and every <agent> below is one of those names.

Subcommands:
  status (default)      Readiness per profile: harness binary + version, model,
                        upstream (probed for reachability), credential, and
                        container capability. Marks the current default.
  set <agent>           Switch the project default ([agent] agent_id in
                        lazy.toml, comments preserved). Takes effect on the
                        next task launch — no daemon restart.
  set-key <agent>       Store the API key the profile's credential slot bills,
                        in the same store `lazy auth set` writes (OS keychain
                        where available, else a 0600 file in the per-project
                        daemon dir). Kept OUT of the project root: task
                        containers mount the repo read-only, so an in-repo key
                        is readable by every agent on the project. Reads the key
                        from an interactive masked prompt or piped stdin — never
                        from an argument, which would land in shell history.
                        Also picked up on the next launch. Human/CLI-only — no
                        MCP counterpart.
  clear-key <agent>     Remove that stored key.

Examples:
  lazy system agent                       # readiness view
  lazy system agent set cursor            # tasks default to the Cursor CLI
  lazy system agent set cheap-codex       # ... or to a profile this project configures
  lazy system agent set-key cursor        # prompt for the key (masked)
  lazy system agent set-key codex         # store an OpenAI API key for Codex tasks
  pass show cursor | lazy system agent set-key cursor   # piped stdin
```
