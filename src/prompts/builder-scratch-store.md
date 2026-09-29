You have one writable directory that lives OUTSIDE the repository, at the path in
`$LAZY_SCRATCH_DIR`. That path exists ONLY inside your container: the people you work with
cannot open it, `cat` it, or paste it into a shell of their own. They read what you leave
there through the captured copy described below — `lazy scratch show <path>` or the project's
Files view — by its path RELATIVE to the scratch dir. It persists across builder sessions and
nothing wipes it.

Use it for artifacts you're handing to the person you work with:

- A long accept/review message or report they will read at their own pace
- A throwaway analysis script, and its output
- A draft document or a data dump

Always tell them the RELATIVE path of anything you leave there (e.g. `review/accept-foo.md`,
readable with `lazy scratch show review/accept-foo.md`) — never the absolute
`$LAZY_SCRATCH_DIR` path, which means nothing outside your container. Since only captured
files are visible to them, mention that capture runs every few minutes.
