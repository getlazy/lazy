# Review regions

This page is for anyone reviewing a large task branch — on the command line,
in the web dashboard, in Lazy Teams, or as an agent — and explains how review
regions divide it up and how to sign them off.

A two-thousand-file branch is not reviewable as one thing. **Review regions**
cut it into units that each have their own diff, their own intent and their own
owner — so you can review one at a time, hand one to a colleague, or fan out
one agent per region.

A region is a **unit the work's own agent grouped**, not a cluster lazy guessed
at. The agent that did the work declares the groups when it hands the review
over — which files belong together and why — and lazy holds it to that: every
file in the change lands in exactly one group, and whatever the agent did not
name shows up in **Other changes** rather than vanishing.

```
lazy regions <task>
lazy regions <task> --region <id>
lazy diff <task> --region <id> --full
```

On the web, regions have their own **Regions** tab, sitting before Changes.
Pick a region there and the Changes tab scopes its diff and file list to it.

## What a region is

A region is one group out of the walkthrough the agent filed at the end of its
work — a `lazy_report` with a presentation. Each one reports:

- a **title** the agent wrote ("The retry path", "Docs pages")
- a **stable id** — the title, slugified: `the-retry-path`, `docs-pages`
- a **tier** — `core`, `tests`, `docs`, `generated` or `other`, so surfaces can
  put the behaviour change before the test files
- the **files it owns**, and nothing else's
- its **position in the walkthrough** — the first group the agent named comes
  first, and the review reads in that order

Leftovers form one last region, **Other changes**: files the agent never
assigned. It appears at the bottom of every listing and cannot be suppressed —
an unclaimed file is exactly the thing a reviewer most needs pointed at. It says
how many of the change's files the walkthrough did not name, so the size of what
was left out is on the row rather than something you count. If the agent
accounted for everything, there is no residual region at all.

A group can claim a **directory or a glob** as one entry — `src/review/`,
`test/e2e/regions*.test.ts` — and every changed file it matches belongs to that
region. This is what makes a several-hundred-file branch presentable: the test
mass is one line of the walkthrough, and the files that carry the change get
named individually. The matched files are resolved once, when the walkthrough is
filed, so a region's membership does not shift under a sign-off when later
commits land.

Lazy caps how big a walkthrough may be (512 file entries, 64 snippets and
prose paragraphs, 32 groups). If a walkthrough is refused for exceeding a cap,
the cap is recorded and **Other changes** says so in a line naming it — so a
walkthrough that was cut down to fit does not read as one that chose to leave
things out. A refusal never costs you the walkthrough already filed, and if no
smaller one is ever filed the regions say that too, naming the cap instead of
simply reporting no walkthrough.

The grouping is an **opinion, not an analysis**. It says nothing about how the
branch came to look like this; that is what the second source, below, is for.

## Regions are a partition

**Every file in the change belongs to exactly one region.** The regions' file
counts add up to the number of files in the change, so the list of regions is a
statement about how much work there is, and signing one off is a statement
about a known share of it.

That holds for the agent's groups and for the git carve alike: a file named by
two groups is refused at the source, naming both groups and the file, rather
than shown twice.

A group can also scope to **snippets** — particular line ranges of a file —
while another group claims the same file's other ranges. Whole-file claims are
the exclusive ones: two groups claiming the *same file whole* is the refusal,
but a snippet into another group's file is accepted and shown inside the group
that claimed it.

## Signing off a region

A reviewer can annotate a region:

```
lazy regions <task> --region <id> --name "The retry path"
lazy regions <task> --region <id> --owner ada
lazy regions <task> --region <id> --sign-off
lazy regions <task> --region <id> --unsign
```

An **owner** is a free-form name saying who the region is to review. It shows
on every surface and changes nothing else — there is no assignment workflow
behind it.

A sign-off is judged against **the region's own files**, not the branch tip:
lazy records a digest of the reviewed content, and the sign-off is shown as
**stale** the moment those files change again. A commit that touches a
*different* region's files leaves every existing sign-off standing — approval
disappearing because an unrelated group moved is exactly the false alarm a
per-region sign-off exists to prevent. Only a change to the signed-off group's
own share marks it stale, and the row says so: `signed off (STALE — region has
changed)`.

