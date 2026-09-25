Your turn is ending and this task is about to park for a human. Whether you
declared the work done or are handing it over part-finished, the person who
opens it next has to decide what to do with the branch, and the walkthrough is
what they decide from. Author the structured end-of-turn report for this task
now, in ONE `lazy_report` call, with BOTH halves:

**1. The report sections** — the structured report of record: what changed for a
user, how it was done, how to verify. This call REPLACES the report already on
record for this session wholesale (latest-wins per session), so a
presentation-only call would drop the sections an earlier invocation wrote.
Include every section your report should carry.

**2. The presentation** — `presentation.groups`: the walkthrough of this task's
whole diff (the task branch against its parent — the same range the reviewer is
about to be shown). Groups in the order that tells the story; each group one
thing a reviewer can hold, with a title and the items that belong to it (files,
snippets, prose). Tier each group (`core`, `tests`, `docs`, `generated`,
`other`) — tiers collapse, they do not sort. Use the lazy tools (`lazy_diff`,
`lazy_regions`) to see the task's diff while you decide the grouping.

Place every file of the task's diff in some group; whatever you leave out is
computed at render time and shown as unassigned ("not listed in the agent's
walkthrough") — you cannot suppress it. A change of one or two files may be a
single group. The requirement is about coverage, not ceremony.

**A file item can claim MANY files.** `{ kind: "file", file: "src/review/" }`
claims every changed file under that directory (the trailing slash is
required), and `{ kind: "file", file: "test/e2e/regions*.test.ts" }` every
changed file the glob matches — one item, one note, all of those files. That is
how a branch of hundreds of files is walked through: claim the masses by
directory or glob, and spend individual items on the files that carry the
change. A pattern that matches nothing you changed is an error naming it, and
two groups may not claim the same file — narrow one of the patterns, or let the
other group quote the file as a snippet instead. A plain path is always safe to
write as itself: a value that is exactly one of the files you changed is taken
literally, brackets and all (`app/blog/[slug]/page.tsx`).

This step does not complete until a presentation has been declared by this
`lazy_report` call. If you declared the work done and no declaration is found
after this invocation, the step fails, the turn fails, and the task parks —
send the report again to recover.

If the work is NOT finished, say so in the report and group what exists anyway.
A walkthrough of half a change is exactly what its reader needs; an empty one
is not.

**This step is not where you declare the work done.** Whether this turn ended
that way was decided by the turn itself and is already recorded; calling
`lazy_final` here changes nothing and will be dropped. Write the walkthrough
and stop.

## Where this branch's files came from (a hint — not a grouping to copy)

If a hint is listed below, it was carved mechanically from this branch's git
history, over the same range the reviewer is about to be shown. Read it as
PROVENANCE: which task, chunk or commit contributed the big masses of the
diff, and roughly where in the tree they landed. It is an orientation for
your grouping, never a grouping to copy — group by what moved in the system,
not by which task moved it, and re-split wherever the mechanical units cut
across your story. It may be empty (the carve is advisory and can fail); the
diff itself, through the lazy tools, remains the thing to group.

{{provenance_hint}}