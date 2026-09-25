This accept is REFUSED: merging `{{source_branch}}` into `{{target_branch}}` requires human approval ({{gate_reason}}).

No confirmation code exists for this accept and none will be issued — a confirmation code is not authorization for a protected merge. Do NOT retry lazy_accept with a code; it will be refused. There is no non-interactive path: only a human at a terminal can complete this merge.

{{review_status}}

A HUMAN must run, from their own terminal:

  lazy accept {{task_code}}

which prompts for the approval passphrase and merges in one step. On GitHub/GitLab, approving the task's PR/MR satisfies the same gate instead.

Tell the user that task `{{task_code}}` is ready and waiting for their accept, and what changed (use lazy_diff if you haven't summarized it yet). Do NOT call lazy_accept again — the merge is now the human's to complete.
