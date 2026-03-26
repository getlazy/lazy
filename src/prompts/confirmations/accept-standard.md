STOP. Do NOT call lazy_accept again yet.

This merge puts {{files_changed}} files (+{{lines_added}}/-{{lines_removed}} lines) into `{{parent_branch}}`.

REQUIRED before confirming:
1. Call `lazy_diff {{task_id}}` and carefully review every file.
2. Verify the changes match the task's goal and look correct.
3. Summarize what changed to the user.
4. If satisfied, call `lazy_accept` with confirmation_code: "{{confirmation_code}}"
5. If something looks wrong, tell the user what you found instead of confirming.