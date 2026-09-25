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

Rules that decide the common cases:

- Lists of entries (changelog sections, option tables) take the UNION of both sides' entries.
- An enumerated list of names — a serializer's field list, a switch over an enum, an exported
  symbol list — takes the UNION too, and dropping one side's entries compiles cleanly while
  silently losing a feature. Verify by diffing the resolved file against BOTH parents
  (`git diff HEAD -- <file>`, `git diff MERGE_HEAD -- <file>`).
- Never finish by abandoning the merge and hand-copying the other branch's content in as new
  commits: the deliverable is a commit with BOTH parents, created by `lazy_commit`.
- After resolving, run what is cheap and relevant (type-check, the tests covering what you
  touched) so neither side's behavior is broken.
