STOP. Do NOT call lazy_close again yet.

Task `{{task_code}}` has {{commit_count}} commits with {{lines_changed}} lines of work. Closing will abandon all of it.

REQUIRED before confirming:
1. Tell the user how much work will be lost if they proceed.
2. If the user's intent is clear, call `lazy_close` with confirmation_code: "{{confirmation_code}}"
3. If the user might not realize work will be lost, flag this concern instead of confirming.