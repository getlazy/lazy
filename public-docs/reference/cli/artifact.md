# lazy artifact

This page is generated from `lazy artifact --help`.

```text
Usage: lazy artifact <subcommand>

Attach files to a task, and retrieve files a task published back. An artifact is
a named file stored with the task — no smuggling file content through comments.

Subcommands:
  list <task>              List a task's artifacts
  add <task> <file...>     Attach one or more files (replaces by name)
  get <task> <name>        Print an artifact, or write it with -o
  rm <task> <name>         Detach one artifact

Options:
  -n, --name <name>        (add) Store under this name instead of the file's own
      --origin <origin>    (add) 'input' (default) or 'output'
  -o, --output <path>      (get) Write to this path instead of stdout

Delivery: a task's artifacts are written into its worktree at
`.lazy-task-sandbox/artifacts/` at the start of every turn, and the agent's prompt
carries their names and sizes — never their content. That directory is gitignored
and excluded from the task's diff, and it is rewritten each turn from the store,
so it is a mirror and not a workspace.

Attaching is PASSIVE: it never starts a turn, changes status, or triggers
auto-react. The agent sees new artifacts on its next turn — use `lazy unblock` to
make it act on them now.

Bounds: 1.00 MB per artifact, 8.00 MB and 64 artifacts per task.
Artifacts are inputs and outputs, not a blob store. One name, one artifact —
re-attaching a name replaces it; there is no versioning.

Agents attach their own outputs with the `lazy_artifact_add` MCP tool. There is
deliberately no MCP remove.

Examples:
  lazy artifact add my-task design/button.html design/tokens.json
  lazy artifact add my-task ~/Downloads/mock.png --name mocks/home.png
  lazy artifact list my-task
  lazy artifact get my-task design/button.html
  lazy artifact get my-task report.pdf -o ./report.pdf
  lazy artifact rm my-task mocks/home.png

Documentation: https://docs.getlazy.dev/artifacts
```
