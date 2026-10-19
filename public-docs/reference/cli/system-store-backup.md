# lazy system store-backup

This page is generated from `lazy system store-backup --help`.

```text
Usage: lazy system store-backup [--store <path>] [--writer-stopped] [--from <v>] [--to <v>] [--keep <n>] [--json]

Save a lazy store as one compressed archive (store.tar.gz) in <store>.backups/
beside it, verify it (the archive read back and every file compared by size and
sha256), and keep the newest verified ones. lazy does this by itself before a
new version first opens the store; run it by hand for an extra backup.

The store's lock is held for the whole backup, so with the project's daemon
running this fails — stop it first (lazy daemon stop).

Options:
  --store <path>     The store directory (default: this project's store)
  --writer-stopped   Do not take the lock: the caller has already stopped the
                     store's only writer (what Lazy Teams' host does)
  --from, --to <v>   Versions recorded in the backup's name (default: manual → this lazy)
  --keep <n>         Verified backups to keep (default: [storage] backup_keep, 5)
  --json             Machine-readable result
```
