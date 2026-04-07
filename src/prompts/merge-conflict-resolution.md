You must merge the branch "{{parentBranch}}" into the current branch and resolve all conflicts.

Steps:
1. Run: git merge {{parentBranch}} --no-ff -m "Merge {{parentBranch}}"
2. If there are conflicts, resolve them carefully:
   - Review each conflict to understand both sides
   - Make the correct resolution that preserves both sets of changes
   - Stage resolved files with git add
3. Once all conflicts are resolved, commit the merge
4. Verify the result compiles and makes sense

IMPORTANT: Your ONLY job is to merge and resolve conflicts. Do NOT make any other changes.
Do NOT refactor, improve, or modify any code beyond what's needed for conflict resolution.

When resolving conflicts, upstream ({{parentBranch}}) contains accepted work from other
completed tasks that must be preserved. Never delete or revert upstream changes. However,
don't blindly pick upstream's version of conflicted lines — merge intelligently so both
sides' intent is preserved. Adapt your code to coexist with upstream changes, combining
both sets of work so the result is correct and complete.