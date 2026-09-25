# Cluster tasks

A **cluster task** is a task whose agent drives *other* tasks instead of writing
code itself. You give it a set of subtasks; its agent — the **driver** — decides
which of them can run at the same time, starts them, reviews each one as it
comes back, sends it back with feedback or accepts it, and hands back when there
is nothing left it can usefully run.

It is the shape you want when you have a pile of related work that should land
in one branch and be reviewed as one change: everything a review turned up,
every follow-up from a release, every item on a checklist.

## Creating one

```bash
lazy create --type cluster --goal "Fix everything the API review found"
```

The type is available everywhere a type is: `lazy create --type cluster`,
`lazy edit <task> --type cluster`, the `type` field of the `lazy_create` MCP
tool, and the type dropdown on the dashboard's create form.

Give the cluster a prompt that says what the children are for. You can list the
work in the prompt and let the cluster create the subtasks itself, or create the
subtasks up front and let it find them.

Adding existing backlog tasks to a cluster is a reparent:

```bash
lazy reparent <task> --parent <cluster>
```

## What the driver does

Every turn a cluster takes, it runs under a contract lazy injects for you:

- Read the tree (`lazy list <cluster>`) to see what its children are and what
  state each one is in. The tree is the source of truth, not its memory of it —
  children can be added and removed while it works.
- **Decide what can run now, and start all of it.** The driver weighs whether
  two children touch the same files, whether one needs another's work first, and
  what each accept will cost the children still running, then starts everything
  that is safe to run at once. Nothing in lazy caps how many that is.
- Wait on all of the running children together and act on whichever finishes
  first.
- Read what that child came back with — its report and its raised items, not its
  diff. By default a child has already reviewed its own work inside its own
  session before it parked ([the review paradigm](review-paradigm.md)), so the
  work that reaches the driver has been read once and fixed once. A cluster of a
  dozen children would run out of context if it read every diff.
- Accept it, unless something serious is recorded. That is the instruction the
  driver has: accept is the default, and a round is a full agent turn spent on
  work nobody has shown is needed. "Serious" means a security or data-integrity
  problem, a capability lost, a stated goal not met, or a finding at critical or
  high severity — not a nit, and not polish. The driver writes the child's
  verdict in its journal first, so you can read afterwards how many rounds each
  child took and what went wrong. An accepted child's work merges into the
  cluster's branch, so the whole cluster lands as one change.
- The driver sets review settings ONCE on itself and every child follows: a
  child that says nothing inherits its parent task's mode, gate and auto-fix
  ([the review paradigm](review-paradigm.md)). A child that overrides one keeps
  inheriting the rest.
- The driver may **escalate one child to a separate review** when the stakes
  justify a cold second read — a security or data-integrity change, a migration,
  something it cannot judge from the report. It sets that child's review mode to
  `separate`, and then that child gets a reviewer of its own whose verdict gates
  the accept. It costs three to four times the wall-clock and the tokens, which
  is why it is per child and not how a cluster runs by default. A child whose
  separate review stalls — a decision only a person can make, findings the driver
  must weigh, the round cap, or a review that failed or never ran — is handed
  back to the driver with the findings, not parked on you. Whatever it decides,
  you see the outcome at the cluster's own review.
- Repeat until nothing is left to run.

### How many children run at once

That is the driver's call, and lazy does not second-guess it. There is no cap,
no queue and no setting.

Running children one at a time would avoid ever merging siblings' work, but
those merges are mostly trivial, and serialisation is slow enough to dominate
everything else. The judgement about when running children side by side is
safe lives with the agent that can actually see the work.

### How many rounds one child may have

A cluster runs unattended, so one child that keeps not-quite-passing review could
otherwise absorb any number of agent turns with nobody watching the spend.
`[cluster] max_child_fix_rounds` (default **3**) bounds it: after that many rounds
on the same child, lazy refuses the driver's next send-back and tells it to
accept the child, close it, or set it aside with a question for you.

The count is **per child**, so one stubborn child never eats another's budget,
and children running at the same time never interfere with each other's.

The bound is on the driver's own judgement, never on yours. **Unblocking that
child yourself is never refused**, and it starts a fresh budget — as does
starting the child again, accepting it, or reopening it. Set the key to `0` to
remove the bound entirely.

