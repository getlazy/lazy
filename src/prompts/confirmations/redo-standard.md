STOP. Do NOT call lazy_redo again yet.

Redoing task `{{task_code}}` will close the current task and create a replacement. The current task's {{commit_count}} commits will be abandoned.

Tell the user you are redoing this task and what will be discarded, then call `lazy_redo` with confirmation_code: "{{confirmation_code}}"