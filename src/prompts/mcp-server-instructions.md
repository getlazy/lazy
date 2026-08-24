Lazy is a task orchestration system for software development. Tasks have goals, prompts, agent turns, commits, and comments. Tasks form a tree — a task can have subtasks, each running in its own git worktree on a dedicated branch.

You are connected to the lazy MCP server. Use these tools to understand prior work, surface design rationale, and record context — don't operate in a vacuum when relevant history exists.

Read-only tools (safe to call freely):

- `lazy_search` — Search tasks, prompts, turns, commits, comments, and follow-ups. Supports a Lucene-style query language with field filters (`status:`, `goal:`, `code:`, `in:turns`, `in:commits`, `in:comments`, `in:followups`, `in:conversations`, `in:memories`, `has:commits`, `has:followups`, `created:>YYYY-MM-DD`, etc.), boolean operators (`AND`, `OR`, `NOT`), and grouping. Plain text falls back to case-insensitive regex; pass `fuzzy=true` for typo-tolerant matching.
- `lazy_show` — Show a task's summary and counts; pass `sections` (e.g. `["turns", "commits", "comments"]`) to drill into specific sections with `offset`/`limit` paging.
- `lazy_list` — List tasks with optional status filter.
- `lazy_diff` — Show the diff for a task's branch.
- `lazy_status` — Check the current task and worktree status (no params).
- `lazy_memory_recall` — Read the project's shared memory: omit `name` for the index of all records, pass `name` for one record in full. Memory is curated cross-task knowledge (who the human is, guidance they gave, project constraints, external references) and its index is auto-injected into your prompt.
- `lazy_conversations` — List past builder conversations with timestamps and summaries.
- `lazy_conversation_search` — Search across past builder conversations by keyword.
- `lazy_conversation_read` — Read a full past builder conversation by `session_id`.

Write-capable tools (have side effects — use deliberately):

- `lazy_conversation_ask` — Ask a question about a past builder conversation (`session_id` + `question`) and get an answer back. A throwaway read-only agent reads the stored transcript; nothing is written back — the conversation is immutable history. Prefer it over `lazy_conversation_read` when you want a specific fact or decision, since reading a long conversation in full can overflow your context.

- `lazy_commit` — Stage and commit changes in the current task's worktree.
- `lazy_create` — Create a task. When called by an agent, the new task is always a subtask of your own current task (you cannot create top-level tasks or tasks under another parent). Use it to decompose your task's own work into executable parts — not for orthogonal/out-of-scope discoveries, which you should record with `lazy_add_followup` instead.
- `lazy_start` — Start a task. When called by an agent, you may only start your own subtasks.
- `lazy_unblock` / `lazy_accept` / `lazy_reject` / `lazy_close` — Iterate on and complete a task. When called by an agent, only your own task or a direct subtask is a valid target — except `lazy_accept`, which accepts a DIRECT SUBTASK ONLY (accepting your own task is the human's review decision, and is rejected). An accepted subtask merges into YOUR branch, so the work still faces review when your own task is accepted.
- `lazy_comment` — Add a comment to a task (defaults to the current task). Comments are *delivered to the agent* — they enter the next turn's prompt as guidance. Use this to instruct or steer the work.
- `lazy_journal` — Append a journal entry to a task (defaults to the current task). Journal entries are an append-only, prompt-immune side channel: they are NEVER injected into any agent prompt and never auto-delivered. Use this to *record* — design rationale and decisions ("chose K=3 because…"), things stubbed or deferred for later, orchestration metadata ("blocked on X landing"), and memories for future runs.
- `lazy_add_followup` — Record an orthogonal follow-up note on the current task. A passive note the human triages later; it creates no task and starts no work.
- `lazy_update_progress` — Post a short line saying what you are doing right now on the current task, so someone watching can see inside a long turn instead of a bare "working". Ephemeral and latest-wins: each call replaces the previous message, nothing is stored as task history, and the line is discarded when the turn ends. Call it sparingly, at phase boundaries ("reproducing the bug", "running migration 3/7") — never on every tool call, and never for findings or rationale (`lazy_journal` records those).

Memory is READ-ONLY for agents: `lazy_memory_save` is rejected server-side when called with a current task, because memory records are injected into every future builder and agent session. Do NOT use your harness's own memory feature either — that directory is per-sandbox and discarded when the task ends. If you learn something worth remembering across tasks, say so in your final summary; for task-local rationale use `lazy_journal`.

Agent scope: when these tools are called by an agent (i.e. with a current task), EVERY task-targeting tool — `lazy_show`, `lazy_diff`, `lazy_wait`, `lazy_unblock`, `lazy_accept`, `lazy_reject`, `lazy_close`, `lazy_create`, `lazy_start`, `lazy_edit`, `lazy_stop`, `lazy_submit`, `lazy_resume`, `lazy_ask`, `lazy_sync`, `lazy_reopen` — only acts on the agent's OWN task or its direct subtasks; any other target is rejected. `lazy_accept` is narrower still: direct subtasks only, never the agent's own task. `lazy_reparent`, `lazy_clone`, and `lazy_redo` are not available to agents at all (they would create or move a task outside the agent's subtree). The builder is unrestricted. `lazy_search` is the way to look up tasks anywhere in the tree.

When to reach for these:

- Before making a non-obvious design decision, search prior tasks for how similar choices were resolved — past human feedback is the strongest signal of what's valued.
- When a prompt references another task by code or name, look it up rather than guessing.
- When you identify a concrete, well-scoped chunk of THIS task's own work, run it as a subtask: `lazy_create` + `lazy_start`, then `lazy_wait` / `lazy_show` / `lazy_diff` to review and `lazy_accept` to land it.
- When you spot unrelated/out-of-scope improvements while working, record them with `lazy_add_followup` (and mention them in your final summary) instead of creating backlog tasks, leaving TODO comments, or trailing prose.
- Comment to instruct, journal to remember: if the text is guidance the agent should act on, comment it; if it's rationale/metadata/memory for the human or a future run, journal it (it stays out of the prompt).

Transport discipline (agents): these tools are your only sanctioned channel to lazy state. Never write that state another way — no raw HTTP against the daemon, no hand-editing files under `.lazy/`. `lazy_commit` in particular is the only way your work becomes a commit; `git commit` is refused in agent containers by design. If the tools disconnect or start failing mid-turn, stop and hand back: commit nothing by another route, leave your edits in the worktree (they persist), and state exactly what is left uncommitted. A lost channel is a reportable condition, not a puzzle to route around.

Memory caveat: task records and conversation summaries are frozen in time. For "what is the code now," prefer reading the current files; for "why was it done this way," prefer task/commit history.
