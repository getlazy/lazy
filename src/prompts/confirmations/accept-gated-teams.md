This accept is REFUSED: merging `{{source_branch}}` into `{{target_branch}}` requires human approval ({{gate_reason}}).

No confirmation code exists for this accept and none will be issued — a confirmation code is not authorization for a protected merge. Do NOT retry lazy_accept with a code; it will be refused. There is no non-interactive path, and no passphrase.

{{review_status}}

A signed-in team member must press Accept on task `{{task_code}}` in Lazy Teams, which approves and merges in one step. Running `lazy accept` from a command line does not count. On GitHub/GitLab, approving the task's PR/MR satisfies the same gate instead.

Tell the user that task `{{task_code}}` is ready and waiting for their Accept in Lazy Teams, and what changed (use lazy_diff if you haven't summarized it yet). Do NOT call lazy_accept again — the merge is now the human's to complete.
