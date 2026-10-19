# lazy conversations

This page is generated from `lazy conversations --help`.

```text
Usage: lazy conversations <subcommand>

Browse Builders — the reasoning and decisions from past builder sessions,
stored automatically alongside task data. A Builder is one conversation from a
start or /clear to the next /clear: compaction and resume continue it, however
many Claude session files they roll through. The live run's state is shown as
a badge on the Builder it is in.

Subcommands:
  list                 List Builders (default; newest first)
  search <query>       Search message content (regex, case-insensitive)
  show <builder-id>    Read one Builder in full
  promote <builder-id> Turn a range of its messages into a backlog task

Options:
  -s, --search <query> (list) Run a search without a separate subcommand
      --limit <n>      (list) Page size (default: show all)
      --offset <n>     (list) Skip the first N Builders
      --limit <n>      (search) Max Builders to return (default 10)
      --from <n>       (promote) First message of the range (required)
      --to <n>         (promote) Last message of the range (default: --from)
      --goal <text>    (promote) Goal for the new task (default: seeded)
      --code <code>    (promote) Kebab-case code (default: derived from the goal)
      --parent <task>  (promote) Parent task id or code (default: top level)
      --yes            (promote) Take the seeded goal and prompt unedited

Builder ids are UUIDs; any unique prefix works (the listing shows the first 8).
A Claude session id of any of the Builder's segments works too.

`promote` seeds a BACKLOG task from the messages you name (`show` numbers them)
and opens your editor on the seeded prompt first. Nothing is started, and the new
task records which conversation and which messages it came from.

To import Claude Code history that predates lazy, use
`lazy import-conversation`. To start a new builder session,
`lazy builder`.

Examples:
  lazy conversations
  lazy conversations list --limit 20
  lazy conversations search "release hub"
  lazy conversations --search "design decision"
  lazy conversations show 3f9a01b2
  lazy conversations promote 3f9a01b2 --from 12 --to 18
  lazy search 'in:conversations "token usage"'

Documentation: https://docs.getlazy.dev/conversation-import
```
