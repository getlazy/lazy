# The deleted-file resurrection guard

`lazy accept` refuses a merge that would silently put back a file the target
branch deliberately deleted, and names every such file. This document explains
the defect it prevents, how the detection works, and what to do when it fires.

## The defect

Git's 3-way merge decides what happened to a path by comparing both branches
against their **merge base**. If a file is:

- **present** on the source branch, and
- **absent** on the target branch, and
- **absent at the merge base**

then git sees "one side added a file, the other side did nothing" and adds it.
No conflict, no prompt, nothing in the merge output. If the target branch had
deleted that file on purpose, the deletion is quietly undone.

The third condition is the surprising one. A branch that merely *predates* a
deletion is safe: the file exists at its merge base, so git sees "the target
deleted it, the source did nothing" and correctly keeps it deleted. The defect
needs the file to be missing at the base entirely.

## How a base gets that stale

The shape that produces it in lazy is a **squash-accepted parent with a stacked
child** — for example, a long-lived parent task with a follow-up branched off it:

```
main ── … ── "Parent A" (squash of parent A) ── "delete src/sse.ts"
        \
         parent A ── (adds src/sse.ts) ── parent B ── … ── Merge origin/main
```

Accepting parent A squashes its work into a single commit on `main`. That commit
is *not* a descendant of the parent's own commits, so parent B — which was branched
off parent A before the squash — still has a merge base with `main` that predates
all of parent A's work. Every file born in that window has no version at the base.
When `main` later deletes one of them, parent B's routine `Merge origin/main`
brings it straight back — and because nothing conflicts, nobody notices.

## What the guard checks

Before any accept merges, lazy computes:

1. `git diff --diff-filter=A --name-only <target>...<source>` — files added
   relative to the **merge base** (three-dot);
2. `git diff --diff-filter=A --name-only <target> <source>` — files present on
   the source but not on the target tip (two-dot);
3. the intersection of the two — these are exactly the paths the merge would add
   one-sidedly;
4. for each, `git log --diff-filter=D <target> -- <path>` — did the target branch
   ever delete it? The newest such commit is reported.

Anything that survives step 4 is a resurrection. Paths the target never had, or
that it deleted and later re-added itself, are not flagged.

### Why not `git diff --diff-filter=D main...parent`

That command is the intuitive one and it does **not** work. A three-dot diff is
taken from the merge base, and in this topology the resurrected file has no
version at the merge base — so it appears in neither side of that diff. Run
against the topology above it returns nothing at all.

The related idea of checking that `merge-base(parent, main)` is recent enough also
fails, for a different reason: by accept time the parent has already merged `main`,
so its merge base *is* `main`'s tip. The staleness signal is gone precisely when
you would want to read it. The guard therefore asks the direct question — "would
this merge un-delete anything?" — instead of a proxy for it.

## When it fires

The accept is refused, nothing is merged, and the message names each file, the
commit that deleted it, and the command that resolves it:

```
Accepting task t1 would merge `lazy/parent-b` into `main` and RE-ADD 1 file
that `main` deliberately deleted:

  src/sse.ts
      deleted by 4f2a1c9e "Remove dead SSE module" (2026-04-12)

`lazy/parent-b` has no version of this file at its merge base with `main`, so
git sees the deletion as nothing to merge and takes the branch's copy wholesale —
no conflict, nothing to review. …

If it is dead on `main`, delete it on `lazy/parent-b` and re-run the accept.

If bringing it back is intentional, approve it explicitly:

  lazy accept t1 --approve-file src/sse.ts
```

Two ways forward:

- **The deletion was right** (the usual case): delete the files on the task
  branch too, commit, and accept again.
- **The re-addition is deliberate**: pass `--approve-file <path>` for each one
  (or `approved_files` over MCP). The accept proceeds and records a warning
  naming what was approved, so the audit trail shows a human made the call.

Every file must be approved individually — a partial approval still refuses, and
lists only what is still unapproved.

## Stacked children after an accept

When an accept squash-lands a task that has active children, lazy re-parents
those children automatically, but re-parenting only moves a pointer — it does not
touch their worktrees. Until each child runs `lazy sync`, its merge base is
behind the work that just landed, which is the stale-base condition above. Accept
says so, and both `lazy accept`'s pre-flight note and the post-accept warning
point at `lazy sync`.

Lazy does **not** sync those children for you. Merging into somebody else's
worktree as a side effect of an accept the human asked for on a different task is
a hidden side effect lazy avoids by design, and a conflict raised there
would strand a task nobody is watching. Upstream merge is `lazy sync`'s job. The
resurrection guard is the backstop for when the advice is ignored.

## Scope and limits

- **The guard is always on** and applies to every accept, not just long-lived parent tasks.
  The hazard is a property of merge topology, not of release semantics — any
  squash-accepted parent with a stacked child can produce it. It adds no config.
- **File granularity only.** A file that survives on the target but has *hunks*
  reverted inside it by the same mechanism is not detected. That defect class is
  real, but hunk-level detection has no clean
  signal to key off and would fire constantly on ordinary merges.
- **Deletions made only inside a merge commit** are not attributed to a deleting
  commit; `git log --diff-filter=D` does not report them by default. The file-level check itself still catches the
  re-add — only the "deleted by" attribution would be missing.
- **A very wide branch is capped.** If a merge adds more than 2000 files the
  guard checks the first 2000 and warns that it truncated, rather than silently
  reporting a clean result.

The check runs in the daemon's accept path, alongside the branch-protection edge
gate, so every driver and every caller (CLI, MCP, automation) is covered.
