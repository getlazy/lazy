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
no store yet doesn't either. If any verified backup exists and the store has
not changed since it was taken, lazy uses it instead of copying again, whichever
versions took it, so switching back and forth between versions does not recopy
the store. A backup interrupted midway cannot be resumed: the next start removes
the half-written copy, says so, and starts the backup again.

## While a backup runs

The backup is your way back to the version you came from. The daemon does not
answer until it finishes, and every surface says what is happening:

- `lazy upgrade` says up front how big the store is and roughly how long the
  backup takes, then shows its progress.
- `lazy daemon start`, `lazy daemon start --foreground` and any command that
  starts the daemon show how far the backup has got, for example
  `Backing up your store before lazy 0.94.1 opens it, so you can go back to 0.93.1 if you need to: copying: 1.20 GiB of 4.20 GiB (10 of 40 files), about 40 s left`. The time
  left covers the whole backup, including the check of the copy that follows it.
  When it is done they say `Backup saved: <path>` with the command that restores
  it, or `Store already backed up at <path>; nothing to copy.`
- `lazy daemon status`, and the project's status in Lazy Teams, report the
  daemon as starting and backing up the store, not as "not running".
- `lazy daemon stop` says a backup is running and leaves it running. Stopping it
  throws the backup away, and the next start begins it again, so it stops only
  with `lazy daemon stop --yes`.

The daemon runs in its own session: pressing Ctrl+C on the command that started
it, or closing the terminal, does not stop it mid-backup.

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

On a single-person install, set backup retention in the project root's
`lazy.toml`:

```toml
[storage]
backup_keep = 10
```

This keeps the newest ten verified backups for the project. Lazy Teams manages
backup retention for its projects and keeps five.

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

A restore never creates a symlink that points outside the store. If the backup
holds one (an absolute target, or one leading out of the store), the restore
leaves just that link out and names it. A backup containing a link that passes
through another link is refused instead (see below).

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

Backups retain the store's checkout ownership. If you restore into a different
checkout, explicitly [re-home the stopped store](store-ownership.md#moving-a-checkout)
before starting its daemon.

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

### A store that is a mount point

The restore moves the store's contents to folders next to it, which cannot
cross filesystems, so it refuses a store that is a mount point of its own and
changes nothing. Restore by hand instead, which gives the same result as a normal
restore: an exact copy of the backup, with the old contents kept. Do not just
unpack the backup over the store: that only overlays it, and files created after
the backup stay behind.

Stop the project's daemon first, then run these in the store (the mount point
itself stays in place; replace `<store>` and `<backup>`):

```bash
mkdir <store>/before-restore
find <store> -mindepth 1 -maxdepth 1 ! -name before-restore -exec mv {} <store>/before-restore/ \;
tar -xzf <backup>/store.tar.gz -C <store>
find <store> -path <store>/before-restore -prune -o -type l -exec ls -l {} +
```

The first two commands move everything out of the way into `before-restore`
inside the mount; nothing is deleted. The third unpacks the backup into the
now-empty store. The last lists the symbolic links the backup held.

Unlike a normal restore, `tar` creates every link as stored. Look at each link
listed and `rm` (deleting only the link) any that points outside the store: an
absolute target, one starting `../` past the store root, or one that goes
through another listed link. The restore would have left out the first two and
refused the backup for the third. When the restored store works, move
`before-restore` somewhere outside the store, or delete it once you no longer need
the old contents. Lazy does not read or complain about the extra folder, but the
next backup copies it too, so it makes every backup larger until it is gone.

If `tar` stops partway (disk full, damaged archive), the store holds a partial
restore, and nothing is lost: the old contents are whole in `before-restore`.
Stop there. Move the partly unpacked entries into a second new folder inside the
store (the same `find ... -exec mv` command, with the new folder as the
destination and both `before-restore` and the new folder excluded with
`! -name`), move the old entries back out of `before-restore`, and fix the cause
before trying again.

A backup taken by an earlier lazy is a plain `store/` folder rather than
`store.tar.gz`: replace the `tar` command with
`cp -R -p <backup>/store/. <store>/`. Archive backups were introduced in lazy
0.92; earlier versions made the plain copy. The commands use only options found
on Linux, macOS and BusyBox alike.

### A restore refuses a link in the backup

A restore refuses a backup in which a symbolic link passes through another
symbolic link: a link whose target goes through one, a link placed under one, or a
file placed under one. (Links
with an absolute target or one leading outside the store are not refused; they are
left out and named, as above.) The backup is still a plain archive. List it with
`tar -tzvf <backup>/store.tar.gz`, then extract it by hand into an empty
directory with `tar -xzf <backup>/store.tar.gz -C <empty-directory>`, and copy
what you need without following the links the restore refused.
