# The accept check

`lazy accept` refuses to merge a task whose own worktree does not build, and
names any protected files that were reverted during the task. This document
explains the defect both halves exist for, how to configure the check, what the
refusal looks like, and how to override it.

## The defect

A branch can reach accept in a state that does not build. A typical way: some
files the task changed get reverted to their base versions (older versions of
lazy did this for protected files a human rejected during review; nothing
reverts a protected file for you any more — approval happens once, at accept),
and the rest of the branch still depends on the reverted changes.

The agent usually notices at once — its next turn says the tree no longer
compiles. But nothing on the accept path reads a turn title, so the task can be
accepted anyway and break the target branch. A stale local build can hide it
from human review too: a generated or gitignored file left over in an old
checkout lets the branch build everywhere it is looked at and nowhere it is used.

Two separate gaps let that through:

1. **Nothing that says a task is broken was load-bearing on accept.** Turn
   titles, post-turn check output, an agent's own summary — all advisory.
2. **The revert was invisible in the diff.** A reverted file is simply absent
   from the diff, which reads identically to "the task never touched that file".

## Half one: the check

When `[automation] accept_check` is set, accept runs that command **against the
task's own worktree, inside a short-lived container**, before the merge. A non-zero exit refuses the accept.

```toml
[automation]
# Run in the TASK worktree at accept time. Non-zero exit refuses the merge.
accept_check = "bun run typecheck"
accept_check_timeout = 300   # seconds; a timeout is a refusal, not a pass
```

Notes on the shape, each deliberate:

- **It is the project's configured command, never one lazy guessed.** lazy does
  not know how your project builds. If `accept_check` is unset there is no gate,
  and accept says the step was skipped rather than inventing a command.
- **Run the command the way a human would** — `bun run typecheck`, `make check`,
  `npm run build`. Do **not** name a binary under `node_modules/.bin` directly:
  those are `#!/usr/bin/env node` shims, and in an environment without `node` on
  PATH they exit **127 before the compiler reads a single file**.
- **Exit 127 gets its own refusal**, worded "COULD NOT RUN", because a check
  whose interpreter is missing verified nothing. It still refuses — a gate that
  passes because nothing ran is the exact failure this exists to prevent.
- **A timeout is a refusal.** A check that never answered is not a pass.
- **In a container, never on the host.** The check runs in the same short-lived
  container `[automation.pre_accept]` uses, with no agent in it. See below.

### Where it runs, and why

The **command** is yours: it comes from the project root's `lazy.toml`, never
from the task branch's copy of it, so a task cannot edit or disable its own gate.
But what the command **resolves to** is not: `bun run typecheck` reads the
worktree's `package.json` scripts, `make check` reads its `Makefile`, `tsc` reads
its `tsconfig.json` and anything that extends. An agent that can commit to its
own branch can change what your check actually executes.

So lazy treats the check as code under the agent's control, and that code never
runs on the machine hosting lazy — on your own machine or on a shared Lazy Teams
host alike. Accept runs it in the same short-lived gate container
`[automation.pre_accept]` uses, built from the task's image, with no agent in it,
and removes the container afterwards. The check needs whatever tools it calls to
be in that image — the same image your agents already work in — and the
container runtime (Docker or Podman) must be available when you accept.

### What a refusal looks like

```
Task fix-parser does not build: its accept check failed (exit 2) in the task's
own worktree, so merging it into `main` would break `main`.

  command: bun run typecheck
  elapsed: 6.2s

--- stdout ---
src/parser.ts(41,7): error TS2551: Property 'tokens' does not exist on type 'Lexer'.

Fix it in the task and re-run the accept, or — if you know this tree is broken
and want it merged anyway — say so explicitly:

  lazy accept fix-parser --allow-broken
```

### The override

`lazy accept <task> --allow-broken` merges despite a failing check. The failure
is still printed, as a warning naming the exit code — the flag suppresses the
refusal, never the fact. There is deliberately no config key that turns the gate
into a silent pass, and `--allow-broken` is CLI-only (see
[surface-asymmetries.md](surface-asymmetries.md)): an agent may not decide on its
own that a broken tree should be merged.

Because it is CLI-only, the refusal is worded for the surface that receives it.
Over MCP the last paragraph reads *"There is no override on this surface:
`--allow-broken` is a CLI flag with no equivalent here, so merging a tree that
does not build takes a human at a terminal"* — the refusal states that the escape
hatch exists and is out of reach, rather than naming a flag the caller cannot
pass.

### Cost

One short-lived container per accept, running the command once, bounded by
`accept_check_timeout` — and nothing for a project that leaves `accept_check`
unset. On top of the command itself you pay for starting that container. Paid
once, at the moment a mistake would otherwise become the branch's problem.

## Half two: reverted protected files (historical records only)

Independently of the check — and with no configuration at all — accept names
protected files that were reverted during the task:

```
6 protected files were reverted during this task:
  - test/fixtures/schema.sql
  - test/helpers/setup.ts
  ...

Those changes are NOT in the diff you are reviewing — the tree being merged is
not the tree the agent last built against.
```

This is a report, not a gate: it never refuses. It exists because absence is not
visible, and the reviewer needs to know that the tree in front of them is not the
tree the agent last worked in.

Since protected-file approval moved to accept, **lazy itself never reverts a
file**, so this notice is empty for any task started after that change. It is
kept for tasks whose records still carry a revert from the old behaviour, and
for the one remaining way a protected file leaves the diff: the agent reverting
it itself, when asked to.

## Related

- [protected-branches.md](protected-branches.md) — protected files and branches
- [lazy-toml.md](lazy-toml.md) — the full configuration reference
