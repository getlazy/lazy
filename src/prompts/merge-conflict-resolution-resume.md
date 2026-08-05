A merge of upstream ({{parentBranch}}) into your branch is ALREADY IN PROGRESS and has conflicts
that need resolution.

Do NOT run `git merge`, `git commit`, `git merge --abort` or `git reset` — the merge was started
for you, and commands that move a branch, tag or HEAD are refused in this environment. Do NOT use
`git stash`: the stash stack is shared across every task's worktree.

Steps:
1. List the conflicted files: `git diff --name-only --diff-filter=U`
2. Resolve all conflicts — you have full context from your prior work to make informed decisions
3. Stage resolved files with `git add`
4. Conclude the merge by calling the `lazy_commit` tool with the message "Merge {{parentBranch}}"

IMPORTANT: Your ONLY job is to resolve the conflicts. Do NOT make any other changes.

When resolving conflicts, upstream ({{parentBranch}}) contains accepted work that must be preserved. Never delete or revert upstream changes. But don't blindly pick upstream's version — merge intelligently so both sides' intent is preserved. Adapt your code to coexist with upstream, combining both sets of work correctly.
