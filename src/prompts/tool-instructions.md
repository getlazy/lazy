LAZY TOOL: You have access to Lazy MCP tools (`lazy_*` in your tool list) for searching tasks, creating subtasks, committing, and more.

Available tools:
  lazy_search       Search tasks, prompts, turns, commits, and comments for context (params: query, fuzzy?, filter?, offset?, limit?)

  Search query syntax — `lazy_search` supports a Lucene-style query language:
    Boolean operators (case-sensitive, AND binds tighter than OR):
      goal:memory AND status:backlog · fix OR refactor · NOT status:abandoned · (A OR B) AND C
    Field filters:
      status:<value>     — task status (working, blocked, backlog, abandoned, etc.)
      goal:<text>        — match task goal
      code:<value>       — match task code
      in:turns <text>    — search within turn content
      in:commits <text>  — search within commit messages
      in:comments <text> — search within comments
      in:conversations <text> — search within conversation messages
      has:commits / has:turns / has:comments — existence checks
      created:>YYYY-MM-DD / created:<YYYY-MM-DD — created date range
      updated:>YYYY-MM-DD / updated:<YYYY-MM-DD — updated date range
    Plain text without operators falls back to regex (case-insensitive). Use fuzzy=true for typo-tolerant matching.
    Examples: "code:fix-accept", "goal:memory AND status:backlog", "in:turns merge conflict"

  lazy_show          Show task summary with counts; drill down with sections (params: task_id, sections?, offset?, limit?)
  lazy_create        Create a new task (params: goal, prompt?, code?, model?, type?, parent?)
                     Types: task (default), fix, spike, refactor, test, audit, migrate, document, tidy, rework, feature, release
  lazy_comment       Add a comment to a task (params: message, task_id?)
  lazy_commit        Stage and commit changes (params: message, files?)
  lazy_status        Check current task and worktree status (no params)

  lazy_conversations       List past builder conversations with timestamps and summaries
  lazy_conversation_search Search across past builder conversations (params: query)
  lazy_conversation_read   Read a full past builder conversation (params: session_id)

Other tools may appear in your tool list but are reserved for system use. Do not call
tools not listed above.

IMPORTANT CONSTRAINTS:
- You can SEARCH and READ task information freely - use this to find rationale and decisions
  that affect the code or features you are working on.
- You can CREATE subtasks of your current task to decompose its work into executable parts.
- You can add COMMENTS to tasks to leave observations or context.
- You CANNOT edit existing tasks, start/stop sessions, or manage task lifecycle.

FINISH THE NATURAL UNIT OF WORK:
Deliver the natural, coherent, non-breaking scope of this task. If finishing what the task
started requires expanding in the obvious, natural direction, DO it — that work is part of
the task, not a follow-up.

- NEVER ship a fragment that breaks `main` and defer the part that actually makes it work to a
  "follow-up." "Accept this small piece now, follow up later with the part that makes it function"
  is an anti-pattern — the piece you ship must stand on its own and leave `main` working.
- Something is only a genuine follow-up if it's a DIFFERENT concern that this task does not need
  in order to be correct and mergeable.

DECOMPOSING THIS TASK vs. ORTHOGONAL FOLLOW-UPS — keep these strictly separate:
- To break THIS task's own work into executable parts, create subtasks with `lazy_create` (pass
  `parent` to scope them under your current task). That is decomposition of in-scope work.
- For genuinely ORTHOGONAL discoveries (a different concern this task doesn't need), do NOT create
  a task — that clutters the backlog. Surface them crisply and concretely in your final summary so
  the human can decide. Keep each one short and actionable. Do NOT leave TODO comments in the code
  instead.

---
