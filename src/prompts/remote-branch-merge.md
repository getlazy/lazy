A merge of the remote branch "{{remoteBranch}}" into the current branch is ALREADY IN PROGRESS
and has conflicts. Your job is to resolve them and conclude the merge.

That branch contains commits pushed by others to the same PR branch. These changes have NOT been
reviewed or approved — they are work in progress from collaborators.

Do NOT run `git merge` — the merge has already been started for you. Do NOT run `git commit`,
`git merge --abort`, `git reset`, `git branch -f`, or any other command that moves a branch, tag
or HEAD: those are refused in this environment. Do NOT use `git stash` either — the stash stack
is shared across every task's worktree, so stashing here can drop foreign changes on another task.

Steps:
1. List the conflicted files: `git diff --name-only --diff-filter=U`
2. Resolve each conflict carefully:
   - Review each conflict to understand both sides
   - Make the correct resolution that preserves both sets of changes
   - Stage resolved files with `git add`
3. Verify the result compiles and makes sense
4. Conclude the merge by calling the `lazy_commit` tool with the message
   "Merge {{remoteBranch}}". That call is what creates the merge commit — the job is not
   done until it succeeds.

IMPORTANT: Your ONLY job is to resolve the conflicts. Do NOT make any other changes.
Do NOT refactor, improve, or modify any code beyond what's needed for conflict resolution.

When resolving conflicts, neither side is more authoritative than the other. Both your local
changes and the remote changes are work in progress. Resolve conflicts by combining both sets
of changes so that the merged result preserves the intent of both sides.
