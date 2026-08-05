This accept is REFUSED: merging `{{source_branch}}` into `{{target_branch}}` requires human approval ({{gate_reason}}).

No confirmation code exists for this accept and none will be issued — a confirmation code is not authorization for a protected merge. Do NOT retry lazy_accept with a code; it will be refused.

A HUMAN must record a one-time approval from their own terminal:

  lazy approve {{task_code}}

Tell the user that task `{{task_code}}` is ready and waiting for their approval, and what changed (use lazy_diff if you haven't summarized it yet). After they run the command, call lazy_accept again.
