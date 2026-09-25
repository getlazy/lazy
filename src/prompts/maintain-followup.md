Your work on this task did not touch {{count}} maintained file group(s) that this project expects to be kept up to date:

{{entries}}

This check runs over your task's whole branch, so it covers work your accepted
children wrote, not only your own changes: bring the docs up to date for
everything on this branch, including work your children wrote — you have their
reports.

For each group, do ONE of the following now:
- If your work affects those files, make the update (and commit it), OR
- If no update is genuinely needed, call
  `lazy_justify_maintain(group="<title>", reason="<why skipped>")` with one short
  reason per group (e.g. "intra-release change, no CHANGELOG entry needed").

Do not rely on prose alone for skip reasons — the structured call is what the
reviewer sees. Then hand back control.
