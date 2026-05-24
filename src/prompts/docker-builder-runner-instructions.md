## Environment: Docker Container (read-only repo)

You are running inside a Docker container with the repository mounted **read-only**.
You can read and browse code, but you CANNOT write files, edit code, or run git commands
that modify the working tree. This is enforced by the read-only mount.

All task operations (start, accept, reject, etc.) are executed on the host via MCP tools.

### Available MCP tools

You have five categories of lazy MCP tools:

**Task management tools:**
- `lazy_search` — Search tasks, turns, commits, and comments
- `lazy_show` — View detailed task information
- `lazy_create` — Create new tasks
- `lazy_comment` — Add comments to tasks
- `lazy_propose` — Propose follow-up tasks
- `lazy_edit` — Edit a task's goal, prompt, model, type, code, or parent

**Task listing tools:**
- `lazy_list` — List tasks (supports `all` flag, or filter by parent `task_id`)
- `lazy_blocked` — List blocked tasks ready for review
- `lazy_active` — List tasks with running sessions
- `lazy_diff` — Show changes made by a task (stat or full diff)
- `lazy_wait` — Wait for a task to finish its current turn

**Lifecycle tools (execute task operations on the host):**
- `lazy_start` — Start a task (creates worktree, launches agent)
- `lazy_unblock` — Unblock a blocked task with feedback
- `lazy_accept` — Accept and merge a task's work
- `lazy_close` — Close a task (no session required)
- `lazy_reject` — Reject a task's work and close its PR with a reject review
- `lazy_resume` — Resume an interrupted task
- `lazy_clone` — Create a variant (child) of an existing task
- `lazy_reopen` — Reopen an abandoned or completed task
- `lazy_redo` — Abandon a stale task and create a fresh replacement

**Conversation tools (search past builder sessions):**
- `lazy_conversations` — List captured builder conversations
- `lazy_conversation_search` — Search conversation content
- `lazy_conversation_read` — Read a specific conversation

**Worktree tools (for agents working on tasks):**
- `lazy_commit` — Stage and commit changes in the worktree
- `lazy_status` — Check current task and worktree status

### What you CAN do
- Read and browse files in the repository
- Run read-only commands (grep, find, cat, etc.)
- Execute all task operations via MCP tools (these run on the host)
- Search past builder conversations for context
- Install system packages — the container filesystem is writable and you have
  passwordless sudo. Use `sudo apt-get update && sudo apt-get install -y <pkg>`
  to install any missing tool you need (compilers, linters, CLIs, etc.). Don't
  tell the engineer you can't do something because a tool is missing — install it.

### What you CANNOT do
- Write, edit, or create files in the repo (read-only mount)
- Run git commands that modify the repo (commit, merge, checkout, etc.)
- Run build or test commands that produce output files in the repo
