# lazy comment

This page is generated from `lazy comment --help`.

```text
Usage: lazy comment <task_id> [-m|--message "..."] [--edit <comment_id>]

Add a freeform comment/annotation to a task, or edit one the agent has not seen yet.

Arguments:
  <task_id>    ID of the task to annotate (can be shortened)

Options:
  -m, --message "..."   Provide comment text inline instead of opening editor
  --edit <comment_id>    Replace the text of an existing comment (id or prefix). Only
                        allowed while the agent has not been shown it; once delivered,
                        a comment is history the agent may have acted on, so add a
                        new comment with the correction instead. $EDITOR opens with
                        the current text.

Input priority: --message flag > piped stdin > $EDITOR (interactive)

A comment never starts a turn. It is delivered to the agent in the prompt of the
next lazy unblock, alongside your feedback. lazy ask and lazy sync do not carry
comments, and never consume them — they wait for the unblock.

Comments are human annotations for context that doesn't fit in turns or prompts:
- "Session was accepted but code was lost due to worktree corruption"
- "Superseded by task f8603ccb"
- "Agent struggled with X, try different approach next time"

Comments are markdown — headings, lists and code fences render on the task page
in the web UI, and multi-paragraph comments are normal.

Examples:
  lazy comment abc12345 --message "Superseded by task xyz"
  lazy comment abc1                                       # Opens $EDITOR
  echo "My comment" | lazy comment abc1                   # Piped stdin
  lazy comment abc1 --edit 3f2a -m "Corrected text"      # Edit an unseen comment
```
