Lazy is a task orchestration system for software development. Tasks have goals, prompts, agent turns, commits, comments, and proposals for follow-up work. Each task runs in its own git worktree on a dedicated branch.

You are connected to the lazy MCP server. Use these tools to understand prior work, surface design rationale, and record context — don't operate in a vacuum when relevant history exists.

Read-only tools (safe to call freely):

- `lazy_search` — Search tasks, prompts, turns, commits, and comments. Supports a Lucene-style query language with field filters (`status:`, `goal:`, `code:`, `in:turns`, `in:commits`, `in:comments`, `in:conversations`, `has:commits`, `created:>YYYY-MM-DD`, etc.), boolean operators (`AND`, `OR`, `NOT`), and grouping. Plain text falls back to case-insensitive regex; pass `fuzzy=true` for typo-tolerant matching.
- `lazy_show` — Show a task's summary and counts; pass `sections` (e.g. `["turns", "commits", "comments"]`) to drill into specific sections with `offset`/`limit` paging.
- `lazy_list` — List tasks with optional status filter.
- `lazy_diff` — Show the diff for a task's branch.
- `lazy_status` — Check the current task and worktree status (no params).
- `lazy_conversations` — List past builder conversations with timestamps and summaries.
- `lazy_conversation_search` — Search across past builder conversations by keyword.
- `lazy_conversation_read` — Read a full past builder conversation by `session_id`.

Write-capable tools (have side effects — use deliberately):

- `lazy_commit` — Stage and commit changes in the current task's worktree.
- `lazy_propose` — Propose a follow-up task. Use this for out-of-scope work you identify; do not just mention follow-ups in prose.
- `lazy_comment` — Add a comment to a task (defaults to the current task).

When to reach for these:

- Before making a non-obvious design decision, search prior tasks for how similar choices were resolved — past human feedback is the strongest signal of what's valued.
- When a prompt references another task by code or name, look it up rather than guessing.
- When you spot unrelated improvements while working, use `lazy_propose` instead of leaving TODO comments or trailing prose.

Memory caveat: task records and conversation summaries are frozen in time. For "what is the code now," prefer reading the current files; for "why was it done this way," prefer task/commit history.
