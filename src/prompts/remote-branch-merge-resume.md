A merge of the remote branch "{{remoteBranch}}" into your branch is ALREADY IN PROGRESS and has
conflicts that need resolution.

These are work-in-progress changes pushed by collaborators to the same PR branch.

Do NOT run `git merge`, `git commit`, `git merge --abort` or `git reset` — the merge was started
for you, and commands that move a branch, tag or HEAD are refused in this environment. Do NOT use
`git stash`: the stash stack is shared across every task's worktree.

Steps:
1. List the conflicted files: `git diff --name-only --diff-filter=U`
2. Resolve all conflicts — you have full context from your prior work to make informed decisions
3. Stage resolved files with `git add`
4. Conclude the merge by calling the `lazy_commit` tool with the message "Merge {{remoteBranch}}"

IMPORTANT: Your ONLY job is to resolve the conflicts. Do NOT make any other changes.

Neither side is more authoritative than the other. Both your local changes and the remote changes are work in progress. Resolve conflicts by combining both sets of changes so that the merged result preserves the intent of both sides.
