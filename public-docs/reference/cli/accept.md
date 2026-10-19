# lazy accept

This page is generated from `lazy accept --help`.

```text
Usage: lazy accept <task_id> [--reason "..."] [--yes] [--wait] [--approve-file <file>...]
                        [--respond-raised <id>=<text>...] [--promote-raised-subtask <id>...]
                        [--promote-raised-peer <id>...] [--dismiss-raised <id>=<reason>...]
                        [--acknowledge-raised <id>...]

Accept a task's work and merge it into the appropriate branch.

For root tasks (no parent): merges into the branch it was created from (or main)
For child tasks (created via branch): merges into parent's branch

Arguments:
  <task_id>    ID of the task to accept

Options:
  --reason "..."        Provide accept reason inline (default: "LGTM")
  --yes                 Skip interactive prompts (non-interactive mode). Does NOT
                        skip raised-item resolution or the protection passphrase.
  --wait                If merge fails due to pending CI checks, poll until checks
                        complete, then retry the merge. Timeout: 10 minutes.
  --approve-file <file> Approve a file (repeatable). Required when accepting a conflict
                        task — all violated files must be listed. Also required when the
                        merge would re-add a file the target branch deleted; accept
                        refuses and names the files until each one is approved.
                        All-or-nothing: a file left out makes accept REFUSE. Accept
                        never reverts anything.
  --respond-raised <id>=<text>
                        Respond to the agent on an open raised item (repeatable).
                        Schedules a comment quoting the item; delivered on this
                        accept (or the next unblock). Required (with promote/dismiss)
                        for every open item — all-or-nothing, like --approve-file.
  --promote-raised-subtask <id>
                        Create a child task under this one for the item on accept
                        (repeatable; optional =<note>). Re-parented onto the accept
                        target with the task's other children.
  --promote-raised-peer <id>
                        Create a sibling task for the item on accept (repeatable;
                        optional =<note>). Lazy creates either promoted task
                        itself, and the agent is told so it stops re-raising.
  --dismiss-raised <id>=<reason>
                        Dismiss an open raised item with a reason (repeatable).
  --acknowledge-raised <id>
                        Acknowledge an open raised item — "seen, maybe later"
                        (repeatable; optional =<note>). Same act as dismiss with
                        a different valence, and it clears the accept gate the
                        same way, so it counts toward the all-or-nothing set.
  --allow-broken        Merge even though the accept check failed. The failure is
                        still reported as a warning — this suppresses the refusal,
                        never the fact.
  --allow-review-issues Merge even though the latest review left issues
                        outstanding or failed outright. Review findings are fix
                        feedback, not items you can dismiss one at a time, so
                        this is how a human who has read the work says "I have
                        decided" instead of paying for another agent turn. There
                        is no MCP equivalent — an agent may not overrule a
                        review for you.
  --allow-queued-comments
                        Merge even though comments a person queued for the
                        agent (lazy comment, web review comments) have not
                        been delivered. Without it accept refuses, because merging
                        ends the task with that feedback never read.

Reason input priority: --reason flag > piped stdin > interactive prompt > "LGTM"

Behavior:
  - Merges directly by default. If [automation.pre_accept] enabled = true is
    set, accept first runs the configured commands as the MECHANICAL acceptance
    gate in an ephemeral container on the task's worktree BEFORE merging — no
    agent turn runs. If any command fails, the task returns to blocked and the
    accept is aborted (never a silent merge). This can take a while; the CLI
    waits for it.
  - Runs the accept check before merging, when [automation] accept_check is set:
    the project's own command (e.g. "bun run typecheck") is run against the
    TASK's worktree inside a short-lived container, and a non-zero exit REFUSES
    the accept — a task that does not
    build would break the branch it is merged into. Unset means no gate, and
    accept says the step was skipped rather than guessing a command. Override a
    refusal knowingly with --allow-broken.
  - Names any protected files that were REVERTED during the task. A reverted
    file is absent from the diff, which reads identically to "the task never
    touched it" — so accept says it outright before the merge.
  - Checks pre-merge gates (CI, reviews, unresolved comments) before merging.
    If any gates are failing, accept refuses to merge and prints a link to the
    PR/MR so the user can resolve the issues there.
  - Checks for merge conflicts BEFORE attempting the merge
  - If conflicts detected in interactive mode: prompts to sync with upstream
  - If conflicts detected in non-interactive mode: shows manual instructions
  - If no conflicts: merges and cleans up the worktree/branch
  - Allows uncommitted changes in the main repo; merge will fail naturally if conflicts occur
  - Accept reason is stored as a comment on the task
  - Lazy writes no review or comment to a PR. The one exception: with [remote]
    auto_approve = true and a protected target, the reason is the body of the
    approving review the forge needs before it will merge
  - With --wait: if the merge fails (e.g., required CI checks pending), polls
    check status every 10s for up to 10 minutes, then retries the merge

Protected merges ([protection] in lazy.toml):
  - Accepting a protected merge prompts for the approval passphrase and merges
    in the same invocation — the approval is bound to the exact commits merged.
  - The prompt is TTY-only. There is deliberately no flag, env var, or stdin
    route for the passphrase, and --yes skips other prompts but NEVER this one.
  - A human approval on the task's PR/MR satisfies the same gate — then no
    passphrase is asked.
  - The passphrase is enrolled once per MACHINE, hashed and outside every
    repository: 'lazy system passphrase set'. With nothing enrolled here, a
    protected merge refuses with that instruction rather than prompting.
  - A review recorded by the builder's refused accept is shown before the
    prompt and attached to the merge (the [Accepted] task comment).

Raised items (agent questions/decisions that gate accept):
  - Accept refuses while any BLOCKING raised item is open. Every such item must be
    responded to, promoted (subtask or peer), or dismissed — all-or-nothing.
  - Interactive TTY with no flags: walks each open item (content + options)
    and prompts respond / promote-subtask / promote-peer / dismiss. --yes does
    NOT skip this walk.
  - Non-interactive without flags: refuses with a pasteable command naming
    --respond-raised for each open id.
  - Comments stay pending until accept/unblock writes them; change the
    resolution on the review page before then to undo.
  - See also: lazy show (lists raised items), lazy raised (triage non-blocking
    raised items — those do NOT gate accept).

Conflict Resolution:
  Interactive mode (TTY available, no --yes flag):
    - Prompts: "Conflicts with main detected. Sync with upstream? [Y/n]"
    - If yes: fires off 'lazy sync <task>' (non-blocking), then exits
    - Review the merge result, then retry accept manually
    - If no: shows manual instructions

  Non-interactive mode (no TTY or --yes flag):
    - Automatically invokes 'lazy sync <task>' (non-blocking), then exits
    - Review the merge result, then retry accept manually

Examples:
  lazy accept abc12345                          # Accept with interactive prompt for reason
  lazy accept abc12345 --reason "LGTM"          # Accept with inline reason
  echo "Looks good" | lazy accept abc12345      # Piped stdin as reason
  lazy accept abc12345 --yes                    # Accept without prompts (uses "LGTM")
  lazy accept abc12345 --reason "Ship it" --yes # Accept with reason, no prompts
  lazy accept abc12345 --wait                   # Wait for CI checks before merging
  lazy accept abc12345 --approve-file a.ts --approve-file b.ts --yes  # Accept conflict task, approving violated files
  lazy accept abc12345 --respond-raised a1b2c3d4="use option 2" --dismiss-raised e5f6a7b8="not in scope" --yes
  lazy accept abc12345 --promote-raised-subtask a1b2c3d4 --promote-raised-peer e5f6a7b8 --yes

Documentation: https://docs.getlazy.dev/raised-items
```
