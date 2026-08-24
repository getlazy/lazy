# Builder scratch dir

A writable, host-accessible directory the builder can use for artifacts it wants
to hand to you — and nothing else.

```
~/.lazy/scratch/<project-slug>/
```

The builder sees the path in `$LAZY_SCRATCH_DIR`. You see it at the **same
absolute path** on the host.

## Why it exists

The repository is bind-mounted **read-only** into builder containers, and the
host builder runs under an OS sandbox confined to the worktree. That is
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
2. **No agent can read it.**
   - **Container agents:** no agent launch path mounts it, and nothing is
     reachable in a container that is not mounted. A custom `[[mounts]]` entry
     in lazy.toml whose `source` is (or contains) the scratch base dir is
     refused with an error naming the entry — the same treatment lazy's daemon
     state directory gets, and for the same kind of reason.
   - **Host-process agents:** these share one filesystem with the builder, so
     the entire scratch **base** dir (`~/.lazy/scratch`, every project's) is
     added to the agent's `denyRead`/`denyWrite` lists — both the OS sandbox
     (which governs Bash) and `permissions.deny` (which governs the Read, Write
     and Edit tools).

     Caveat, stated plainly: this holds under `permission_mode = "sandbox"`, the
     default. Under `permission_mode = "bypass"` the host runner has no
     filesystem boundary of any kind — that is what the mode means, and the
     builder warns about it at launch.

Both properties are pinned by tests. `test/unit/builder-scratch-mount.test.ts`
asserts that every agent container argv is free of the scratch dir and that the
deny lists carry it; `test/e2e/builder-scratch.test.ts` asserts that git cannot
see it and that no agent worktree path is below it. Making the scratch dir
reachable by agents is a design reversal, not a test edit.

## Both builder runners, same contract

| | container runner (`docker` / `podman`) | host-process runner |
|---|---|---|
| Availability | bind-mounted read-write at the identical host path | already on the same filesystem; passed as a workspace dir via `--add-dir` |
| Path | `$LAZY_SCRATCH_DIR` | `$LAZY_SCRATCH_DIR` |
| Writable under the sandbox | n/a | yes, in both `sandbox` and `bypass` modes |

The path is derived from the project root alone — no config key, no lazy.toml
setting — so both runners compute the identical path and cannot drift apart. A
capability that exists only under one runner is worse than no capability,
because the builder cannot tell which one it has.

The directory is created mode `0777` before every builder launch. A builder
*container* writes as the image's `user` account, whose uid need not match
yours; the bind mount carries host ownership through, so a `0700` dir would be
silently unwritable inside the container on any host where the uids differ.
Repair only ever widens the bits — if you set the sticky bit (`chmod 1777`) by
hand on a multi-user machine, lazy leaves it alone.

## Finding it

```
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

Cleanup is yours:

```
rm -rf ~/.lazy/scratch/<project-slug>/*
```

`lazy doctor` reports the size on every run and adds that hint once the
directory passes 100 MB.

## Overriding the location

`LAZY_SCRATCH_BASE_DIR` relocates the base directory for every project at once
— the same seam, and for the same reason, as `LAZY_DAEMON_BASE_DIR` for daemon
state. The test harness sets it so a test run never touches your real scratch
dirs. There is no lazy.toml key: see "Both builder runners" above for why the
path must stay a pure function of the project root.
