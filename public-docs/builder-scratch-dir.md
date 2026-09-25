# Builder scratch dir

A writable, host-accessible directory the builder can use for artifacts it wants
to hand to you — and nothing else.

```
~/.lazy/scratch/<project-slug>/
```

The builder sees the path in `$LAZY_SCRATCH_DIR`. You see it at the **same
absolute path** on the host.

## Why it exists

The repository is bind-mounted **read-only** into builder containers. That is
deliberate: the builder's job is prompts and review, not implementation, so it
must not be able to do work in the git tree.

The side effect was that the builder had nowhere to put anything. Yet artifacts
are genuinely useful:

- a long accept/review message you then pass through:
  `lazy accept <task> --message "$(cat ~/.lazy/scratch/<slug>/accept-<task>.md)"`
- a throwaway analysis script
- a draft document
- a data dump for you to read

The scratch dir is that place.

## The boundary: builder ↔ human, never builder ↔ agent

**This directory is a scratchpad for the builder and for data exchange with
you. It is not a channel to agents.** If the builder had a writable place task
agents could also see, the builder would start writing code there and telling
agents to copy it in — dissolving the builder/agent separation the whole system
depends on. An agent-visible scratch dir is worse than no scratch dir.

There is no builder→agent handoff area, and none is planned.

Two properties enforce this, structurally rather than by convention:

1. **It can never be committed.** It is not inside any git tree — not
   `.lazy/`, not the worktree, not the repo at all. There is no `.gitignore`
   entry to forget, edit, or override with `git add -f`.
2. **No agent can read it.** No agent launch path mounts it, and nothing is
   reachable in a container that is not mounted. A custom `[[mounts]]` entry
   in lazy.toml whose `source` is (or contains) the scratch base dir is
   refused with an error naming the entry — the same treatment lazy's daemon
   state directory gets, and for the same kind of reason.

## Container builder contract

| | container runner (`docker` / `podman`) |
|---|---|
| Availability | bind-mounted read-write at the identical host path |
| Path | `$LAZY_SCRATCH_DIR` |

The path is derived from the project root alone — no config key, no lazy.toml
setting — so every launch computes the same path.

The directory is created mode `0777` before every builder launch. A builder
*container* writes as the image's `user` account, whose uid need not match
yours; the bind mount carries host ownership through, so a `0700` dir would be
silently unwritable inside the container on any host where the uids differ.
Repair only ever widens the bits — if you set the sticky bit (`chmod 1777`) by
hand on a multi-user machine, lazy leaves it alone.

## It is captured into the project store

The directory on disk is the **working area**; lazy's storage holds the durable
copy. The builder supervisor captures the directory on its regular cadence and
again when the session ends, so artifacts outlive the host, travel with the
project, and are readable by later builders — not just by whoever was at that
machine.

```
lazy scratch list              # captured files, newest first
lazy scratch show <path>       # one file's content
lazy scratch sync              # capture now instead of waiting for a builder
lazy scratch rm <path>         # drop a captured file from the store
lazy scratch path              # the live directory, its entry count and size
lazy search 'in:scratch <text>'   # search inside captured content
```

Builders read the same files through the `lazy_scratch` MCP tool and search them
with `in:scratch`. **Task agents cannot** — both the tool and the search scope
are rejected for an agent caller, server-side, from its task identity. The
builder↔human boundary above is not weakened by making scratch searchable.

The web dashboard (and Lazy Teams) show the same captured files under
**Scratch**: grouped by the builder session that wrote them, with capture time,
markdown rendered (with a raw view), and a search box. A file recorded by name
only is labelled as such with its reason — over 1 MiB, binary, or over the
sandbox budget — rather than shown empty. A system message that names a
captured scratch path links to it. The web pages are read-only; removal stays
`lazy scratch rm`.

### What capture does and does not do

- **It never deletes.** Removing a file from the live directory leaves the
  captured copy in place — you may be reading it hours after the builder that
  wrote it exited. `lazy scratch rm <path>` is the explicit removal.
- **Nothing is silently truncated.** Content is stored whole or not at all.
  Three cases are recorded **by name only**, each with a warning naming the file
  and what to do about it: a file over **1 MiB**, a non-UTF-8 (binary) file, and
  anything past the **32 MiB** per-project sandbox budget. `lazy scratch list`
  shows those rows with the reason, and their bodies remain on disk.
- **The caps are not configurable.** They exist to keep the store bounded by
  construction; a knob would only let it grow without limit again.
- Dot-prefixed entries and symlinks are not captured (a symlink would otherwise
  pull repository or `$HOME` content into the store).

## Finding it

```
lazy scratch path      # the live path, item count and size
lazy system status     # names the path
lazy doctor            # names the path, item count and total size
```

The builder also prints the path at launch, and its system prompt tells it to
give you the full path whenever it leaves something there.

## Lifecycle

**Persistent, never auto-wiped.** You may read an artifact hours or days after
the builder session that wrote it has ended, so nothing in lazy prunes this
directory — not `lazy doctor`, not `lazy system status`, not a new builder
session.

Cleanup is yours, and it is two places — the live directory and the store:

```
rm -rf ~/.lazy/scratch/<project-slug>/*     # the live working area
lazy scratch rm <path>                      # the captured copy
```

Clearing only the directory leaves the captured copies readable (deliberately —
that is what "outlives the host" means). Clearing only the store means the next
capture puts the file back.

`lazy doctor` reports the size on every run and adds that hint once the
directory passes 100 MB.

## Overriding the location

`LAZY_SCRATCH_BASE_DIR` relocates the base directory for every project at once
— the same seam, and for the same reason, as `LAZY_DAEMON_BASE_DIR` for daemon
state. There is no lazy.toml key: as described under
[Container builder contract](#container-builder-contract), the path stays a pure
function of the project root, so every launch computes the same one.
