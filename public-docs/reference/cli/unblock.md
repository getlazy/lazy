# lazy unblock

This page is generated from `lazy unblock --help`.

```text
Usage: lazy unblock <task_id> [-f <file> | -m|--message <text>] [--model <model>] [--effort <level>] [--agent <profile>] [--respond-raised <id>=<text>...] [--promote-raised-subtask <id>...] [--promote-raised-peer <id>...] [--dismiss-raised <id>=<reason>...] [--acknowledge-raised <id>...] [--override-usage-pause] [--default-image] [--yes] [--follow]

Unblock a task by providing feedback, or interactively review and act on it.

When called with no flags (interactive mode), shows task context and lets you:
  1. Give feedback (opens editor)
  2. Accept the work (merge)
  3. Reject the work (discard)

If the task is in 'merging' state (stuck waiting for CI/merge), unblock moves it
back to 'blocked' so you can give feedback, fix issues, and retry accept later.
A task whose accept died mid-way is being resumed by the daemon instead; unblock
refuses it until those resumes are exhausted (run 'lazy accept' to resume now).

When called with flags (imperative mode), sends feedback directly.

Use 'lazy blocked' to check when the agent finishes and needs your input.
To review all blocked tasks sequentially, use: lazy loop

To merge upstream changes into a task branch, use: lazy sync <task_id>

Arguments:
  <task_id>           ID of the blocked task to unblock

Options:
  -f <file>           Read feedback from a file
  --override-usage-pause   Let this task's next turn start even though its credential is past the
                        usage-pause threshold (used up by that one turn)
  --default-image    While the project's runner image is still building (or failed), run on
                     lazy's default runner image instead of being asked (--yes does too)
  -m, --message <text>  Provide inline feedback
  --model <model>     Override model for this turn (e.g. opus, sonnet, claude-opus-5-5)
  --effort <level>    Override Claude Code reasoning effort for this turn (low, medium, high, xhigh, max)
                      Persists on the task for future turns.
  --agent <profile>   Switch this task to a different agent profile — an [agents.<name>]
                      block in lazy.toml; harness names (claude-code, codex, cursor, pi)
                      are the built-in profiles.
                      Persists on the task for future turns. When switching agents,
                      the session is reset (cannot resume across agents).
  --respond-raised <id>=<text>
                      Optionally respond to an open raised item (repeatable).
                      Unlike accept, partial resolution is OK — unnamed items stay
                      open for the next accept.
  --promote-raised-subtask <id>
                      Optionally create a child task under this one for the item
                      (repeatable; optional =<note>).
  --promote-raised-peer <id>
                      Optionally create a sibling task for the item (repeatable;
                      optional =<note>). Lazy creates either promoted task itself,
                      and the agent is told so it stops re-raising.
  --dismiss-raised <id>=<reason>
                      Optionally dismiss an open raised item (repeatable).
  --acknowledge-raised <id>
                      Acknowledge an open raised item — "seen, maybe later"
                      (repeatable; optional =<note>). Same act as dismiss, with
                      a different valence; works on any item.
  --yes               Skip interactive prompts (non-interactive mode)
  --follow            Wait for the agent to finish, streaming output in real time

Feedback input priority: -f file > --message flag > piped stdin > $EDITOR (interactive)

Interactive mode (no flags, TTY):
  Shows task summary, recent commits, diff summary, then presents choices:
  give feedback, accept, or reject.

Imperative mode (any flag or piped stdin):
  Sends feedback directly without interactive preamble.

Upstream Merge:
  Unblock no longer merges upstream automatically. To merge upstream changes
  into a task branch, use 'lazy sync <task_id>' as a separate step before
  or after unblocking.

File Permission Violations (conflict status):
  When the agent modifies protected files, the task enters 'conflict' status.
  That status means one thing: a decision is owed at MERGE time. Unblock does
  not ask for it and never reverts a file — a conflict task is unblocked exactly
  like a blocked one, as many times as the work needs.

  While the agent still has the context, each turn ends with a pushback asking it
  to revert the file itself or record a keep reason. You decide at accept:

    lazy accept <task_id> --approve-file <file> ...

  Accept is all-or-nothing: every pending violated file must be named or the
  accept is refused, and nothing is ever reverted for you. Approvals are sticky,
  so a file you approved stays approved; the web review page ('lazy dashboard')
  has per-file controls and un-approving returns a file to pending.

Raised items (optional on unblock):
  The same --respond-raised / --promote-raised-subtask / --promote-raised-peer /
  --dismiss-raised flags as accept. They are OPTIONAL here: resolve what the
  feedback answers; leave the rest open for the next accept. Feedback prose is
  never parsed for answers. Comments are written on this unblock.

Examples:
  lazy unblock abc123                                   # Interactive review
  lazy unblock abc123 --message "Add error handling"    # Direct feedback
  lazy unblock abc123 -f feedback.md
  lazy unblock abc123 --model opus --message "Complex refactoring needed"
  lazy unblock abc123 --agent cursor --message "Continue with Cursor"  # Switch agent
  lazy unblock abc123 --message "Fix it" --follow       # Wait for completion
  lazy unblock abc123 --message "Fix it" --yes          # Non-interactive
  echo "Fix the bug" | lazy unblock abc123              # Piped stdin as feedback
  lazy unblock abc123 --respond-raised a1b2c3d4="go with option 2" --message "Agreed" --yes

  # Merge upstream first, then give feedback:
  lazy sync abc123
  lazy unblock abc123 --message "Fix the bug"
  lazy unblock abc123 --message "Keep going"                          # Conflict tasks unblock like any other
```
