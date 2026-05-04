STOP. Do NOT call lazy_abandon again yet.

Task `{{task_code}}` has {{commit_count}} commits with {{lines_changed}} lines of work. Abandoning will discard all of it.

REQUIRED before confirming:
1. Consider whether `lazy_unblock` (giving feedback) would be more appropriate. Abandoning means "this work has no value." Feedback means "adjust this."
2. Tell the user how much work will be lost if they proceed.
3. If the user's intent is clear, call `lazy_abandon` with confirmation_code: "{{confirmation_code}}"
4. If the user might not realize work will be lost, flag this concern instead of confirming.