### Who set them

Where lazy knows who is asking — a review surface a person is signed in to —
every owner and every sign-off records **that person**, and every surface names
them: `signed off by Kim`, `owner ada (set by Kim)`. On a review divided
between several people, an approval with nobody's name on it reads as
"somebody checked this" and cannot be questioned.

The name comes from the identity making the call and can never be supplied as
an argument, so nobody can record an approval in somebody else's name. Naming a
region later does not disturb either name, and withdrawing a sign-off takes its
name with it.

On a single-machine install nobody is signed in, so there is no person to
record: an owner and a sign-off are stored and shown exactly as they always
were, with no name attached and none invented.

These annotations are keyed to the region's **id** — a slug of the group's
title, stable across reloads and across later pushes of the same walkthrough —
which is why they survive. Re-reading the walkthrough after the branch moves
does not rename the groups you already looked at; a region's identity is the
group the agent declared, never a position in a list.

Annotating a region is for the surfaces a person uses. On the command line that
is the three flags above; on **Lazy Teams** it is the Regions tab of a task,
where a reviewer assigns an owner, signs a unit or a whole area off, and can
withdraw a sign-off again — recorded in their own name, and marked stale by the
same rule when the region's own files change. A unit holds one sign-off rather
than one per person, so anybody on the team may withdraw one; Teams names whose
approval a withdrawal removes and asks you to confirm before it does. The
single-user web page shows a region's name and sign-off (and marks a stale one)
but has no control to set them. There is no MCP tool for any of it: see
[surface asymmetries](surface-asymmetries.md#25-review-regions-everyone-reads-them-only-people-annotate-them-and-which-source-answers).

## Where regions come from

**The agent's own walkthrough, first.** On a lazy project, the default source
is the presentation the agent declared when it finished: groups it named, in
the order it named them, each with the files it claimed. This is the reading
the agent reviewed its own work along, and the one the review opens with.

That source needs nothing but the report: no git walk, no history, no carve
cost. On the web the Regions tab and the card above Changes read it straight
away, and a task whose agent filed no walkthrough says so in a note rather than
erroring — the regions appear the first time the task parks for you.

**A task with subtasks is different, and asks the agent for nothing.** Its
regions are its accepted children, carved out of the merge history, plus a note
naming the children that can still land. "What is in, and what is still out" is
the question such a parent actually raises, and asking a model to walk a reviewer
through every feature in a release is asking for a walkthrough nobody can hold.
An agent that files one on such a parent anyway still wins — a declared walkthrough is
always the first source.

A subtask you **closed or rejected** does not make a task a parent of this kind, and is never
listed as outstanding. Spawning one exploratory subtask and closing it would
otherwise cost the parent its walkthrough permanently, and leave a note
promising work that can never arrive.

**Sign-off is refused on a derived map**, and says so. Those regions are units
of history rather than a set of files someone claimed, so there is nothing to
key an approval to: it could neither be checked later nor shown as current, and
recording it would mean your decision quietly reading as "never signed off" the
next time you looked. Sign off on the child task itself. Naming a region and
setting an owner work on a derived map exactly as they do on an authored one.

**Git provenance, on demand (agents only).** The second source ignores the walkthrough and
reads the branch's own history, carving the review range into the units that
are already there. It is the tool for three jobs: reviewing a task whose agent
filed no walkthrough, checking the agent's groups against what actually
happened, and carving a parent task that has long since been accepted. It is
reached through the `lazy_regions` MCP tool's `provenance` parameter (see
[For agents](#for-agents)); `lazy regions` on the command line and the web
pages always show the walkthrough, because that is what a review navigates by.

Provenance regions form **three levels**, from coarsest to finest:

| Level | Unit | What it needs |
|---|---|---|
| 1 | A merge or squash commit in the range | git alone |
| 2 | The task or pull request behind it, recursively — a parent task expands into its children | a merge commit, or a surviving branch |
| 3 | A **review chunk** — the turns between two review interventions | lazy's own task history |

Lazy recovers each unit's own commits in layers — its own accept tags first,
then a merge commit's second parent, then surviving branches, then commit
subjects, and the commit itself as the floor. It works on a project where none
of the work ever went through lazy: a fresh clone, no network, no tokens.

Two things are deliberately *not* carved into regions, because they are not
work the branch did:

- **Commits it inherited.** A branch cut from another long-lived branch carries
  that branch's history. Where lazy knows where your branch started, the
  carving begins there, so a branch stacked on another one shows its own work
  rather than everything its parent had accumulated.
- **Upstream sync merges.** Merging the main branch in to stay current brings a
  lot of files with it, none of them yours. Those merges are skipped rather
  than shown as enormous regions at the top of the review.

Both are stated in the listing's notes, with counts, so a reviewer can always
see what was left out and why.

Carved units are also grouped **by path area** — the first directory, or the
first two when the first is a source root (`src`, `lib`, `app`, `apps`,
`packages`, `test`, `tests`) — so `src/regions`, `test/unit`, `docs`, and
`(root)` for files at the top. On a large parent branch with hundreds of accepted
units, that is the axis the branch is actually split along, and it is
selectable anywhere a provenance region id is:

```
lazy_regions(task_id, provenance: true, region: "src/regions")
lazy_regions(task_id, provenance: true, region: "docs")
```

A unit whose every line was later rewritten owns nothing and is **superseded**;
it is not listed as a region, but asking for it by name tells you what became
of it rather than that it does not exist. Both of these live on the provenance
side only — the walkthrough read never carries them.

The carve is also what powers the **subtask-blame gutter** below: attribution
of individual lines to the unit that wrote them.

## Who wrote each line: the subtask-blame gutter

Open the **Changes** tab on a file several regions touched and each stretch of
changed lines is labelled with the subtask that wrote it — the way `git blame`
labels a commit.

Consecutive lines belonging to the same subtask are **one run**: a bracket
spanning them with a single label at its middle, linking to that subtask's
page. Hovering the label gives the subtask's goal. A run ends where the owning
subtask changes, or where the hunk does.

- **On by default** on a file several units touched — that is the file a carved
  review most needs help with.
- **Off by default** on a file only one unit touched: every changed line there
  is that unit's, so the header names it once instead of a column repeating it
  down the page.
- The **toggle in the file header** (`3 units`) switches the column on or off.
  Nothing is fetched either way; it is already on the page.

It is a reading aid and nothing else. Ownership, sign-off and the owner field
are all per **region** — lines do not have owners.

## Using regions

### On the command line

```
lazy regions <task>
```

lists the walkthrough's groups **in the order the agent declared**, residual
`other-changes` last, each with its size, its tier and its owner.

```
lazy regions <task> --region <id> --files
```

shows one region in detail — its files, with any shared ones annotated —
whatever regions are inside it if it has children, and its sign-off state.
`<id>` accepts a region's slug or a task code, not just the full id.

A listing of a task whose agent filed no walkthrough is not an error: it exits
with the note that the regions appear once a final turn declares them, and
exits 0.

```
lazy diff <task> --region <id> --full
```

scopes the diff to that region's **files** — the agent's declared groups.
On a file nobody else claimed, that is the region's work and nothing else; on
a file a snippet put into two groups, the diff shown is the whole branch's
changes to that file, because a hunk without the surrounding cumulative state
is a diff that does not apply. A scoped diff always tells you it is scoped, and
offers the way back.

`--depth <n>` and `--all` page deeper into the region tree — on a large parent
task the whole tree can be hundreds of rows, which is why it is not the
default. The
walkthrough read is one level: the groups are the story, and `--region` opens
one.

### On the web

**Regions is a tab of its own**, third in the strip — after Summary and Verify,
before Changes. That is the reading order for a large branch: what you were
asked to check, what units of work are in there, then the diff itself.
The tab lists the agent's groups in declared order, the residual group last.
Clicking one takes you to Changes with `?region=<id>` applied: the diff and the
file list scope to that group. Past the twelfth region the rest fold into
**Other regions** rather than disappearing.

The **Changes** tab itself carries a small card above the diff — how many
regions the walkthrough declares, the largest few by name, and a way through to
the tab. When a region is selected the card says which one, and offers the way
back to all changes: a scoped diff always tells you it is scoped. On a task
whose agent has filed no walkthrough yet, the card says so, and says where the
regions will come from.

### In Lazy Teams

Teams has the same **Regions** tab, ahead of Changes, and the same rules: the
groups in declared order, the card above the diff naming the scope when one is
in force. Picking a group scopes Changes to it, and a group that is a task
links through to that task's own page.

Two things it adds. A region row carries a box for **whose it is to review** — a
name and nothing more, with no notification and no workflow behind it, which is
how a very large review gets divided between people. And on a file several
units worked on, the diff carries a **column naming which one wrote each stretch
of lines**, linked to that subtask; on a file one unit wrote, its name appears
once in the file's header instead, and either can be put away.

Because several people share a Teams page, it treats a change arriving
differently from the single-user web page. Regions and Changes are never
replaced while you are reading them — nor is any section while you are typing.
You are told the task has moved on and choose when to catch up.

Scoped links are meant to be sent to people, and groups are re-declared as a
task moves on — so a link can outlive the group it names. Following one shows
you the whole change with a line saying that group has gone, rather than an
empty diff.

### For agents

```
lazy_regions(task_id)                          # the walkthrough the task's final turn declared
lazy_regions(task_id, provenance: true)        # what git says — the carve, on demand
lazy_regions(task_id, region: "<id>")          # one region in full
lazy_regions(task_id, depth: "all")            # the whole provenance tree, if you really want it
lazy_diff(task_id, region: "<id>", full: true) # that region's diff — DECLARED groups only
```

The default listing is the presentation: rows in declared order with
`other-changes` last, each carrying `provenance: "presentation"` and `depth: 0`
(the groups are flat), paged with `offset` / `limit` and summarised with
`total` / `shown` / `truncated`. A named `region` returns it whole, with its
files and a `region_hash` you can compare later — that hash is what a sign-off
is judged against.

With `provenance: true` the tool reaches the carve instead. A first listing
may answer `computing: true` — the walk of a big branch takes seconds, and the
answer says so rather than blocking silently; a listing a moment later shows
the units. Naming a `region` never answers "computing": it waits for the real
carve, because "still computing" reads as "there is no region by that name".

`lazy_diff`'s `region` parameter resolves against the **declared groups** only,
and takes no provenance flag: scoping a diff is the walkthrough's privilege.
To read a carved unit or an area in full, use `lazy_regions` with
`provenance: true` — and scope the diff by the groups you went on to declare in
your own report.

This is what makes a very large branch reviewable by a team of agents: the
walkthrough is the map the implementing agent already made, list it once, then
give each reader one region — a bounded diff and a stated intent — and collect
the findings per region.

## What regions do not do

- They do not analyse your code. There is no dependency graph, no language
  support, and nothing to install — which is also why they work identically on
  a Go service, a Rails app and a Rust workspace.
- They do not assign reviewers, notify anyone, or estimate effort. The owner
  field is a label.
- They do not attribute lines a **removal** took out. A deleted line is not in
  the final version, so blame has nothing to say about it; the gutter labels
  the code you are reading.
- The walkthrough's groups are not a forensic record. An agent can group
  imperfectly — that is what the provenance carve (`lazy_regions` with
  `provenance: true`) is there to check against.

## When a region says something odd

The listing ends with notes rather than silence. On the walkthrough side: a
task with no declared presentation says when the regions will appear, and a
sign-off gone stale says what changed. On the provenance side: branches that no
longer exist and so stayed commit-level regions, caps that were hit, and
whether lazy's own task history was available at all. A coarser region list
with a reason beats a confident one that quietly lost half the provenance.

That holds when there are **no** regions too. If the review range itself could
not be resolved — an upstream branch that has been deleted, a worktree restored
without its remote-tracking refs — you are told that, on the web as well as on
the command line. "No regions, and here is why" and "this branch has no work to
carve" are different answers, and only one of them means you can stop looking.