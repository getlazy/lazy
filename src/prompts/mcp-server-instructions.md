Lazy is a task orchestration system for software development. Tasks have goals, prompts, agent turns, commits, and comments. Each task runs in its own git worktree on a dedicated branch.

You are connected to the lazy MCP server. Use these tools to understand prior work, surface design rationale, and record context — don't operate in a vacuum when relevant history exists.

Read-only tools (safe to call freely):

- `lazy_search` — Search tasks, prompts, turns, commits, comments, and follow-ups. Supports a Lucene-style query language with field filters (`status:`, `goal:`, `code:`, `in:turns`, `in:commits`, `in:comments`, `in:followups`, `in:conversations`, `has:commits`, `has:followups`, `created:>YYYY-MM-DD`, etc.), boolean operators (`AND`, `OR`, `NOT`), and grouping. Plain text falls back to case-insensitive regex; pass `fuzzy=true` for typo-tolerant matching.
- `lazy_show` — Show a task's summary and counts; pass `sections` (e.g. `["turns", "commits", "comments"]`) to drill into specific sections with `offset`/`limit` paging.
- `lazy_list` — List tasks with optional status filter.
- `lazy_diff` — Show the diff for a task's branch.
- `lazy_status` — Check the current task and worktree status (no params).
- `lazy_conversations` — List past builder conversations with timestamps and summaries.
- `lazy_conversation_search` — Search across past builder conversations by keyword.
- `lazy_conversation_read` — Read a full past builder conversation by `session_id`.

Write-capable tools (have side effects — use deliberately):

- `lazy_commit` — Stage and commit changes in the current task's worktree.
- `lazy_create` — Create a subtask of the current task (pass `parent`) to decompose its own work into executable parts. The human launches it. Don't use this for orthogonal/out-of-scope discoveries — record those with `lazy_add_followup` instead.
- `lazy_comment` — Add a comment to a task (defaults to the current task). Comments are *delivered to the agent* — they enter the next turn's prompt as guidance. Use this to instruct or steer the work.
- `lazy_journal` — Append a journal entry to a task (defaults to the current task). Journal entries are an append-only, prompt-immune side channel: they are NEVER injected into any agent prompt and never auto-delivered. Use this to *record* — design rationale and decisions ("chose K=3 because…"), things stubbed or deferred for later, orchestration metadata ("blocked on X landing"), and memories for future runs.
- `lazy_add_followup` — Record an orthogonal follow-up note on the current task. A passive note the human triages later; it creates no task and starts no work.

When to reach for these:

- Before making a non-obvious design decision, search prior tasks for how similar choices were resolved — past human feedback is the strongest signal of what's valued.
- When a prompt references another task by code or name, look it up rather than guessing.
- When you spot unrelated improvements while working, record them with `lazy_add_followup` (and mention them in your final summary) instead of creating backlog tasks, leaving TODO comments, or trailing prose.
- Comment to instruct, journal to remember: if the text is guidance the agent should act on, comment it; if it's rationale/metadata/memory for the human or a future run, journal it (it stays out of the prompt).

Memory caveat: task records and conversation summaries are frozen in time. For "what is the code now," prefer reading the current files; for "why was it done this way," prefer task/commit history.
