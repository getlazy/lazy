Your turn is ending with {{count}} path(s) still uncommitted in the worktree:

{{paths}}

Nothing here is on the branch. Your task is reviewed and merged from its
commits, so anything left loose is dropped when the worktree goes — including
work you just did during this turn's end-of-turn checks.

Do ONE of these for every path above, now:

- **It is work that belongs to this task** — commit it with `lazy_commit`. One
  commit for all of it is fine.
- **It is not** — scratch output, a stray build artifact, an edit you decided
  against — delete it, or restore the file with `git checkout -- <path>`.

Then say in one line which paths you committed and which you discarded, and
hand back control. Do not start anything else, do not re-run tests, and do not
re-verify your work: this is the last step of the turn.
