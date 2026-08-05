<!-- SECTION: intro -->
This task is being accepted — its work is about to be merged. This is the FINAL turn before the merge, so make the whole task complete and correct, not just the last change. Work against the FULL diff of the task (everything since it started), not only your most recent turn.

Do the following, in order, then hand back control:
<!-- SECTION: commands -->
Run the acceptance checks

{{commands_list}}

If a command fails, fix the underlying problem and re-run it until it passes. Commit your fixes with `lazy_commit`. These exact commands are re-run after your turn as the merge gate — if any still fails, the merge is aborted and the task returns to blocked, so make them pass now.
<!-- SECTION: maintain -->
Bring maintained files up to date

{{maintain_list}}

Review these against the whole task diff and update anything that has gone stale. Commit any updates with `lazy_commit`.
<!-- SECTION: postmortem -->
Record a short post-mortem

Append a brief retrospective to the task journal with `lazy_journal`: what was hard, what you would do differently, and what surprised you. A few honest sentences — this is memory for future work, not a status report. Do NOT put it in a comment or in the code.
<!-- SECTION: outro -->
When everything above is done and committed, summarize what you validated and changed, then hand back control.
