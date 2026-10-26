# How to upgrade lazy

You need this after installing a newer lazy, or to pick up a newer agent inside your container image. `lazy upgrade` rebuilds the image and agent binary and restarts the daemon, and your tasks resume afterwards.

### Dashboard

The dashboard has no upgrade control; run `lazy upgrade`.

### CLI

```bash
lazy upgrade
```

Preview first with `--dry-run`. If tasks are mid-turn, `lazy upgrade` asks whether to stop and upgrade now, wait for them to finish, or cancel. To skip the question:

```bash
lazy upgrade --force     # stop everything, including working tasks
lazy upgrade --wait      # wait for working tasks to block, then upgrade
```

`--force` and `--wait` cannot be combined. Builder sessions are warned first, because a message you have typed but not sent cannot be kept; their conversation resumes on its own afterwards.

To refresh only the container image for future sessions without stopping anything or restarting the daemon:

```bash
lazy upgrade --images
```

The image is rebuilt under a temporary tag and moved into place only when the build succeeds, so cancelling leaves your current image as it was. Builds have no time limit unless you pass `--timeout <seconds>`.

Before the new daemon opens your store, `lazy upgrade` backs it up, so you can go back to the version you came from. It says up front how big the store is and roughly how long that takes, shows the progress, and ends with where the backup is and how to go back:

```
Backup saved: ~/.lazy/my-project.backups/20261024T101500123Z-0.93.1-to-0.94.1 (5210 files, 2.1 GiB, 41 s).
To go back to lazy 0.93.1: `lazy daemon stop`, then `lazy system store-restore 20261024T101500123Z-0.93.1-to-0.94.1`.
```

If the store has not changed since a verified backup, nothing is copied and it says `Store already backed up at <path>; nothing to copy.` A daemon started on a new version any other way (a new binary, then any `lazy` command) takes the same backup and says the same things. To go back, stop the daemon, restore the backup, then run the older lazy. If the backup fails the upgrade stops; `--skip-store-backup` goes on without one, deliberately. See [Store backups before every upgrade](../store-backups.md) and [How to back up and restore](back-up-and-restore.md). The full sequence is in [How `lazy upgrade` rebuilds the container image](../upgrade-image-rebuild.md).

### Lazy Teams

The Teams host takes a store backup for every project before it moves a project onto a new lazy; see [Store backups](../store-backups.md).

## Related

- [How `lazy upgrade` rebuilds the container image](../upgrade-image-rebuild.md)
- [Store backups before every upgrade](../store-backups.md)
- [Back up and restore](back-up-and-restore.md)
