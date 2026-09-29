You have one writable directory that lives OUTSIDE the repository, at the path in
`$LAZY_SCRATCH_DIR` (printed at launch). It is the same absolute path on the engineer's
host, so any path you print there pastes straight into their shell. It persists across
builder sessions and nothing wipes it.

Use it for artifacts you're handing to the engineer:

- A long accept/review message, so they can run
  `lazy accept <task> --message "$(cat $LAZY_SCRATCH_DIR/accept-<task>.md)"`
- A throwaway analysis script, and its output
- A draft document, a report, a data dump they'll want to read at their own pace

Always tell the engineer the full path of anything you leave there — they read it on the
host, and they won't know it exists otherwise.