This key is one of the levers in
[the review paradigm](review-paradigm.md#when-tokens-are-still-the-constraint),
which explains what each one costs you when you turn it down.

### It keeps its own branch current

A cluster can sync itself: it merges its own branch on origin, then its parent,
into its branch. This matters on a long run. Work keeps landing on the parent
while the cluster runs, and without the sync every child would branch from the
base the parent had when the cluster began, so a fix that landed an hour ago
would never reach any of them. Children started after the sync branch from the
cluster's current state.

The driver is told to do this before starting a new wave rather than after every
accept, because a sync costs a merge for every child currently running.

The sync merges everything outstanding and stops at the first conflict, which
the driver resolves itself before carrying on — so a conflict costs one cycle,
not the cluster. A cluster is the only thing that can sync a running task, and it
can only do it to itself: see [surface asymmetries](surface-asymmetries.md).

### Children it cannot finish

Some tasks turn out to be impossible as written, or far bigger than the prompt
suggests. A driver is expected to recognise those, set them aside, and carry on
with the rest rather than grinding to a halt on the first hard one. A child it
sets aside is tagged `deferred-by-<cluster>`, so you can find them all:

```bash
lazy search 'tag:deferred-by-my-cluster'
```

When the cluster stops, it raises one **blocking** item per deferred child saying
what it needs from you. Blocking means accepting the cluster is refused until you
have answered them, so a cluster can never quietly hand back a pile of work it
never did.

## Watching it

`lazy show <cluster>` prints the cluster's progress: how many children have been
accepted out of how many are still expected to land, which are running, which
are deferred, and how many were closed. The same line is at the top of the
cluster's page on the dashboard, with each child linked, and the dashboard's
**Clusters** page lists every cluster with its progress and its children.
`lazy show <cluster> --json` carries the same numbers, under `cluster_progress`.
That key was called `loop_progress` before the type was renamed, and there is no
second spelling: a script that reads the old name finds nothing there, exactly as
it would for a task that is not a cluster.

In **Lazy Teams** the same line is on the cluster's own page, and the project nav
has a page listing every cluster with its progress and its children — including
which ones were set aside — so you can see what all of them are doing without
opening each one.

All of it is derived from the tree, so it is correct whether the driver accepted
a child or you did.

## Stopping and resuming

A cluster that has stopped is `blocked`, like any other task, and you resume it
the usual way:

```bash
lazy unblock <cluster>
```

With one exception: **if you add a child to a cluster that is parked after its
own turn, lazy starts it again by itself**, telling it which child arrived. That
is the only case in lazy where something other than you starts a turn on a local
event, and it is limited to cluster tasks — adding work to a cluster should not
need a second step to take effect.

Three things to know about it:

- **A cluster you stopped with `lazy stop` stays stopped**, until it next
  completes a turn — see below. Adding a child does not start it again: the
  arrival is written onto the cluster as a note instead, which it reads when you
  unblock it. (`lazy resume` deliberately carries no new context, so it does not
  hand over that note. The cluster re-reads its subtask tree either way, which is
  where the new child actually is, but `lazy unblock` is what puts the note in
  front of it.)
- Children the driver's own agent created never wake it. Otherwise a cluster that
  spawns its own subtasks would wake itself forever.
- Automatic restarts come out of the same budget as every other turn lazy starts
  on its own (`auto_react_max_retries` and `max_auto_turns` in
  [lazy.toml](lazy-toml.md)). Once that budget is spent the cluster simply stays
  blocked until you unblock it, which resets the counters.

**What ends a stop.** Any turn the cluster completes does — not only one you
meant as a restart. Unblocking it obviously does, but so does **asking it a
question with `lazy ask`, or running a review on it**: both run the agent, and a
completed turn clears the stop. From then on the cluster is an ordinary parked
cluster again, so the next child added to it starts a turn.

This matters if you are relying on a stop. A cluster you stopped, read, and then
handed more work to is no longer stopped — it will pick that work up. If you
need it to stay parked, leave it alone, or close the children you are not ready
for it to run.

### If a cluster's turn is killed

A cluster can be cut off mid-turn — you upgrade lazy, the daemon restarts, the
machine reboots, the agent crashes. That is not "stopped": nothing was handed
back to you and nothing was decided. Such a cluster is marked `interrupted` and
lazy starts it again for you, out of the same automatic-turn budget as above. It
picks up by re-reading its tree, which is where the state of every child lives,
so a child that finished while the cluster was down is simply there when it
looks.

You do not need to unblock a cluster in that state, and you should not see it
waiting for you.

## Cluster tasks and the `lazy loop` command

They are two answers to the same question, and you pick by who is doing the
reviewing. `lazy loop` drives a queue of tasks *with you at the keyboard*: it
starts each one, waits, and presents a review gate where you choose. A cluster
**task** is the unattended version — its agent makes those calls itself, and you
review the whole thing once at the end.

## What a cluster does not do

- It does not do its children's work. A child's changes reach the cluster's
  branch by being accepted, never by the driver re-implementing them.
- It does not schedule from a queue you configure — the driver decides what runs
  next, and how much of it, every cycle.
