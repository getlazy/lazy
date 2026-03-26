STOP. Do NOT call lazy_reject again yet.

You are about to REJECT task `{{task_code}}`, which will:
- Discard all agent work ({{commit_count}} commits, {{lines_changed}} lines)
- Mark the task as abandoned

REQUIRED before confirming:
1. Consider whether `lazy_unblock` (giving feedback) would be more appropriate. Rejection means "fundamentally wrong — start over." Feedback means "adjust this."
2. If rejection is the right call, tell the user what will be discarded and proceed with confirmation_code: "{{confirmation_code}}"
3. If feedback would be better, suggest `lazy_unblock` instead of confirming.