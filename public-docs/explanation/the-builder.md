# The builder

The builder is the conversational agent you talk to about your whole project. It is not the agent of any one task: it plans work, creates and starts tasks, reviews what comes back and accepts or rejects it, across all of them.

## Why it exists

A task's agent works on one task, in its own worktree, and can only change that task and its own subtasks. Someone has to decide what the tasks should be, in what order, and what to do with the results. You can do that with the CLI, but you can also describe the intent in a conversation and let the builder issue the commands. It is the orchestrator; task agents do the implementation.

## How it works

The builder is an interactive Claude Code session started with lazy's builder instructions added to the system prompt. Your `CLAUDE.md` and `AGENTS.md` are not modified. It has no current task, and it reaches tasks through the same `lazy_*` tools task agents use (see [MCP tools](../mcp-tools.md)); every task operation goes through the daemon.

It is deliberately limited in what it can touch:

- Under Docker or Podman it runs in a container with your repository mounted read-only, so it cannot do implementation work in the git tree. Task agents have more filesystem access than the builder.
- It runs without permission prompts by default (you confirm this once at launch, or pass `--yes`); `--no-autonomous` turns the prompts back on.
- Its only writable place is a [scratch directory](../builder-scratch-dir.md), for handing you files. It is never visible to task agents.

Its conversations are captured into the project store, so you can list, search and resume them (see [importing conversations](../conversation-import.md)).

## What it can and cannot do

Tools are offered by role. The builder gets the task-management tools without the ownership limit a task agent has: it can change any task, where an agent can only change its own task or a direct child. A few tools are builder-only because they curate things that would otherwise be an agent vouching for its own work, or because they put a task somewhere an agent may not write:

- `lazy_memory_save`, `lazy_raised_promote`, `lazy_message_dismiss`
- `lazy_scratch`
- `lazy_clone`, `lazy_redo`, `lazy_reparent`

In the other direction, the tools that describe "my current task" (`lazy_report`, `lazy_raise`, `lazy_commit`, `lazy_final` and similar) are not offered to the builder; it has no task. Where the builder is narrower than the CLI, that is intended. See [surface asymmetries](../surface-asymmetries.md) for the rules.

## The builder is not a cluster task

Both coordinate other tasks, but they are different things:

- The builder is a conversation with you. It acts when you talk to it, and you steer it turn by turn.
- A [cluster task](../cluster-tasks.md) is a task. Its agent runs unattended, drives its own children to completion and lands them on its own branch to be reviewed as one change.

Use the builder to decide and direct; use a cluster to hand off a defined pile of related work.

## In each surface

- **CLI:** `lazy builder` starts a session; `lazy builder --resume <id>` resumes one and `lazy builder list` lists earlier conversations.
- **Daemon dashboard:** the **Builders** page lists and shows captured conversations. It does not start a builder. Each captured conversation is one row:

  ![The dashboard Builders page: a line explaining that past dialogues with the project's builder are captured as they happen, a search box, and a table with one builder conversation (id, started, ended, turns, title).](../images/dashboard/builders.png)

- **Lazy Teams** (private alpha): the **Builders** page has a **Start your builder** button (it reads **Open your builder** while yours is running) and opens an in-browser terminal; the builder runs on the server. In a clone logged in to Teams, `lazy builder` attaches your terminal to it, and `lazy builder stop` and `lazy builder end` stop or finish it. See [Builders in Lazy Teams](../lazy-teams-builders.md).

  ![The Lazy Teams Builders page. An Open your builder button sits above a transcript search box and a list of three builders with their start time, turn count, owner and a Running or Stopped status.](../images/teams/teams-builders.png)

## Limits

- The builder cannot write to your repository and cannot hand files to task agents; to change code, create a task.
