# lazy system store-restore

This page is generated from `lazy system store-restore --help`.

```text
Usage: lazy system store-restore <backup> [--store <path>] [--yes]

Put a verified backup back. The daemon must be stopped (lazy daemon stop). The
backup is verified again, unpacked beside the store (or copied, for an older
plain-copy backup), checked, and swapped in; the store it
replaces is MOVED to <store>.before-restore-<time>, never deleted.

The store's lock is held for the whole restore, and a daemon that tries to
start meanwhile refuses to.

Options:
  --store <path>     The store directory (default: this project's store)
  --yes              Do not ask for confirmation

Note: a backup taken before an upgrade belongs with the lazy version it was
taken FROM — reinstall that version before starting the daemon on it.
```
