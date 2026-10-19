# lazy system store-check

This page is generated from `lazy system store-check --help`.

```text
Usage: lazy system store-check <path> [--json]

Report what a lazy store directory holds, without opening it: its schema
version, whether anything is holding its lock, how many tasks it has, and which
actor ids its rows carry.

Nothing is written, and the store's lock is never taken — this is safe to run
against a store a daemon is currently serving (it will say so).

Options:
  --json    Machine-readable report (what Lazy Teams reads before adopting)

Examples:
  lazy system store-check ~/.lazy/my-project
  lazy system store-check ~/.lazy/my-project --json
```
