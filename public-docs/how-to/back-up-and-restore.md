# How to back up and restore your store

You need this to save your lazy store (tasks, sessions, turns, comments, memory) before something risky, or to put an earlier copy back. Lazy already backs the store up before every upgrade; this page covers doing it yourself.

### Dashboard

The dashboard cannot take or restore backups; use the commands above.

### CLI

Take a backup by hand. The daemon holds the store's lock, so stop it first:

```bash
lazy daemon stop
lazy system store-backup
lazy daemon start
```

List backups, newest first, with when each was taken, which upgrade it belongs to and its size:

```bash
lazy system store-backups
```

Restore one, with the daemon stopped:

```bash
lazy daemon stop
lazy system store-restore <backup-name>
lazy daemon start
```

The backup is verified again, unpacked beside the store and swapped in. The store it replaces is moved to `<store>.before-restore-<time>`, never deleted. Use `--yes` to skip the confirmation. A backup belongs with the lazy version it was taken from, so reinstall that version before starting the daemon on the restored store.

`store-backup` also takes `--keep <n>`; `store-backup`, `store-backups` and `store-restore` take `--store <path>` to name a store other than this project's.

The details, including what happens when a restore is interrupted, are in [Store backups before every upgrade](../store-backups.md).

### Lazy Teams

Teams backs up each project on the host before every upgrade. Restoring is done on the host with `lazy system store-restore <backup-name> --store <path>` while the project is stopped; see [Store backups](../store-backups.md#restoring-a-backup).

## Related

- [Store backups before every upgrade](../store-backups.md)
- [How to upgrade lazy](upgrade.md)
