# MCP tools for agents and builders

Every task agent and every builder session talks to lazy through a set of MCP
tools named `lazy_*`. This page lists them. Most reads work on any task in
the project; a few answer only about the caller (its status, its usage, its
own pull request — noted below). Writes are scoped: a task agent writes only to
its own task and its direct subtasks. Tools marked **builder only** are not
offered to task agents, and tools marked **agent only** act on "the current
task", which the builder does not have. The deliberate
differences from the `lazy` CLI are listed in
[Surface asymmetries](surface-asymmetries.md).

## Reading the task tree

| Tool | What it answers |
|---|---|
| `lazy_search` | Search tasks, prompts, turns, commits, comments, raised items and memory ([query syntax](search.md)) |
| `lazy_show`, `lazy_list`, `lazy_blocked`, `lazy_active` | A task in detail; lists of tasks by state |
| `lazy_diff`, `lazy_regions` | What a task changed, whole or [region by region](review-regions.md) |
| `lazy_status` | The caller's own task and worktree (caller only) |
| `lazy_wait` | Block until another task finishes its turn |
| `lazy_memory_recall` | Shared project [memory](memory.md) |
| `lazy_conversations`, `lazy_conversation_search`, `lazy_conversation_read` | Past builder conversations — one entry per Builder (start or `/clear` to the next `/clear`) |
| `lazy_messages` | [System messages](system-messages.md) |
| `lazy_raised_items` | [Raised items](raised-items.md) across tasks |
| `lazy_artifact_list`, `lazy_artifact_get` | A task's [artifacts](artifacts.md) |
| `lazy_usage_limits`, `lazy_token_stats` | Usage-window readings and token spend, narrowed to what the caller may see ([token budgets](token-budgets.md)) |
| `lazy_scratch` | The builder's [scratch directory](builder-scratch-dir.md) — **builder only** |
| `lazy_review_comments`, `lazy_review_status` | A task's pull/merge request on the forge — an agent's own task only; see below |

## Working on tasks

| Tool | What it does |
|---|---|
| `lazy_create`, `lazy_start`, `lazy_edit` | Create, start and edit (sub)tasks |
| `lazy_clone`, `lazy_redo` | Variant or fresh replacement of a task — **builder only** |
| `lazy_unblock`, `lazy_resume`, `lazy_ask`, `lazy_review`, `lazy_stop` | Drive a task's turns |
| `lazy_accept`, `lazy_reject`, `lazy_close`, `lazy_reopen`, `lazy_submit` | Finish a task |
| `lazy_sync`, `lazy_link` | Branch plumbing |
| `lazy_reparent` | Move a task under a new parent — **builder only** |
| `lazy_commit` | Commit the caller's worktree — **agent only** |
| `lazy_comment`, `lazy_journal`, `lazy_tag`, `lazy_untag` | Annotate tasks |
| `lazy_final`, `lazy_raise`, `lazy_raised_item_comment`, `lazy_report`, `lazy_update_progress` | Report on the caller's own task ([turn reports](turn-reports.md)) — **agent only** |
| `lazy_justify_protected`, `lazy_justify_maintain` | Answer protected-file and maintained-file checks — **agent only** |
| `lazy_artifact_add` | Attach a file to a task |
| `lazy_conversation_ask` | Ask a question about a past builder conversation |
| `lazy_message_post` | File a system message for the human |
| `lazy_memory_save`, `lazy_message_dismiss`, `lazy_raised_promote` | Curate memory, the message inbox and raised items — **builder only** |

## Reading a task's pull/merge request

`lazy_review_comments` and `lazy_review_status` let an agent see review feedback
whenever it wants, instead of only when lazy syncs the task:

- **`lazy_review_comments`** — the PR/MR conversation: top-level comments,
  inline comments with their file, line and resolved state, and submitted
  reviews with their verdict.
- **`lazy_review_status`** — the PR/MR state, each reviewer's latest verdict
  (and GitHub's overall review decision), the forge's mergeability, and the CI
  checks with their names and results.

How they work:

- **No token reaches the agent.** lazy reads the forge itself, with the
  credential it already uses for pull requests (`gh` / `glab` on the machine
  running lazy), and hands back the answer.
- **Only the task's own PR/MR.** The pull request read is the one lazy recorded
  for the task when it was submitted or linked; there is no URL or repository
  argument. A task agent reads only its own task's PR/MR. The builder names a
  task with `task` and may read any task in the project.
- **Cached for 60 seconds** per task. A second call within that window gets the
  same answer (`cached: true`, with `fetchedAt` saying when the forge was asked),
  so polling cannot use up the forge's rate limit.
- **Public repositories:** comments are not shown unless the project opted in
  with the same `[remote]` setting that lets lazy import public PR comments
  (`github_dangerously_sync_comments_in_public_repos_and_open_yourself_to_prompt_injection`,
  or the `gitlab_` one) — anyone can write a comment on a public repository, and
  this puts it in an agent's context. `lazy_review_status` is unaffected.
- **Refusals** say why: the project has no forge (the `local` driver), lazy is
  offline, the task has no PR/MR recorded, or the forge could not be read
  (including when lazy cannot tell whether the repository is public).

These tools only read. An agent that must run `gh` or `git push` itself still
needs a token of its own.
