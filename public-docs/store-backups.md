# Store backups before every upgrade

Your lazy store holds every task, session, turn, comment, conversation and
memory. A new lazy version reads it and may rewrite it into a newer shape. So
before a new version first opens an existing store, lazy saves the store as a
compressed archive and checks it. If the backup cannot be made, the new version
does not open the store.

## When a backup is taken

- **`lazy upgrade`** takes one after it stops the old daemon and before it
  starts the new one.
- **A daemon starting on a different lazy version** than the project's last
  start takes one before it opens the store. This covers upgrades made any other
  way, such as installing a new binary and running any `lazy` command.
- **Lazy Teams** takes one on the host for every project, after the project's
  daemon stops and before the new lazy goes in. See
  [Self-hosting Lazy Teams](self-hosting-lazy-teams.md#automatic-store-backup-before-every-roll).

An ordinary restart on the same version takes no backup. A fresh project with
no store yet doesn't either. If a backup for the same upgrade already exists
and the store has not changed since it was taken, lazy uses it instead of
copying again.

## Where, and how many

Backups go in a folder **next to** the store, never inside it:

```
<store>.backups/<UTC time>-<from version>-to-<to version>/
    manifest.json   every file's path, size and sha256
    store.tar.gz    the store, as one compressed archive
```

The store is the `[storage] external_path` in `lazy.toml`, or
`~/.lazy/<project-name>` when that is empty. lazy keeps the newest five verified
backups. Set `[storage] backup_keep` to keep a different number.

Each backup is one gzip-compressed tar archive of the whole store. The store is
mostly text, so a backup usually takes a small fraction of the store's size.
lazy holds the store's lock while it writes the archive, so nothing writes to
the store meanwhile. Then it reads the finished archive back from disk and
compares it with the original: the number of files, the total size, and each
file's sha256. A backup that passes gets its final name. One that fails is
renamed `….failed`, with an `error.txt` saying why. Failed backups are kept
for you to look at and never count towards the five.

Before it starts, lazy checks there is room for the backup: about half the
store's size plus 64 MiB free next to it. If the archive still runs out of
room, the backup fails cleanly and leaves only its error record.

Backups taken by earlier lazy versions are a plain copy (a `store/` folder
instead of `store.tar.gz`). They are listed and restored exactly as before, and
are never converted or deleted except by the usual keep-the-newest-five rule.

A restore never creates a symlink that points outside the store. If the store
had one, the restore leaves just that link out and names it.

`lazy doctor` shows the last backup: when it was taken, the store's size and the
compressed size, and where it is.
`lazy system store-backups` lists all of them.

## When a backup fails

The upgrade stops and the store stays as it was:

- `lazy upgrade` stops. The old daemon has already been stopped, and the new one
  is not started.
- A daemon on a new version refuses to start.

Both say why and where the backups were going. The usual cause is a full disk,
or a folder lazy can't write to next to the store. Fix it and try again. To go
on **without** a backup, deliberately, run `lazy upgrade --skip-store-backup`,
or start the daemon once with `LAZY_SKIP_STORE_BACKUP=1 lazy daemon start`.

## Taking one by hand

```bash
lazy daemon stop
lazy system store-backup
lazy daemon start
```

The copy needs the store's lock, so stop the daemon first.

## Restoring a backup

1. Stop the daemon: `lazy daemon stop`.
2. Reinstall the lazy version the backup was taken **from** (the first version
   in its name). If you start a newer lazy on the restored store, it upgrades
   the store again.
3. Restore the backup:

   ```bash
   lazy system store-backups                 # find the backup's name
   lazy system store-restore <backup-name>
   ```

   lazy checks the backup again, copies it next to the store, and swaps it in.
   The store it replaces is **moved** to `<store>.before-restore-<time>`, never
   deleted. Delete that folder yourself once you are sure.

   The backup is unpacked next to the store before it is swapped in, so the
   restore needs free space for the full, uncompressed store there; it refuses
   up front, changing nothing, when there is not enough. If unpacking fails,
   the unpacked copy is removed again.

   The restore holds the store's lock from start to finish. If a `lazy`
   command tries to start the daemon while it runs, the daemon refuses. If the
   restore is interrupted while it swaps the backup in, the daemon keeps
   refusing and says where both halves are. Run the same restore again to
   finish it. If it is interrupted before the swap starts, the store was
   not touched: the daemon says so, and you either run the same restore again
   or remove the restore marker it names to keep the store as it is.
4. Start the daemon: `lazy daemon start`.

For a Lazy Teams project, add `--store <path>` with the project's store path on
the host (shown as "Store (external_path)" on the project's page in god mode).
Run the restore only while the project is stopped. If the project's daemon is
still holding the store, the restore refuses and asks you to stop the project
first; while the restore runs, the project's daemon refuses to start.

If an earlier restore was interrupted and you run it again, lazy keeps track of
where the interrupted one moved your original store, and names that folder when
it finishes. The store as it was before any restore is the first folder named.

While an interrupted restore is unfinished, no new backup is taken of the
half-restored store: finish the restore first. From inside a container, a lock
or restore held by a process in a neighbouring container is refused rather than
treated as stale, because that container's processes cannot be seen from here;
run the command where the lock was taken. (After a container is recreated, a
leftover lock from its earlier life is refused the same way from inside another
container; remove the lock file once the project is stopped.) On the host, a lock
left by a process that is gone from a container that is still running is
reclaimed automatically. A lock or restore taken on a Mac and seen from a Linux
container sharing its store, or the reverse, is refused rather than treated as
stale; once the other side is stopped, remove the lock file — the error prints
the exact command.

The restore moves the store's contents to folders next to it, so it refuses a
store that is a mount point of its own. In that case, stop the daemon and unpack
the backup into the store by hand (`tar -xzf <backup>/store.tar.gz -C <store>`),
or, for an older backup, copy its `store/` folder in.

### A restore refuses a link in the backup

A restore refuses a backup containing a symbolic link that could reach outside
the store: one with an absolute target, one whose target leads out of the
store, or one placed under or pointing through another link. The backup is
still a plain archive. List it first with `tar -tzvf <backup>/store.tar.gz`,
then extract it by hand into an empty directory with
`tar -xzf <backup>/store.tar.gz -C <empty-directory>`, and copy what you need
without following the links the restore refused.
