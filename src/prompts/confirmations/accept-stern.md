STOP. Do NOT call lazy_accept again yet. This is a large merge that requires thorough review.

Task `{{task_code}}` changes going into `{{parent_branch}}`:
- {{files_changed}} files changed
- {{lines_added}} additions, {{lines_removed}} deletions
- {{commit_count}} commits

REQUIRED before confirming — do ALL of these:
1. Call `lazy_diff {{task_id}}` with full=true and review every change thoroughly.
2. Check for potential issues: missing tests, security concerns, incomplete implementations.
3. Summarize what changed to the user, flagging any concerns.
4. If everything looks correct, call `lazy_accept` with confirmation_code: "{{confirmation_code}}"
5. If you find any issues, tell the user what you found instead of confirming.