# lazy ask

This page is generated from `lazy ask --help`.

```text
Usage: lazy ask <id> [-m|--message "..."] [--no-wait] [--json] [--override-usage-pause]

Ask a question and print the answer. Read-only either way — an ask never changes code or the task's status.

<id> resolves the same way as 'lazy show': a TASK first, then a stored
CONVERSATION.

Asking a TASK (task id or code):
  While the task is paused for review ('blocked' or 'conflict') with a session
  that can still be resumed, this resumes the agent's own session, reflectively.
  It does NOT unblock the task, commit, or modify the worktree; the task's
  status is restored when the answer comes back.

  Otherwise — a finished task, an ended session, a removed worktree — the
  question is answered from what lazy STORED about the task: its turns, its
  raised items, its commits and its diff, read by a throwaway read-only agent.
  Nothing is written back and the task's status is untouched. The answer says
  where it came from, so it is never mistaken for the live agent's.

  Only a task that has never run has nothing to answer from.

Asking a CONVERSATION (session id or unique prefix, from 'lazy builder list'):
  A throwaway read-only agent reads the stored transcript and answers from it —
  "what did we decide about X in that session?". Nothing is written back; the
  conversation is immutable history. Works long after Claude Code's own
  retention has aged the session out of /resume, because lazy kept it. A
  transcript too large for one pass is read as consecutive excerpts and the
  answer composed from them; anything elided or unreadable is reported as a
  warning rather than silently dropped.

Arguments:
  <id>         Task ID or code, or conversation session ID (can be shortened)

Options:
  -m, --message "..."   The question. Required when stdin is not a terminal.
  --no-wait             Send the question and return; read the answer later with lazy show.
                        Ignored on the record route, which answers immediately.
  --json                Print the answer as JSON instead of text.
                        Task:         {type, taskId, fullTaskId, answer,
                                       sessionId, turnNumber, derivedFrom,
                                       provenance, usage, warnings}
                        Conversation: {type, conversationId, sessionId, answer,
                                       chunks, relevantChunks, usage, warnings}
                        Errors are printed as {"error": "..."} with exit 1.
  --override-usage-pause    Let this task's ask start even though its credential is past the
                        usage-pause threshold (used up by that one turn). Asking a
                        finished task or a conversation is not a turn of the task.

Input priority: --message flag > piped stdin > $EDITOR (TTY)

With no --message and nothing piped, $EDITOR opens for the question, so a
pasted stack trace or diff hunk keeps its line breaks. Lines starting with #
are ignored. The typed question is saved to .lazy/recovery/ before it is sent
and is only discarded once the agent has answered.

The answer is printed on stdout and progress on stderr, so the answer can be
redirected or piped on its own. An ask runs a real agent turn and can take a
minute or more.

Examples:
  lazy ask abc12345 -m "why did you drop the retry?"
  lazy ask abc1                                        # Opens $EDITOR for the question
  echo "what did you change in auth.ts?" | lazy ask abc1
  lazy ask abc1 -m "summarize your diff" --json | jq .answer
  lazy ask 4f8c2a1b -m "what did we decide about retention?"   # A stored conversation
  lazy builder list                                    # Find conversation session IDs
```
