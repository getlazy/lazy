# Git integration

Every task is a branch and a worktree, and the task tree is a tree of branches.

## Worktrees and branches

Starting a task creates a branch named with the `[git] default_branch_prefix` (default `lazy/`, for example `lazy/fix-bug`) and a git worktree for it under `.lazy/worktrees/` in the project. The agent works only in that worktree. Many tasks run side by side without sharing a working directory. See [Tasks and turns](../explanation/tasks-and-turns.md).

## The task tree

A subtask's branch is cut from its parent task's branch, and accepting it merges it into the parent. A top-level task is cut from, and accepted into, the branch it targets. Each task records its commits as its agent works, and the tree of tasks is the tree of branches.

## Sync

`lazy sync` brings a task branch up to date in two steps, in order:

1. if someone pushed to the task's own branch on the remote, merge that in;
2. merge the parent branch in.

It changes only the task's branch. The parent is never merged into or pushed by a sync. A merge conflict is resolved by the task's agent. It merges from the same branch an accept would merge into, so conflicts show up early. Sync itself never pushes: the reconciled branch reaches the remote through the push that follows a turn and through accept. Both merges are recorded on the task, naming the ref and commit each brought in.

## Accept

Accept is the one step that changes the target branch. It merges the task's branch into its target as a single squash commit (locally, or on the forge for a protected target; see [Forges](forges.md)). Once the merge lands, lazy marks the task complete straight away. Fast-forwarding, pushing the parent, closing a PR, reparenting children and cleanup follow, and are retried if they fail. See [Review and accept](../explanation/review-and-accept.md).
