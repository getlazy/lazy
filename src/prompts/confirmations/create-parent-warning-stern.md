STOP. Do NOT call lazy_create again without reading this.

Task `{{active_task_code}}` has {{child_count}} children. This project uses parent-child hierarchy. Creating a parentless task under `main` is almost certainly wrong — your new task will branch off `main` instead of the active parent, and all its work will likely need to be thrown away.

Did you mean to create this as a child of `{{active_task_code}}`? If so, call `lazy_create` with `parent: "{{active_task_code}}"`.

If you genuinely need a standalone task under `main`, call `lazy_create` with confirmation_code: "{{confirmation_code}}"