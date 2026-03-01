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

When resolving conflicts, upstream ({{parentBranch}}) is authoritative. The upstream side
contains intentional work from other completed tasks. Your resolution MUST preserve all
upstream changes — adapt YOUR code to coexist with upstream, not the other way around.
Never resolve a conflict by deleting or reverting upstream code.