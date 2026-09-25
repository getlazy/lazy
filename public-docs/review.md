# `lazy review` — agent review of a task's work

`lazy review <task>` runs a **reviewer agent** against a task's branch. It is
an action, not a browser.

## When this reviewer runs at all

**Only in `separate` mode.** A task's [review mode](review-paradigm.md) decides
how it gets read, and the default is `low_high`: the writer reviews its own work
inside its own session, with the diff still in context, and nothing here runs.
Put a task in `separate` mode — `lazy create`/`start`/`edit --review separate`,
or `[review] mode` for the whole project — and everything on this page applies
to it.

**You can run `lazy review <task>` by hand in any mode, and what it finds
GATES.** A review you asked for is a deliberate act — nobody spends a review
turn they did not want — so its findings above medium hold the accept whatever
mode the task is in. Only lazy's own automatic dispatch follows the mode. It is
still never *required* to reach an accept; it is just not ignorable once it has
run. (`[review] gate = "never"` switches even that off, and is the only thing
that does.)

## The review that starts itself

In `separate` mode, declaring a task's work done starts a review on it without
anyone asking, and its verdict gates acceptance: `lazy accept` refuses while the
latest review left something above medium severity outstanding, failed, or never
ran. ([Why lazy reviews by default, and why the default is the fast
one](review-paradigm.md).)

**Accept never disregards a review in silence.** If your settings let a merge
through over a review that found something — the mode ignores lazy's own
dispatch, or the gate is `never` — the accept output says so in one line and
points you at the report.

If that review finds something, what happens next is `[review] auto_fix`, and it
is **off by default**: the task parks with the findings on its review turn, and
whoever is driving — you, or a [cluster](cluster-tasks.md) driver — decides
whether another round is worth its half hour. Turn `auto_fix` on and the
findings go straight back to the agent as the brief for its next turn instead,
the work is declared done again, and the next review starts: two rounds like
that, then the task parks anyway. A task parked either way resumes the moment
you unblock it with direction, and every fresh start of the cycle begins the
rounds anew.

**Findings are feedback, not items to triage.** They are recorded on the review
turn and handed to the fixer; nothing is left on your Raised tab afterwards for
a defect that was fixed two turns later. What you should find at the end is the
last review, clean, and the history behind it.

The reviewer raises something for you in exactly one case: **the task cannot be
completed without compromising security or data integrity, or its goal
contradicts itself.** That is a decision only you can make, and it parks the task
at once. A defect that can simply be fixed — of any severity, security and data
integrity included — is a finding, because there is nothing there to decide.

Each declaration is reviewed once: re-running `lazy review` yourself is never
required to reach an accept, and a review you start by hand is a second
opinion — it never counts towards the automatic rounds.

## The verdict is one of three words

Every review ends with **`clean`**, **`needs_work`**, or **`needs_human`**, and
lazy acts on that word mechanically:

| Verdict | What happens |
|---|---|
| `clean` | nothing to fix — acceptance is clear |
| `needs_work` | the task parks with the findings, or — with `[review] auto_fix` on — they become the next turn's brief, up to the two-round cap |
| `needs_human` | the task parks for your decision |

A `clean` that contradicts itself is not clean. If the review lists findings at
critical or high severity, or its security or data-integrity statement describes
a real problem, that problem holds acceptance whatever the verdict word says.

**Findings at medium or below do not hold acceptance.** They are recorded, they
are handed to the fixer when a round runs, and they ride along on a merge you
decide to make — a reviewer's opinion about work you are about to read anyway is
not a reason to spend an agent turn or interrupt a person.

Anything else — "approve", "LGTM", a sentence — is a **failed review**. The
reviewer gets one chance to restate its verdict, and if it still will not, the
review is recorded as failed: it is listed with a failure banner and it holds
acceptance exactly as `needs_work` would. A verdict nobody can act on is not a
pass.

A reviewer that crashes, or that never starts at all (a provider outage, a
runner that will not launch), is treated the same way: you see a failed review
rather than a task that quietly looks un-reviewed. A crash also releases the
task — whether the reviewer died loudly or its container simply vanished — so
asking for another review afterwards just works, and `lazy stop` can end a
review that is still running however the task's own status reads.

