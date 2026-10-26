# One store per project checkout

A task store belongs to one project checkout. Lazy checks its ownership before
starting a daemon, taking the storage lock, or processing tasks. Two clones of
the same repository need separate stores, even though they share git history.

If a clone's `lazy.toml` copies an absolute `[storage] external_path`, it can
point at the original project's store. Lazy refuses to open it and names both
checkouts. Give the clone its own `external_path` before starting it. Relative
paths resolve from the project root, so a checkout-local path such as
`.lazy/store` stays separate between clones.

Without an `external_path`, the default store is `~/.lazy/<project-name>`.
Projects with the same name, including unrelated folders with the same name,
can therefore select the same store. Give each checkout its own `external_path`
when lazy reports this collision.

Run `lazy doctor` from the affected checkout to see the ownership diagnosis.
Changing or deleting the storage lock does not transfer ownership.

## Moving a checkout

Stop the project's daemon before moving its directory. A rename or move on the
same filesystem keeps the directory's identity, so lazy recognizes it and
records the new path when it next opens the store. Symlinks to the same checkout
also work.

Fetching more history in a shallow clone does not change its store ownership.

For a move across filesystems, a restored checkout, or another intentional
transfer that lazy cannot recognize, stop the previous daemon first. Then run
this command **in the new checkout**, whose `lazy.toml` must name the intended
store:

```bash
lazy system store-rehome --from /absolute/path/to/previous/checkout --yes
```

The previous path must match the store's recorded owner. The command refuses
while a daemon holds the store lock. It changes only ownership; tasks, turns,
comments and conversations stay in the store. Omitting `--yes` asks for
confirmation.

## Upgrading an existing project

On first start after upgrading, lazy automatically records ownership of an
existing store when its saved daemon-owned builder sessions
identify the checkout you are opening. Every recorded project root must resolve
to that same checkout. No command or confirmation is needed, and saved tasks,
sessions, comments and conversations stay intact. A clone pointing at that store
is refused even if it starts before the original checkout.

Some stores have no usable checkout evidence: task sessions record branches and
commits, which clones share, rather than project paths. Empty builder histories,
conflicting project paths, and paths that no longer resolve cannot prove
ownership. After stopping the previous daemon, check that `[storage] external_path`
names the correct store. At a terminal, lazy asks once before opening any editor:

```text
This store at /path/to/store has no recorded owner. Claim it for /path/to/checkout? [y/N]
```

The default is **No**. Answering **Yes** explicitly claims the store for that
checkout and continues your command. Declining leaves the store untouched.
`lazy doctor` reports the same ownership problem and its remedy without asking
to claim it.

Without a terminal, including scripts and MCP, lazy refuses and prints the
command below. `--yes` suppresses the startup prompt and never claims a store
automatically. To claim it explicitly, run this **in the project's owning
checkout**:

```bash
lazy system store-rehome --from unowned --yes
```

A store holding only memories, conversations, messages or artifacts still
contains saved data and requires proof or this explicit claim. Empty stores
record their owner automatically.

## Lazy Teams

Teams assigns the store path independently of the repository's `lazy.toml`.
Normal restarts and machine recreation retain the fleet's project identity.
An existing fleet store receives its first ownership record from that explicit
assignment, without requiring a local ownership claim.

Adopting a store into Teams copies its data into a separate fleet store. The
copy receives the Teams project's ownership; the original keeps its owner.
There is no shared writable store between the local checkout and Teams.
