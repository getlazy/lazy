There are {{count}} violation(s) of file permissions:

{{files}}

This check runs over your task's whole branch, so some of these files may have
been changed by accepted children of this task rather than by you — you have
their reports.

For each file, do ONE of the following:
- Revert it to its original state, commit the revert, OR
- Keep it and call `lazy_justify_protected(file="<path>", reason="<one short reason>")`.

Justification does not approve the file — the human still decides. Do not rely on
prose alone for keep reasons. After you have handled every file, hand back control.
