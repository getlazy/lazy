# lazy chat

This page is generated from `lazy chat --help`.

```text
Usage: lazy chat <task> [--effort <level>] [--override-usage-pause]

Interactive, read-only chat with a task's agent — ask it what it did and why.

The chat is "reflective": the agent reflects and answers, it does not act. No
edits, no commands, no commits, no task state changes are possible.

Works on any task whose agent has run at least once:

  Paused task (blocked/conflict)  Resumes the agent's live session in its
                                  worktree. The task is left exactly as it was
                                  — same status, untouched worktree. While the
                                  chat is open the task is held, so start,
                                  unblock and sync refuse until you exit.

  Finished task (accepted,        Rehydrates the session archived on close and
  rejected, closed, abandoned)    resumes it in the project root.

New turns from the chat are saved back so the conversation persists.

To ask a single question instead of holding a conversation, use 'lazy ask'.
To take over and actually change things, use 'lazy pair'.

Arguments:
  <task>    ID or code of the task to chat with

Options:
  --override-usage-pause Start this chat even when its credential is paused.
  --effort <level>  Claude Code reasoning effort (low, medium, high, xhigh, max).
                    Defaults to "medium" — a reflective chat is lightweight.
                    Dial up for a deep dig, or down to low.

Examples:
  lazy chat abc123                # Chat with the agent working on task abc123
  lazy chat my-feature            # Chat by task code
  lazy chat abc123 --effort high  # Dial up reasoning for a deep dig
```