One thing is **not** a failed review: a review that was simply refused because
the task was busy. Only one turn runs on a task at a time, so a review asked for
while another turn — including another review — is running is turned away with
"the task is busy"; the automatic review waits and tries again, and the turn
that was already running is left to finish. Nothing is recorded against the task
for that, and nothing holds acceptance because of it.

To accept anyway, decide it yourself: `lazy accept <task> --allow-review-issues`.

## What the reviewer is

The reviewer:

- runs in a **short-lived container of its own**, mounting the **same worktree**
  as the task (it does not reuse the implementer's container or its command
  channel — the implementer's waiting supervisor cannot pick up the review)
- starts a **new session** — it does not resume the implementer's conversation
- is **read-only on the worktree**: Claude Code write tools are disallowed,
  Cursor runs in its native read-only mode, and most lazy write tools are not
  advertised — except **`lazy_raise`**, for the one `needs_human` decision
- records its issues as **findings** in its report, which lazy hands to the
  implementer as the brief for its next turn
- sweeps **security** and **data integrity** first, then correctness, tests,
  incomplete work, and style
- must say explicitly whether it found a security issue and whether it found a
  data-integrity issue (`none found` when that sweep is clean — silence is not
  a pass). A report that omitted those statements, or whose verdict is not one
  of the three words, is labelled `FAILED REVIEW (unparsed)` and holds
  acceptance. A sweep that names an issue no finding covers is recorded as a
  finding of its own, so it still reaches the fixer
- runs on a paused task (`blocked`, `conflict`, `submitted`, or `interrupted`).
  Finished tasks (`complete`, `abandoned`) are refused — their worktree is
  normally gone
- leaves the task in the status it found (submitted stays submitted)

```
lazy review <task-id>
lazy review <task-id> --yes --effort max
```

`--yes` skips the confirmation. `--no-wait` starts the review and returns
without waiting for the report. `--model` and `--effort` apply to this review
only and are not written back to the task.

## How long a review may take, and how to stop one

**There is no time limit on a review.** A large diff at high effort routinely
takes many minutes, and lazy lets it finish. The only guard is the ordinary
agent watchdog — the same one that catches a work turn that has stopped
producing output.

`lazy review` waits for the report and prints it. If you would rather not sit
there, interrupt the command: the review keeps running, and its report lands as
a `review` turn on the task (`lazy show <task>`, the Reviews tab, the task
page) with its findings on it.

To end a review you no longer want at all, **`lazy stop <task>`**. That stops
the reviewer itself, records the stop as the review's ending, keeps anything it
had already filed, and puts the task back in the status the review found.
The same goes for a question started with `lazy ask`.

Agents work the other way round: `lazy_review` and `lazy_ask` **start** the turn
and return immediately, and the agent waits with `lazy_wait` before reading the
turn. See [surface asymmetries](surface-asymmetries.md).

Issues live on the review turn as **findings**. After a review that found
something, the web Review dialog can start an **auto-fix** work turn that
injects those findings into the agent's brief; the agent fixes them, and says so
in its response if it thinks one is wrong — the next review then either agrees
or files it again. A `needs_human` decision is the one thing that arrives as a
Raise, and the agent replies to it with `lazy_raised_item_comment` (which does
not dismiss it — only you do that). MCP callers use `lazy_review` with the same
ownership gate as the other write verbs (own task or a direct subtask; the
builder is unrestricted). In the web UI, **Review** on the task page runs this
same verb; the **Reviews** tab lists every review, failed ones included. See
[the web review page](web-review.md#agent-review-from-the-task-page).

### Reviews stay on the task

**A review is never posted to a pull or merge request.** The report lives on
the task — `lazy show <task>`, the Reviews tab, the task page — and nowhere
else. That is true whether the PR is one lazy opened or one you
[linked](link.md), and there is no setting that turns posting back on.

Lazy writes only these things to a PR: it creates it (`lazy submit`), it keeps
its own delimited section of the description current, and — only when you turn
on `[remote] auto_approve` for a protected target that requires an approval —
it submits an approving review so the merge can go through. It also closes a
PR it tracks when you reject or close the task, or when `lazy accept` merged
the work locally rather than through the forge. It posts no comments, so
watchers of the pull request are not notified for every review round.

`lazy review --post` is still accepted so older scripts do not fail on an
unknown flag, but it does nothing and says so.

The former full-screen artifact browser is now `lazy browse` (including `-i`
for hunk-by-hunk Q&A).
