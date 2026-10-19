# lazy browse

This page is generated from `lazy browse --help`.

```text
Usage: lazy browse <task_id> [-i]

Browse a task's artifacts. Default mode opens a full-screen two-panel
browser of the task's artifacts (response, plan, diff, comments, commits).

Options:
  -i, --interactive   Hunk-by-hunk interactive review:
                        o  mark hunk reviewed, next
                        n  next hunk
                        p  previous hunk
                        s  split this hunk at a context line
                        a  ask the agent a question about this hunk
                            (resumes the agent's session, read-only)
                        f  leave feedback on this hunk (saved as a comment)
                        q  quit (prompts to submit feedback as unblock)

Full-screen mode navigation:
  Tab          Switch between left and right panels
  ↑/↓          Navigate items (left) or scroll (right)
  Enter        Select/expand item
  ←/→          Collapse/expand or switch panels
  t            Toggle task tree (if subtasks exist)
  q / Ctrl+C   Quit

Actions (use CLI after exiting browse):
  lazy unblock <task_id>                 Give feedback
  lazy accept <task_id>                  Accept the task
  lazy close <task_id>                   Close the task (no session needed)
  lazy reject <task_id>                  Reject the task (closes its PR, no comment posted)
  lazy sync <task_id>                    Merge upstream changes
  lazy review <task_id>                  Run an agent review of the work

Examples:
  lazy browse abc123          Full-screen browser
  lazy browse -i abc123       Hunk-by-hunk interactive review
```
