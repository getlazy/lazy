# lazy messages

This page is generated from `lazy messages --help`.

```text
Usage: lazy messages <subcommand>

Your inbox of system messages — proactive reports lazy wrote for you: scheduled
analyses (post-mortems, tool-call patterns, token usage), daemon notices, and
other findings. Unread messages appear in the builder's launch context until
read or dismissed.

Subcommands:
  list                 Show the inbox (default; dismissed messages hidden)
  read <id>            Print one message in full and mark it read
  dismiss <id>         Hide a message from default surfaces (never deletes)
  dismiss --all        Dismiss every open message (asks first)
  dismiss --source <s> Dismiss every open message from source <s>
  dismiss --title <t>  Dismiss every open message whose title contains <t>
                       (--source and --title combine)

Options:
  -a, --all            (list) Include dismissed messages; (dismiss) every open one
  --source <s>         (dismiss) Match an exact source, e.g. machine-docker
  --title <text>       (dismiss) Match a title substring, case-insensitive
  -y, --yes            (dismiss) Skip the confirmation prompt

Ids are UUIDs; any unique prefix works (the listing shows the first 8 chars).

Not lazy's own diagnosis channel: lazy's configuration and health problems are
diagnosed by `lazy doctor`. System messages carry reports, and blockers in your
environment that an agent hit and could not fix; producers file them via the
`lazy_message_post` MCP tool (dismissal is human/builder-only).

Examples:
  lazy messages
  lazy messages read 3f9a01b2
  lazy messages dismiss 3f9a01b2
  lazy messages dismiss --source machine-docker
  lazy messages dismiss --all --yes
  lazy messages list --all

Documentation: https://docs.getlazy.dev/system-messages
```
