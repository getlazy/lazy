# Renaming a task

A task's code is how you address it: `lazy show <code>`, dashboard links,
`[serve]` service hostnames (`<code>.<service>.lazy.localhost`) and every other
lookup use it. You can change it at any time, including after the task has run:

```bash
lazy edit release-v091 --code release-next
```

The same edit works from the `lazy_edit` MCP tool and from the Lazy Teams task
edit page.

## What changes, and what does not

A task's branch name is chosen when the task is created, from its code
(`lazy/<code>`), so subtasks and reparented tasks can name it before it starts.
Renaming a task that has **not started yet** moves that branch name with the
code: nothing has been created under the old name, so nothing is left behind.

Renaming a task that has already started is **cosmetic**. Only the code
changes. Everything lazy named when the task first started keeps its original
name:

- the git branch (`lazy/release-v091` above) and its worktree directory,
- the task's container and agent session,
- any pull request or merge request already opened for it.

Nothing is renamed in git or on your forge, so nothing is pushed or deleted.
Subtasks keep syncing, diffing and accepting against the parent's existing
branch without any change. `lazy edit` prints which names stayed the same.

What follows the new code straight away is everything addressed by code:
lookups, dashboard URLs and service hostnames. The old code stops resolving;
lazy does not keep it as an alias.

## Rules

- The new code follows the same rules as `lazy create --code`: lowercase
  letters, digits and hyphens, and no other open task may already use it.
- On a started task, change the code **on its own**, not together with other
  fields, and give a new code rather than clearing it.
- A task created later with the old code gets a branch of its own; it is never
  placed on the renamed task's branch.
- A task listed **by code** in `[protection].protected_tasks` cannot be
  renamed: the entry would stop matching and protect nothing. Run
  `lazy protect <old-code> off`, rename, then `lazy protect <new-code> on`.
  An entry written as the task's short id keeps working across a rename.
