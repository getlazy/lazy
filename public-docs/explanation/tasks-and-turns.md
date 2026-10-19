# Tasks and turns

A task is the unit of work in lazy: a goal, a prompt, and everything that
happens while an agent works toward it. Work happens in turns, and a human
steers by sending feedback between them.

## Why it exists

An agent works for minutes or hours, then stops and waits to be reviewed. Lazy
makes each of those stops a clear boundary. You read what changed, say what
you want next, and the agent continues. Because the work lives in its own
branch and worktree, many tasks run side by side without touching your
checkout or each other.

## The pieces

- **Task.** It has a short code, a goal, a prompt, a status, an optional
  parent task, and a record of its turns, commits and comments. Create one
  with `lazy create` and run it with `lazy start <task_id>`. The status says
  where the task stands; see [the task state machine](../state-machine.md).
- **Branch and worktree.** Each task gets its own git branch, named with the
  prefix from `[git] default_branch_prefix` (default `lazy`, so `lazy/fix-bug`),
  and its own git worktree under `.lazy/worktrees/` in your project. The agent
  edits only that worktree. Changing the prefix renames no existing branch.
- **Turn.** One run of the agent: it starts from a prompt, works, and stops.
  Every turn is recorded with who or what started it. Only one turn runs on a
  task at a time. If a second request arrives while one runs, it is refused as
  busy and nothing you wrote is lost; send it again once the task is idle.
- **Session.** The continuity between turns of one task: the agent's
  conversation, so a later turn remembers earlier ones, plus the commits the
  task has recorded. Switching a task to an agent on a different harness (while no
  turn is running) starts a fresh agent conversation, because one harness's
  conversation cannot be resumed by another; two agents on the same harness
  keep it. A model, effort or agent chosen when you give feedback stays on the
  task for later turns, though switching agent re-picks model and effort for
  the new agent unless you set them in the same step.
- **Subtask.** A task with a parent. Its branch is cut from the parent's
  branch, and accepting it merges it into the parent. A
  [cluster task](../cluster-tasks.md) is a parent whose agent runs its
  subtasks itself.

## Who starts a turn

- **You.** `lazy start` for the first turn, then `lazy unblock` (with your
  feedback) or `lazy resume` (no feedback) for later ones. You can also
  `lazy ask` a read-only question, `lazy sync` to merge upstream changes into
  the task's branch, and `lazy stop` to halt a running turn.
- **The builder.** The builder is the agent you talk to to create and steer
  tasks. It starts and unblocks tasks through the same commands, over MCP.
- **An agent, for its subtasks.** A task's agent can start, unblock, resume,
  ask and sync its own subtasks. These turns are attributed to whoever owns
  the agent's own turn; see [identity](../identity.md).
- **The daemon.** On its own the daemon resumes a task whose turn crashed
  (`auto_resume`, on by default; the crash and retry rules are in the state
  machine page), and, for a task with an open pull request, reacts to forge
  comments and CI results (`auto_react_comments`, `auto_react_ci`, both on by
  default). It also wakes a blocked cluster when a new child is added to it.

Builder and agent starts are bounded: `[limits] max_turns_without_human`
(default 10, `0` for unlimited) caps consecutive turns they start without a
human. A human action always resets the count.

## How feedback reaches the agent

The agent only sees your words in the prompt of a turn.

- **`lazy unblock <task_id>`** starts the next turn with your feedback in its
  prompt. Give it inline with `-m`, from a file with `-f`, or leave both off
  and write it in your editor.
- **`lazy comment <task_id>`** saves a note and nothing else. It does not start
  a turn. The agent reads it in a block headed "NOTES ADDED SINCE YOUR LAST
  TURN" in the prompt of the next `unblock` (or the task's first start). Until
  a note has been shown to the agent you can edit it with `--edit`. A note
  written while a turn is running is handed to that same turn before it ends.
- **`lazy ask`** puts a question to the agent in a read-only turn. It does not
  consume queued comments, and the agent cannot change files in it.

Your feedback is saved before anything that can fail, so a failed launch does
not lose what you typed. Comments left on a pull request by reviewers are the
exception to "a comment starts nothing": with `auto_react_comments` on, the
daemon feeds them to the agent.

## In each surface

- **Daemon dashboard.** The task page shows turns, comments and the actions
  for the current status; see [the web review page](../web-review.md).

  ![A task page in the dashboard. Under the task's title and status are the action buttons Go to Current review, Review, Sync, Submit, Reparent, Redo, Clone, Resume, Close, Edit task, New subtask and Watch, then tabs including Turns, Commits, Raised and Comments, and below them the agent's report.](../images/explanation/task-page.png)

- **CLI.** Everything above is a command: `lazy create`, `start`, `unblock`,
  `comment`, `ask`, `resume`, `sync`, `stop`.
- **Lazy Teams** (private alpha). The task page offers start, unblock, resume,
  stop and sync as single actions, plus comments on the code; see
  [Lazy Teams task review](../lazy-teams-task-review.md).

## Limits

- A turn is dispatched only from `blocked`, `conflict`, `submitted` or
  `interrupted` (and `backlog` for the first start). A task being paired on or
  merged is never handed a turn.
- An agent has no identity of its own; its work is attributed to the person
  who asked for the turn, or to the configured system identity when nobody
  did.
- Comments never wake a task. If you want the agent to act, unblock it.
