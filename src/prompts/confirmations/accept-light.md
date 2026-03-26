STOP. Do NOT call lazy_accept again yet.

You are accepting task `{{task_code}}` ({{files_changed}} files, +{{lines_added}}/-{{lines_removed}} lines).

REQUIRED before confirming:
1. Call `lazy_diff {{task_id}}` and review the output.
2. Verify the changes match the task's goal.
3. If satisfied, call `lazy_accept` with confirmation_code: "{{confirmation_code}}"
4. If something looks wrong, tell the user what you found instead of confirming.