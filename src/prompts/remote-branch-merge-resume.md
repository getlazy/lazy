We need to merge the remote branch "{{remoteBranch}}" into your branch. There are conflicts that need resolution.

These are work-in-progress changes pushed by collaborators to the same PR branch.

Steps:
1. Run: git merge {{remoteBranch}} --no-ff -m "Merge {{remoteBranch}}"
2. Resolve all conflicts — you have full context from your prior work to make informed decisions
3. Stage resolved files with git add
4. Commit the merge

IMPORTANT: Your ONLY job is to merge and resolve conflicts. Do NOT make any other changes.

Neither side is more authoritative than the other. Both your local changes and the remote changes are work in progress. Resolve conflicts by combining both sets of changes so that the merged result preserves the intent of both sides.