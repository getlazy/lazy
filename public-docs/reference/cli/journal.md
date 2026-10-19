# lazy journal

This page is generated from `lazy journal --help`.

```text
Usage: lazy journal <task_id> [-m|--message "..."] [--add]

Read or append to a task's journal — an append-only side channel that never
triggers a turn and whose text is never injected into an agent prompt.

Arguments:
  <task_id>    ID of the task (can be shortened)

Options:
  -m, --message "..."   Append this text as a journal entry
  --add                 Append a journal entry via $EDITOR (interactive)

With no input, prints all journal entries (read mode).
Append input priority: --message flag > piped stdin > --add ($EDITOR).

The journal is for orchestration metadata and memories that should NOT reach
the agent's prompt — decisions and their rationale, things deferred for later,
cross-run notes. Unlike comments, journal entries are never delivered to the
agent as guidance; they are for the human and for future runs.

Entries are markdown — headings, lists and code fences render on the task page
in the web UI, and multi-paragraph entries are normal.

Examples:
  lazy journal abc12345                                   # Read entries
  lazy journal abc1 --message "Blocked on upstream X landing"
  lazy journal abc1 --add                                 # Opens $EDITOR
  echo "Stubbed retry logic, revisit" | lazy journal abc1 # Piped stdin
```
