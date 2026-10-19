# lazy daemon resume-queue

This page is generated from `lazy daemon resume-queue --help`.

```text
Usage: lazy daemon resume-queue

Read-only: show the slow-lane auto-resume queue — tasks whose fast-lane
circuit breaker tripped (repeated crashes) and are now waiting for a
round-robin retry.

For each queued task, prints: attempts used/max, last attempt time, next
eligible time, and whether the project-wide gap or the per-task retry
interval is what's currently holding it back.

Related config (lazy.toml [daemon]):
  auto_resume                   Turns the slow retry queue on or off
  auto_resume_interval_minutes  How often a given task is retried once queued
  auto_resume_gap_minutes       Minimum spacing between ANY two auto-resumes
  auto_resume_max_attempts      Slow-lane attempts before giving up for good

Examples:
  lazy daemon resume-queue      # Show the current slow-lane queue
```
