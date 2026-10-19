# lazy scratch

This page is generated from `lazy scratch --help`.

```text
Usage: lazy scratch <subcommand>

Read the builder scratch sandbox. Builders write artifacts — review messages,
analysis dumps, drafts — into $LAZY_SCRATCH_DIR, a plain directory outside the
repo. Lazy captures that directory into the PROJECT STORE, so the artifacts
outlive the host, travel with the project, and are readable by later builders.

Subcommands:
  list                     Show captured files, newest first (default)
  show <path>              Print one captured file's content
  sync                     Capture the live scratch dir now
  rm <path>                Drop a captured file from the store
  path                     Print the live scratch dir

Options:
  -y, --yes                (rm) Skip the confirmation prompt

Capture runs automatically on the builder supervisor's cadence and on exit, so
`sync` is only needed to capture immediately. It never deletes: removing a file
from the live dir leaves the captured copy in place — use `rm` for that.

Bounds: files over 1.0 MB, non-UTF-8 (binary) files, and anything past the
32 MB sandbox budget are recorded BY NAME ONLY, with a warning naming the
file. Content is stored whole or not at all — never silently truncated — and the
body always stays readable in the live scratch dir.

Search inside captured content with: lazy search 'in:scratch <text>'
Builders read the same files through the lazy_scratch MCP tool. Task agents
cannot: scratch is an exchange channel between the builder and the human.
```
