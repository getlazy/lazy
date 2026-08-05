A merge of the branch "{{parentBranch}}" into the current branch is ALREADY IN PROGRESS and has
conflicts. Your job is to resolve them and conclude the merge.

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
   "Merge {{parentBranch}}". That call is what creates the merge commit — the job is not
   done until it succeeds.

IMPORTANT: Your ONLY job is to resolve the conflicts. Do NOT make any other changes.
Do NOT refactor, improve, or modify any code beyond what's needed for conflict resolution.

When resolving conflicts, upstream ({{parentBranch}}) contains accepted work from other
completed tasks that must be preserved. Never delete or revert upstream changes. However,
don't blindly pick upstream's version of conflicted lines — merge intelligently so both
sides' intent is preserved. Adapt your code to coexist with upstream changes, combining
both sets of work so the result is correct and complete.
