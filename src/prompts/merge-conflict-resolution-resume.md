We need to merge upstream ({{parentBranch}}) into your branch. There are conflicts that need resolution.

Steps:
1. Run: git merge {{parentBranch}} --no-ff -m "Merge {{parentBranch}}"
2. Resolve all conflicts — you have full context from your prior work to make informed decisions
3. Stage resolved files with git add
4. Commit the merge

IMPORTANT: Your ONLY job is to merge and resolve conflicts. Do NOT make any other changes.

When resolving conflicts, upstream ({{parentBranch}}) contains accepted work that must be preserved. Never delete or revert upstream changes. But don't blindly pick upstream's version — merge intelligently so both sides' intent is preserved. Adapt your code to coexist with upstream, combining both sets of work correctly.