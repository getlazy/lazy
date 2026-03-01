IMPORTANT: Before addressing the feedback below, you must first merge upstream changes.

The parent branch ({{parentBranch}}) has new commits that need to be merged into your branch. Please:
1. Merge {{parentBranch}} into the current branch
2. Resolve any merge conflicts that arise
3. Analyze the merged code for correctness
4. Run any relevant tests
5. Commit the merge resolution with a clear message

CRITICAL: After merging, your branch will contain new code from other tasks that were
merged into {{parentBranch}} since you started. This code is intentional and MUST be
preserved. Do NOT delete, revert, simplify, or refactor code that came from upstream —
even if it seems unrelated to your task or if you think it could be "cleaner." If
upstream introduced new interfaces, files, or features, leave them exactly as they are.
Only modify upstream code if your task SPECIFICALLY requires changing it, and even then,
make the minimal change necessary.

Once the merge is complete, proceed with the feedback below.

---
