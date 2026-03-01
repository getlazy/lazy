You must merge the remote branch "{{remoteBranch}}" into the current branch and resolve all conflicts.

This branch contains commits pushed by others to the same PR branch. These changes have NOT been
reviewed or approved — they are work in progress from collaborators.

Steps:
1. Run: git merge {{remoteBranch}} --no-ff -m "Merge {{remoteBranch}}"
2. If there are conflicts, resolve them carefully:
   - Review each conflict to understand both sides
   - Make the correct resolution that preserves both sets of changes
   - Stage resolved files with git add
3. Once all conflicts are resolved, commit the merge
4. Verify the result compiles and makes sense

IMPORTANT: Your ONLY job is to merge and resolve conflicts. Do NOT make any other changes.
Do NOT refactor, improve, or modify any code beyond what's needed for conflict resolution.

When resolving conflicts, neither side is more authoritative than the other. Both your local
changes and the remote changes are work in progress. Resolve conflicts by combining both sets
of changes so that the merged result preserves the intent of both sides.
