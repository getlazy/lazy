STOP. Do NOT call lazy_redo again yet.

Task `{{task_code}}` has significant history ({{commit_count}} commits). Redoing will close it as abandoned and create a replacement. All existing work will be discarded.

REQUIRED before confirming:
1. Tell the user how much work will be lost.
2. If the user's intent is clear, call `lazy_redo` with confirmation_code: "{{confirmation_code}}"
3. If the user might not realize work will be lost, flag this concern instead of confirming.