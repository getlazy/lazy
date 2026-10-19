# The low-high loop

A two-phase shape for agent work turns: a cheap low-effort **draft**,
immediately followed by a high-effort **self-review** in the same agent session,
whose instructions a final low-effort **revise** pass applies.

This is lazy's **default review mode** (`[review] mode = "low_high"`). Where the
other modes fit, and why this one is the default, is
[the review paradigm](review-paradigm.md); this page is the mechanism.

## Why

Conversation length dominates what a task costs, and every extra feedback round
multiplies it. So this shape puts maximum thinking on a *review* (short output,
warm cache) and minimum effort on *drafting*. A second agent in a new session
reading the whole diff cold pays the conversation cost twice for the same
change.

## Mechanism

When enabled, a `start`/`unblock`/`resume` work turn runs as up to three agent
invocations of ONE session (warm cache throughout):

1. **Draft** — the task prompt runs at the task's own effort when somebody
   chose one, and otherwise at `[review] draft_effort` (default
   `low`). This is the ordinary work phase.
2. **Self-review** — the supervisor resumes the session at
   `[review] review_effort` (default `xhigh`) in read-only (reflective)
   mode — or at the draft's effort if that is higher, since a review must never
   run weaker than the work it reviews. The reviewer replies with either the
   token `LOW_HIGH_LOOP_APPROVED` or a numbered list of revision instructions.
   It cannot edit files.
3. **Revise** — unless approved, one invocation back at the draft effort
   applies the instructions (they are already in the session's context).

**Exactly one review→revise cycle.**

**Its outcome is recorded as a review, and can be made to gate.** The
self-review emits the same verdict / sweeps / findings report every other lazy
review does, and it is stored on a review turn of its own — so the Reviews tab
lists it, `lazy show` renders it, and you read it exactly as you read a
reviewer's. Under the default gate it does not hold your accept: it is the
writer's own account of its own work, and the revise pass has already acted on
it. `[review] gate = "always"` makes it hold one anyway, on findings above
medium or a sweep that found something.

A self-review whose report does not parse records no review turn at all; the
reviewer's full text is still on the supervised turn.

Under `always`, a self-review the **revise pass already applied** does not hold
the merge. A revise that ran but changed nothing applied nothing, and that one
still holds.

The review and revise phases use the same supervised-invocation machinery as
permission push-back and the maintain nudge: each is recorded as its own
supervisor→agent turn pair (`## Low-High Loop Self-Review`, `## Low-High Loop
Revision`) with its own token usage, commit SHA window, and its own per-turn
`effort`. The task page's **Turns** tab and `lazy show <task>`
therefore show the phase boundaries, what the review caught, and what the
revision changed.

![The Turns tab of a task in the dashboard, oldest first. Turn 2 is the agent's draft. Turn 3 is a supervisor turn titled "Low-High Loop Self-Review". Turn 4 is the agent's reply, which begins LOW_HIGH_LOOP_APPROVED and carries a clean verdict. Turn 5 is the recorded review.](images/explanation/self-review-turns.png)

In this example the self-review approved the draft, so there is no revision turn. Protected-file violation detection runs after the loop, so
revise commits are scanned too.

Failure posture: a crashed or unparseable review/revise phase is non-fatal.
The draft's work stands, the failure is recorded on the phase's turn, and the
turn completes normally.

## Configuration

```toml
[review]
# mode = "low_high"          # the default; "separate" or "off" turn this shape off
# draft_effort = "low"       # draft + revise phases
# review_effort = "xhigh"    # self-review phase
```

**An effort you chose FOR THIS TASK is never replaced.** `--effort` on this
task — on `create`, `start`, `edit` or an unblock — wins for the draft and the
revise pass alike: it is your explicit choice for that task.

A project-wide `[agent] effort` does **not** win: it is the fallback the other
phases resolve from, and the draft still runs at `draft_effort`.

**Its outcome can be made to gate.** By default it does not;
`[review] gate = "always"` makes findings above medium (or a
sweep that found something) hold the accept anyway. See
[the review paradigm](review-paradigm.md).

Per-task: `lazy create/start/edit --review low-high` (or `separate`, or `off`).
The choice persists on task metadata (like `--effort`), so later unblocks and
resumes stay in the same mode even if the project default changes mid-task. When
this mode is on and the task has no effort of its own, the draft effort
**replaces** the project-wide `effort` for work turns.

The three `[agent] low_high_loop*` keys are the older spelling of the
`[review]` settings. They are still accepted, `lazy doctor` names the replacement for
each, and `low_high_loop = false` maps to `mode = "separate"`.

Turns that never run the loop, regardless of the flag: ask turns and
`lazy browse -i` Q&A (read-only — no draft to review), sync/merge turns,
daemon auto-delivered comment turns, and crash auto-resumes.
