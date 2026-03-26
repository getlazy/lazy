STOP. Do NOT call lazy_create again yet.

You're creating a task under `main`, but there is an active task `{{active_task_code}}`. You may have meant to create a subtask under `{{active_task_code}}` instead.

Ask the user which parent they intended — `main` or `{{active_task_code}}`.

If they confirm `main`, call `lazy_create` with confirmation_code: "{{confirmation_code}}"