# Reviewing tasks in Lazy Teams

This page is for members of a Lazy Teams project who review agent work in the
browser. It walks through the task page: where you read what the agent did,
decide on any open questions, and give feedback or accept the work. When a task
is **waiting for you** (blocked), open it from your project's task list.

This matches the review experience in lazy's own web UI and CLI: structured
reports first, semantic diff walkthrough when the agent provided one, and raised
items that must be resolved before accept.

Inside a project, the top nav shows how much is waiting: tasks running and
waiting for you, tasks in the review queue, running clusters, open raised items
(blocking and not), and unread messages. A number the project could not report
is left off rather than shown as zero.

Press `Ctrl+K` (`Cmd+K` on macOS) on any project page to search the project and
jump straight to a hit; `Ctrl+Shift+K` (or typing `>`) lists the project's pages
and "Create new task", which opens the new-task form over the page you are on. Arrow keys move, Enter opens, Escape closes. The
last row always opens the full search page with your query.

## How the page is laid out

The task page has **eleven sections** you move between, and below them everything
you act with.

| Section | What is in it |
| --- | --- |
| **Record** | What the task is, what it has spent, and the agent's own report |
| **Regions** | The change carved into units of work, each with its own files and owner |
| **Changes** | The diff, and the conversation about individual lines |
| **Verify** | The agent's steps for checking its latest work, each with a **Verified** tick |
| **Turns** | Everything that happened, grouped and timed |
| **Commits** | What the task's branch recorded, newest first |
| **Comments** | Notes to the agent — saved now, delivered with your next feedback |
| **Journal** | The agent's record of what it decided and why |
| **Reviews** | Formal reviews an agent ran over the work |
| **Subtasks** | Tasks stacked on this one, grouped by where they stand |
| **Stats** | Where the time and the tokens went, per turn and per tool |

Which section you are reading is part of the page's address, so reloading keeps
you where you were and you can send somebody a link to the section you mean.

The section strip **stays at the top of the window** while you scroll, and the
header of whatever card you are reading — the file, the turn, the note — stays
just under it. However far down a long file you are, its name, its counts and
its **Viewed** tick are still on screen.

**Everything you act with stays below, on every section**: everything the agent
raised — the questions that must be answered before a merge and the notes that
need not be — the protected files, the feedback box, and the verdict. A task
waiting for your answer says so wherever you are reading, and the feedback box
is never a click away behind a tab.

At the top of the page, under the task's title, is a line saying what the task
**runs on** — its agent, its model, and how hard it is asked to think. A value
that came from the project's own default is shown faded, so the line never
presents a default as a choice somebody made. If the last turn actually ran on
something different, the line says that too.

The rest of the task's identity — branch, turn and commit counts, timestamps,
the prompt — is on the **Record** section behind **Details**, one click away
when you want it and out of the way when you do not.

## Moving through a review with the keyboard

A review is a list of cards — a file in the diff, a turn, a note, a section of
the agent's report — and reading one means working down that list. You can do it
without the scrollbar.

One card at a time is the **current** one, and it is outlined so you can see
which. Press a movement key and it moves; click anywhere inside a card and that
card becomes current. Scrolling on its own never changes it, so it stays a
reliable answer to "where was I".

| Key | What it does |
| --- | --- |
| `j` or `n` | Go to the next card |
| `k` or `p` | Go to the previous card |
| `v` | Mark the current card read and go to the next one |
| `v` on a card already read | Take the tick back, and stay where you are |
| `1` – `9` | Jump to that section (the first nine) |
| `[` / `]` | Previous / next section |
| `?` | Show or hide the list of shortcuts |

The **?** button in the section strip opens the same list, so you do not have to
know the keys to find them.

Three things worth knowing about how they behave:

- **They never fire while you are typing.** Every box on this page saves as you
  write, so a stray letter would not just appear — it would be saved. A keystroke
  aimed at a text box, or at an open dialog, is left alone.
- **No browser shortcut is taken over.** Every binding is a plain key with no
  modifier held, so your browser's and your operating system's own combinations
  keep working exactly as they did.
- **Moving to a card never re-opens it.** A card you have already ticked off
  stays collapsed when you pass through it; `j`, `k`, `n` and `p` mean "take me
  there", not "I am reading this again". Use the card's own chevron to re-open
  one — and note that doing so clears its tick.

Movement stops at the end of the section you are reading, because the next card
may be in a section that is not loaded. The section keys are how you move on.

## Linking somebody to a paragraph

Every heading in the agent's report, and every group in its walkthrough, has its
own address. Hover a heading and a **#** appears beside it; click that and the
link to exactly that paragraph is in your address bar, ready to send to a
colleague. It survives reloads, and it keeps working tomorrow.

The agent can use those addresses too. When it writes a walkthrough, it can link
from its own prose straight to a group of the change — so "the retry path" in a
report is a link that takes you to the retry path.

## Agent report

If the agent filed a structured end-of-turn report (`lazy_report`), it leads the
**Record** section as labeled parts — **What was done**, **Commentary**, and so
on — in the order the agent chose. It comes first because it is the summary of
everything the other sections hold. See [Structured turn reports](turn-reports.md)
for what agents can include.

The one part that is **not** in that list is **How to verify**, which gets a
block of its own — see below.

When there is no structured report, turn history still shows the agent's last
message in the **Turns** section.

### Screenshots

If the agent attached screenshots to its report, they render **above the prose**
— a picture of the result is usually the fastest answer to "what did this do".
They also lead the **Accept** confirmation page.

Click one and it opens over the page at full size, with its caption and its
position in the set. **←** and **→** walk the set and wrap around at each end,
**Esc** or **Close** dismisses it, and clicking away from the picture does too.
Because the overlay scales a picture to fit your window, **Open full size** is
there for when you need to zoom into a detail. With JavaScript off, clicking a
screenshot simply opens the picture in a new tab.

## Before the diff: how to verify, what is running, what was left alone

Three cards sit **above** the diff on **Changes**, and above the changes on the
**Accept** page. They answer the questions a diff cannot, and they are worth
reading before you start on the code rather than after.

### How to verify

The agent's own steps for checking the work: what to do, in order, with every
command in a panel of its own and a **Copy** button beside it. It goes wherever
the agent's report goes — the **Record** section and, in **Turns**, at the top
of the chunk the report belongs to — so wherever you are reading, you can find
out how to check the work without hunting for it.

Nothing on this card runs anything: it shows you the commands to copy. The
**Verify** section can run them for you (below).

If a command block is written in the console style, with each line starting
`$ `, the prompt markers are dropped — what you see is what you can paste.

If the agent gave no steps, there is no card. That gap is worth noticing: a task
whose work you cannot check is one to ask about.

#### The Verify section

The **Verify** section holds the same steps for the agent's latest turn, with a
**Verified** tick beside each one. Tick a step when you have checked it and it
folds away, the same way a file you have read does. Your ticks are yours: they
are saved with the rest of your review in progress, so they follow you to
another device and nobody else sees them.

A tick belongs to the step as it was written. If the agent rewrites a step in a
later turn, that step comes back unticked, because what you checked is no longer
what it says.

A command on the Verify section has a **Run in shell** button whenever you may
open a terminal on the task. Pressing it opens a new shell right beneath the
step, in your own environment for the task (see [Shell](#shell-working-inside-the-tasks-environment)),
with the command typed in and run. **Open** brings that shell back into view;
**Re-run** types the command into it again (or opens a fresh shell if that one
has closed). Blocks that are data rather than commands — JSON, source code,
output — get no button. When you cannot open a terminal at all (for example, no
Claude account is connected, or a turn is running), the section says why once,
above the steps.

Steps from earlier turns are kept under **Earlier verification steps**, folded
away and marked **superseded**. They were written for the branch as it was then,
so they may no longer be right. They are there for reference and cannot be
ticked.

### Services

What the task is serving and whether anything is answering on it — a green
**running** against each service the project declares, or **not answering** when
the port is published and nothing is behind it. When the task is not running at
all, the card says so once rather than listing every service as dead.

Each running service has an address of the form
`http://<service>.<task>.lazy.localhost:<port>` — the same name lazy's own
`lazy url` prints, on the port your project's daemon is reached on from the
machine running Teams. That name answers from a browser **on that machine**
(Chrome and Firefox resolve `*.localhost` to it without any setup) whether the
project runs directly on it or inside a microVM: the daemon carries the request
the last hop to the task's container itself.

The addresses are shown as **text, not links**, and the card says why: they
answer from a browser on the machine running Teams and from nowhere else, and a
link that opens for one reviewer and is dead for the next would be worse than
saying so.

Where a declared port is not being served at all, the card says exactly that and
stops — it does not guess at a cause, because it was not told one.

The card also shows the project's **Start services** command — the one command
that brings the project's services up in a task's shell — and members can
designate, change or clear it right there. It is one command for the whole project,
saved by the project's daemon; lazy does not edit your `lazy.toml` for it.
Like the rest of the card, this appears only when the project declares services.

### Maintained files

Your project can name file groups that are expected to be kept up to date as
work happens — documentation, a changelog — with `[[automation.maintain]]` in
lazy.toml. This card lists them, says which ones the change touched, and where
the agent decided a group needed **no** update, shows the reason it gave:

> **changelog** · not updated
> The agent says: Intra-release fix — nothing user-visible changed.

That is a judgement you can agree or disagree with in a second. It is the whole
reason the card exists: the same judgement buried in the turn history is one
nobody ever finds.

The reason shown is the agent's **current** one. If it judged the same group
over several sittings, what it said earlier is folded away under the current
reason rather than replacing it or being thrown out.

When you are looking at a diff **scoped to one region**, the card still lists
the groups and the agent's reasons but does not say which ones were touched —
part of a change is not the change, and it will not tell you something it cannot
stand behind.

## Changes (diff)

The **Changes** section shows what would merge if you accept the task.

Every task gets a **file view**: each changed file as a real unified diff,
grouped by what the file is — Documentation first, then Code, Tests, Generated
and Other — with the counts of added and removed lines on each file. Files that
match your project's **maintained file** patterns (`[[automation.maintain]]` in
lazy.toml) are grouped with documentation, above code. Documentation and code
open by default; the rest are collapsed and open on click. This is what you see
whether or not the agent said anything about its own diff.

When the agent declared a **presentation walkthrough** on its report, that leads
instead: semantic groups in the agent's order, with summaries and focused
snippets. Use **All files** to switch to the file view underneath, and
**Presented** to switch back. Paths the agent did not mention still appear under
**Other changes**, so nothing is hidden either way.

### Markdown files read as documents

In the file view, a changed Markdown file (`.md`, `.markdown`, `.mdx`) is shown
as the document it is rather than as `+` and `-` lines: unchanged stretches are
folded behind "N unchanged lines", changed passages are marked, and text that
was removed is shown struck through where it used to be. A new file is shown
whole; a deleted one shows its last contents.

The line diff is always one click away: **Source — comment line by line**
switches to it, and **Show rendered document** switches back. A very long file,
or one that cannot be read, simply keeps its line diff.

To ask about or comment on what you are reading, use **Comment** at the top of
the document, or the **+** beside a changed passage. The box opens right there.
A comment on the document is attached to its first line, and one on a passage to
that passage's first changed line, so the conversation appears on that line in
Source.

### Diagrams

A `mermaid` code block is drawn as a picture — inside a rendered document, and under its lines in any file's diff. Use
**Source** to read the diagram's text and **Diagram** to go back. A diagram that
cannot be drawn shows its source with a note saying so. **Comment** beside a
diagram asks about or comments on it, and the agent is given the diagram's
source along with your words. A diagram in a diff is attached to the line its code block opens on.

Diagrams in the agent's own report and in its walkthrough text are drawn the same way. There, **Comment** asks about the diagram as a passage of the report — the same conversation the **+** beside its source opens.

### Reading the lines around a change

A diff shows the lines that changed and a little of what surrounds them. Where
it skips the rest, a thin row sits in the gap saying how many lines are hidden,
with controls to bring them back: **↑** and **↓** reveal twenty at a time from
either end of the gap, and **↔** reveals the whole of it — up to the start of
the file, down to the end, or everything between two changes. The row disappears
once there is nothing left behind it.

Revealed lines are ordinary lines of the file: they carry their line numbers and
you can comment on them like any other. Nothing you have half-typed elsewhere is
disturbed by revealing more of a file.

Only whole files offer this. A walkthrough snippet is a window the agent chose,
and what sits just outside it may be part of the change rather than background —
use **Full file** beside the snippet to read around it.

### Ticking a file off

Every file carries a **Viewed** tick and a chevron beside its name. Ticking it
folds the file to its header line; the chevron folds and unfolds without
claiming you have read it. The two views show the same files, so a file ticked
in the walkthrough is ticked in the file view as well — there is one answer to
"have I read this", not one per view.

Ticks are remembered **for you, on the task**, so they survive a reload and are
there when you pick the review up on another device. A tick remembers what the
file SAID: if the agent changes that file afterwards, it comes back unticked and
open, rather than claiming you read something that is no longer there.

Each tick stands on its own. Ticking one file never disturbs the others —
including ones you ticked in another tab, or a moment earlier on a page that was
still loading.

Turns, comments and journal entries work the same way. None of them scrolls
inside itself — a long report grows the page and you fold it when you are done
with it, instead of reading it through a small window.

## Commenting on a line, and asking about one

Hover any line of a diff and a **+** appears beside it. Click it and the comment
box moves to that line, labeled with the file and line it is anchored to. There
are three things you can do with what you type:

| Button | Effect |
| --- | --- |
| **Ask the agent** | Puts the question to the paused agent now and shows its answer on that line. Nothing in the work changes — it is a read-only turn, and it spends your own Claude credential |
| **Add comment** | Stores the note on that line. It travels to the agent with your next feedback, along with everything else you wrote |
| **Unblock** | Stores the note on that line, then resumes the task so the agent starts working on it now. If the task cannot be resumed, the note stays queued and the page says why |

The same row appears in the task-wide question box and in the box under the
**Verify** tab's steps. There, **Add comment** leaves a note on the task that reaches
the agent on its next turn, and **Unblock** sends your words as feedback. Words
typed on the Verify tab say so, with the turn number. Any button you cannot use
right now is greyed out, and hovering over it says why.

Answers and notes render in the diff, in the row under the line they are about,
newest last, each naming who wrote it.

**Ask** works whatever state the task is in. A task that is paused is answered by
the agent paused in it; a task that is over, or busy, is answered from what lazy
stored about it, and the answer says which it was. The one question that cannot
be answered is one about a task that has never run — there is nothing recorded
to answer from.

When a question cannot be sent, it is stored on its line rather than thrown
away, with the reason on it and **Send to agent** to put it through later. The
words are always saved before the question is sent, so nothing you typed is lost
to a failure. Your own message can be pulled with **Take it back** for as long as
it has not reached the agent.

If the lines a conversation was anchored to are no longer in the diff — the
agent changed them since — the thread still shows, marked as no longer anchored,
with the snippet it was written against.

### Replying to a conversation on a line

An answer you want to follow up on has **Reply** under it. That moves the comment
box into the conversation and labels it *Replying on file:line*, so what you send
next joins that exchange instead of starting a second one on the same line — the
agent reads your follow-up with the question and answer it follows up on.

The same two buttons send it: **Ask the agent** for an answer now, **Add comment**
for words that wait and travel with your next feedback. If you decide the words
belong on the line rather than in the conversation, **Comment on this line
instead** drops the conversation and keeps everything you have typed. **Cancel**
is still the only control that discards a box, and it says so.

If that line already had an unsent comment of yours, the two are **joined rather
than replaced** — your earlier comment first, then what you had written as a
reply — and you see the combined text in the box straight away, to edit or trim
before you send it. Nothing you typed is ever overwritten by moving a box.

A reply you leave half-written is listed with your other unsent comments, marked
as a reply to a conversation rather than as a plain comment on the line, so the
two never get mixed up.

### Whether your note got there

Every note of yours says where it has got to, so you never have to send another
one just to find out:

- **Pending — rides the next unblock.** Saved, and travelling with your next
  feedback. You can still take it back.
- **Delivered in turn N (how long ago).** The agent read it in that turn. There
  is nothing to take back — say so in your next feedback instead.

Questions are different, because they are answered as you ask them. A question
of yours stays in the list as **open business** until you submit a review — your
unblock, or your accept — at which point it moves into **Filed asks**, collapsed
on the same page. Nothing is deleted: the question, the answer and their state
are one click away, exactly as they were. A question the agent has *not* taken —
one still in flight, or one whose send failed — is never filed, so it stays in
the list until it is answered. Nor is a conversation filed while it still
carries a reply of yours waiting to be delivered.

### Turning a discussion into a task

A question about the task as a whole often names the work the task did *not*
do. Once such a question has an answer, **Promote to a task** under it opens a
form seeded with the whole exchange: a goal taken from your question, a
suggested code, and a prompt carrying the question and answer verbatim. Edit
any of it, choose whether the new task is a **subtask** of this one or a
**sibling** beside it, and press **Create task**. The task lands in the backlog
and nothing starts until you start it. A discussion is promoted once; afterwards
it links to the task it became.

### Asking about a section of the walkthrough

A rendered walkthrough has no line to hover, so each group carries **Comment on
this section**. It opens the same box, anchored to the first line of the first
file the group is about, and says which line that is so you can pick a more
precise one if you want. A group that is only prose has no line to attach to;
it says so, and points you at the task's own question box below.

### Asking about a sentence of the agent's report

The agent's words take comments too. Hover any paragraph, list item, heading or
code block of the **Agent report** on Record — or of a walkthrough group's own
text on Changes — and the same **+** appears. The box opens under that passage
and quotes it; **Ask the agent** and **Add comment** work exactly as they do on
a diff line, and the agent is given the passage you quoted along with your
words.

The conversation then shows under the passage, with **Reply** to continue it.
Screenshot captions take comments the same way.

A conversation with no passage on the page to sit under is never lost: it is
listed under **Conversations not shown beside a passage**, below the report,
with the words it was written on and the reason — the agent reported again and
the wording changed, or it is about something this page shows without a
comment box, such as the verification steps or an item the agent raised.
Conversations recorded on the task before the project moved to Lazy Teams
appear the same way: under their passage, or in that list.

### Words you typed and have not sent

Anything you type into a comment box is **saved as you type**, on the task and
for you alone. Close the tab, reload, come back tomorrow on another machine —
it is still there. Moving to another section takes what you have typed with it,
even if you switch the moment after typing it.

If a save cannot get through, the page keeps trying on its own. It only ever
says "saved" when it is; if it genuinely cannot reach your work's store it says
so and keeps saying so, so the page never quietly shows you something that was
not kept. The same goes for the **Viewed** ticks, which have nothing on screen
to show you they are only local.

And if your unsent work cannot be **read back** — the store is unreachable when
the page opens — the page says that too, rather than showing you an empty list
and letting you conclude it is gone. An empty list means empty; it never means
"we could not look".

Unsent comments are listed at the top of **Changes**, each with the file and
line it belongs to and what you wrote. **Continue** puts the box back on that
line so you can finish and send it. They are listed rather than silently
re-opened down the page, because a box you cannot find is no better than one
that was thrown away.

A box goes away when its words are **sent**, or when you press **Cancel** on it.
Nothing else drops it: a question the agent refuses, a failed send, a switch
between views, moving the box to another line — all leave your words where they
were.

While an administrator is looking at Teams as somebody else, none of this is
read or written. Unsent words are that person's.

## Questions and notes from the agent

Agents raise two kinds of thing, and every item says which it is:

| Badge | What it means |
| --- | --- |
| 🛑 **Blocking — gates accept** | A decision that must be made before the work can merge — a scope call, a semantics choice, a "confirm before I proceed" |
| ⚠️ **FYI — never gates accept** | Something you should see. Decide it whenever you like, or leave it open |

They are one list, blocking first, so you read what stands between you and a
merge before what is merely proposed.

For each open item, choose:

| Decision | When to use |
| --- | --- |
| **Respond to agent** | You are deciding — add a short note, which the agent reads on its next turn |
| **Promote to subtask** | The answer is more work: create a child task from it (it never auto-starts) |
| **Promote to peer task** | Same, as a sibling rather than a child |
| **Acknowledge** | You saw it and the agent's default is fine |
| **Dismiss** | Not worth pursuing — add a reason |

**Only an open blocking item holds up accept.** An open FYI never does. The
**Accept** confirmation page asks for a decision on each blocking item and
merely offers the rest, so you are never made to dispose of a note to get the
merge through.

Every decision you make then says where it has got to, because nothing here
starts a turn on its own:

- **Pending — rides the next unblock.** Saved, but the agent has not been given
  it yet. **Undo** works for exactly as long as this is true; for a promotion,
  the new task is created then too.
- **Delivered in turn N.** The agent read it in that turn. There is no undo —
  it has been read, so the only honest correction is saying so next time. A
  promoted item links straight to the task it became.

Decided items stay on the page either way.

See [Raised items](raised-items.md) for the full accept-gate rules.

## The Raised queue

Questions that gate a merge and notes about orthogonal work are the same thing
with one flag on it, so they are one queue. The project nav has a **Raised**
page: every item an agent has raised, across every task in the project.

The tab carries two counts, and the order is the point — **open and blocking**
first, then **open FYI**. The first number is the only one that can stop a
merge; the second is real work, just never this minute's.

The page lists blocking items first, each with the same badge it wears on a task
page. Filter to **Blocking** or **For information**, and narrow further by
whether an item still needs attention, whether its task has finished, or whether
it recurs — near-duplicate items are grouped into one row, whether they were
raised on different tasks or on the same one, and **Recurring only** shows just
those.

Every row carries a toggle for the flag itself: **Make it blocking** on a note
the merge really should wait for, **Make it an FYI** on a question that turned
out not to matter. The agent chose the flag when it raised the item; this is you
overriding that, and Lazy records who did.

On a row standing for a group of near-duplicates the button says **Make this one
blocking** instead, because that is what it does — each item in the group gates
its own task, and the toggle moves one of them. The count on the row ("recurring
×3") is the size of the whole group, however few of its items the filter you are
looking through leaves on screen, and the toggle's tooltip counts the same group.

When the members of a group do not agree about gating, the row says how they
stand ("1 of 3 blocking") rather than letting one badge speak for all of them.
That line appears only while the page can see every item in the group: a filter
that hides part of one — the **Blocking** and **For information** lenses hide
half of a group that disagrees, and the default view hides items already decided
— leaves the row with nothing to say about it, because the only count it could
make there would be a count of the filter rather than of the group.

Open a row for the whole item, anything similar to it, the same flag toggle, and
the same five decisions the task page offers. A promotion made here creates the
task straight away and takes you to it, so you can start work on it at once;
one decided on a task page rides the agent's next turn instead.

Two things live on the task page rather than here: **Undo** (the queue cannot
tell a decision the agent has already read from one still queued) and the diff
the item is about.

`/follow_ups` — the address this page used to have — redirects here.

See [Raised items](raised-items.md) for the full accept-gate rules and what each
decision means.

## Clusters

Some tasks do not do the work themselves: a **cluster** creates subtasks and
drives them — deciding which of them can run at the same time, reviewing each
one as it comes back, then accepting it. The project nav has a page listing
every cluster with how far it has got: how many subtasks have landed out of the
ones still expected, which are running, which were set aside, and every subtask
with its status. The same line sits at the top of a cluster's own page.

Those numbers are worked out from the subtasks each time a page is drawn, so
they stay right whether the cluster accepted a subtask or you did. See
[Cluster tasks](cluster-tasks.md) for what a cluster is and how one behaves.

## What is still outstanding on your review

Under everything you act with, a line reports what you have left in flight on
this review: **comments queued** (notes you have written that have not been sent
— they travel together with your next feedback) and **asks awaiting an answer**
(questions the agent has not replied to yet). While a task is waiting for you
and the agent gave verification steps, the line also says how many of them you
have ticked: **N of M steps verified**. On a cluster task the same line carries
the cluster's progress.

Anything with nothing to report is simply not there. The line is absent
altogether on a review with nothing outstanding, rather than reporting zeroes —
those two numbers are about your review, never about the project's work, and a
row of zeroes reads like a queue that has stalled.

One exception: a counter that has counted something stays visible once it
reaches zero. When your last queued comment is delivered or your last open ask
is answered, the line keeps showing "0 comments queued" or "0 asks awaiting an
answer" instead of disappearing — you can see your feedback drain to zero
rather than watch the row vanish mid-review. Only a counter that has never
counted anything is hidden.

## Protected files

Some files are protected: the agent may read them but is not allowed to leave
them changed without a person saying so. When a task changes one, it stops and
waits for you, and the task page lists the files under **Protected files**.

There is one moment the decision is made, and it is the merge.

**Resuming the task.** The files are listed next to the feedback box and
nothing is asked about them. Resuming changes nothing about them — the work
carries on with the agent's version, and the decision is still owed. If you
want one put back, say so in your feedback: asking the agent to revert it is
the only way it leaves the branch.

Where the agent gave a reason for keeping a file, it is quoted under the file's
name. It is an argument addressed to you, not a decision: the file is still
waiting either way.

**Accepting the task.** Accept is all of them or none: the confirmation page
lists every file still waiting and asks you to confirm, in one tick, that the
agent's version of **every** one of them should be merged. There is no per-file
choice — to drop one, resume the task and ask the agent to revert it first,
then accept.

The list is the whole branch's, not the last turn's: a file changed early and
never looked at again is still on it. If you try to accept with one of them
unsettled, the merge is refused and the refusal names the files.

A decision is final for the file it settles: once kept, a file stays kept, and
a later merge is not asked about it again. Files already settled are listed
under **Already decided** so you can see what was chosen.

While files are waiting, the ahead-of-time accept check does not run — the page
says so. Anything else wrong with the merge is still refused when you confirm.

## Give feedback

Below the work are three tabs — **Unblock**, **Ask** and **Accept**. Unblock is
the feedback box described here, Ask is for questions about the task as a whole,
and Accept is the same confirmation page as the Accept button further down, put
within reach so you do not have to scroll for it.

Below the work is the feedback box: write what you want changed, optionally
adjust how hard the agent thinks, and send it. The task resumes
with your words as its next instruction. Your feedback is recorded the moment
you send it, before anything else can fail.

What you have typed but not sent is saved as you go, and so is an accept reason
you started writing. Leave the page, open the task on your phone, come back
tomorrow — the words are still in the box. They are yours alone: another member
reviewing the same task never sees them, and they are cleared only once they
have actually been delivered to the agent.

### Asking about the task, and replying to an answer

Not every question is about a line. The **Ask** tab has a box for questions
about the work as a whole — the approach, the scope, why a trade-off went the
way it did — and the conversations it has produced are listed above it, with the
agent's answers. As with a line question, the agent answers without changing
anything, and it spends your own Claude credential.

**A task that is over can still be asked**, which is when most questions about a
piece of work get asked. Once a task is finished, abandoned or has not started,
the same box is on its page under **Ask about this task** rather than in the
feedback tabs — there is no feedback to give a task that is over, but there is
still plenty to ask about it.

An answer to such a question does not come from the agent that did the work: that
agent has finished and its working copy is gone. It is read from what lazy kept —
the task's turns, the questions it raised, its commits and its diff — and the
answer opens by saying so. Asking changes nothing: a finished task stays
finished, and nothing you have queued for some later turn is used up.

The other half of the box says something different there, because it has to. A
note is handed to the agent at the start of its **next turn**, and a task that
has ended has no next turn — so on a finished task it reads **Leave a note on
the record**, and that is what happens to it: it is kept with the task and rides
the next turn if the task is ever reopened.

An answer you want to follow up on has **Reply** under it. That moves the box
into the conversation, so what you write next reaches the agent as the next
message in it, with the question and the answer behind it — rather than as a new
question standing on its own.

A reply can go to one of two places, and you pick with the button you press:

- **Ask the agent** gets you an answer now. It runs a turn on your own Claude
  credential, and the agent answers without changing any code.
- **Leave a note for next time** changes nothing now. The note is saved and
  handed to the agent at the start of its next turn, along with everything else
  you have queued. Reading an answer and wanting to say "alright, do that" is
  the common case, and it does not need to interrupt anything.

A note never starts a turn, so it works whether or not the agent is free, and it
does not need a Claude credential of your own. The second button appears only on
a reply: a note about the work as a whole that answers nothing is what the
**Unblock** message box already is, so there is deliberately no second way to
write one.

Changed your mind halfway through writing? **Ask about the task instead** takes
the box back out of the conversation and **keeps every word you have typed** —
it changes where your question is going, not what you wrote. The box says which
it is at all times, so you always know whether your next send joins a
conversation or starts one.

Questions you asked in an earlier round of review are folded away under **Filed
asks**, in full. They are a record of a conversation that is over: to pick one of
them back up, ask again in the box.

## Starting, resuming and reopening

Not every task arrives waiting for feedback. A task can be sitting in the
backlog having never run, paused with nothing more to say to it, or finished and
wanted back. The task page has one control for each, shown only when the task is
actually in that state:

| Control | When it appears | Effect |
| --- | --- | --- |
| **Start** | The task has never run | Gives the task its first turn |
| **Resume** | The task is paused and you have nothing to add | Runs the next turn with no new instruction |
| **Reopen** | The task is finished or withdrawn | Brings it back so it can run again |

A task lands in the backlog whenever it was created without being started — a
promoted raised item, a replacement for a stale task, anything created from the
CLI. Its page says so and offers **Start**.

**Resume** is the counterpart of the feedback box: use it when the agent should
carry on and you have no correction to give. Whatever was already said to it
still stands.

**Reopen** is folded away and asks you to confirm, like the other controls that
change a task's fate. Reopening a task that was accepted needs a reason — it
goes on the task as a note. Reopening runs nothing by itself: the task comes
back so you can start it or send it feedback when you are ready.

**Start** and **Resume** run the agent, so they spend your own Claude
credential and are offered only if you have connected your Claude account. If
you have not, the page says so and points you at connecting one, exactly as
creating a task does. **Reopen** runs nothing and needs no credential.

Starting a task is real work before a single word is read: the agent's
surroundings are built first, and the very first task on a project can take a
few minutes while its container image is built. You do not wait for any of it.
The page opens straight away and says the task is starting, the controls that
would start it again are put away, and the page brings itself up to date as soon
as the turn begins. The same is true of **Create and start** on the new-task
form — it lands you on the new task immediately. If the task cannot be started
at all, the page says why, and it still says so after a reload — until the task
is running, or your attempt is old enough not to be news. The reason is kept in
the task's own record of who asked for what, so it is there to read afterwards
either way.

A task is started once however many times you press. Two clicks in quick
succession, or the same page open in two tabs, run one turn and not two — the
second press is told the task is already starting. And a start that somehow
never gets anywhere does not strand the task: the page goes back to offering
**Start** rather than saying "starting" forever.

## Deciding: accept, reject or close

The three verdicts live together at the bottom of the page, under **Decide**:

| Verdict | Effect |
| --- | --- |
| **Accept** | Merge this work into its parent |
| **Reject** | End the task because the work is wrong — needs a reason |
| **Close** | Withdraw the task because it is no longer wanted — needs a reason |

**Accept** is the button; **Reject the work** and **Close the task** are folded
away and open when you choose one. Both still ask you to confirm — folding is
about weight on the page, not about removing the safeguard. On a phone, Accept
is also on the action bar at the bottom of the screen so you do not have to
scroll to reach it.

Which verdicts appear follows the same rules as the CLI: **Close** is offered
on any task that is not finished (including one that was never started);
**Reject** only when the task has actually run (it needs a session); **Accept**
when the task is waiting for review. A finished task says there is nothing left
to decide instead of showing empty controls.

**Accept** opens a confirmation page. It shows merge targets, warnings from
preflight, open raised items (if any), and the same **Changes** view as the task
page. Resolving raised items on that page applies your decisions as part of the
accept — not as a separate step beforehand. Confirming starts the merge in the
background; the task page updates when it finishes.

Protected-branch passphrase approval is not available in Lazy Teams — the
passphrase is entered only at a terminal, so those merges must be completed
from the CLI when the gate applies.

## More to do with this task

Below the verdict is everything else the page can do with a task. None of it is
a verdict, which is why it is not up there next to **Accept**, and the two that
change what tasks exist are folded away so they cannot be pressed by accident.

**Ask the agent to review its work** sends the agent back over its own change
before you read it. It reads what it wrote and files what it finds on this page,
as questions and notes — it does not change any code. This runs a turn, on your
own Claude credential.

**Make a copy of this task** creates a new task beside this one with the same
goal, the same prompt and the same agent and model, and none of the history. The
copy goes to the backlog and runs nothing until somebody starts it; this task is
not touched. You land on the copy, and the page names it.

**Start this task over** is for work that went wrong from the beginning rather
than partway through. This task is closed and a fresh one takes its place,
carrying the same prompt plus a summary of what this attempt did — so the next
run does not repeat it. The branch is kept, and the replacement starts nothing on
its own. A reason is required: it becomes the closed task's closing reason, and
the only explanation the record will carry.

A shell, a paired session, a chat with the agent and the Watch panel are not
here either: they are on the **Shell** tab, each in your own environment for the
task (see [Shell: working inside the task's
environment](#shell-working-inside-the-tasks-environment)).

## Submit: opening a pull request

**Submit…**, in the task's header while it waits for review, pushes the task's
branch and opens a pull request (or merge request) for it — the same as
`lazy submit`. The confirmation page first says which branch the pull request
targets and whether that branch is protected on your forge. Into a protected
branch you tick a box; into an unprotected one you type the branch name or the
task code, because accepting would merge it directly and a pull request is
probably not what you meant. If the task cannot be submitted — no forge
connected, nothing to send — the page says why.

The push and the pull request use the forge connection the project is connected
through, never credentials from your own machine. Submitting runs no agent and spends
nothing on your Claude account.

## Reparent: moving a task under a different parent

**Reparent…**, in the header of any task that is not running or finished, moves
the task under another task or branch — the same as `lazy reparent`. Pick one
from the suggestions or type it. The task's branch is then synced onto its new
parent straight away, which runs a turn on **your** Claude account, like
**Sync** below. A task that has not started yet simply branches from the new
parent when it does.

## Sync: bringing the parent's work in

**Sync** merges the task's parent branch into the task's branch. Use it when the
parent has moved on since this task started — most often when an accept is
refused because the task's branch is behind, or because a merge in the task's
worktree was left unresolved.

It is one press with nothing to fill in. The agent runs the merge and resolves
any conflicts, so the task shows as working until that turn finishes and the
page updates itself. If there was nothing to merge, it says so instead. When the
parent branch exists both locally and on the remote and the two disagree, the
answer includes a warning saying which one was used.

Sync is offered on a task that is paused — waiting for review, interrupted, or
stopped part-way through a merge — and not on one that is currently working.
When an accept is refused and a sync is the fix, the **Sync** button appears in
the refusal message itself, so you do not have to go looking for it.

## Turns

Turn history is grouped into **chunks** — one human intervention plus every
automation turn that followed. Chunks appear **newest first**; turns inside each
chunk stay in chronological order. Each chunk says when it opened and how long
it ran, so you can see at a glance whether the agent was working for twenty
minutes or twenty seconds. When a chunk matches the agent's structured report,
the report is shown once at the top of that chunk instead of repeating the
agent's prose turn.

The grouping comes from lazy itself. On an older project daemon that does not
send it, the turns are listed one by one instead, oldest first, and the section
says so — you lose the grouping, never the transcript.

## Comments

A **comment** is a note on the task: context, a correction, a decision you made.
It is saved and nothing else — it never starts a turn. The agent reads it in the
prompt of whatever feedback comes next, which is what makes it the right place
for something that is not itself an instruction to get back to work.

The section shows the comments oldest first, in two groups: the ones the agent
has already been shown, and the ones still queued for its next turn. The split
is lazy's own record of what it last delivered — the same answer its web UI
gives — rather than a guess from the timestamps, so "seen" means the agent
really did read it in a prompt. A comment that came from a pull request is
marked as such.

The two group headings count **every** comment on the task, not just the ones on
screen. A very long thread does not fit on one page, and the section then shows
you the most recent end of it — everything still queued, and as much of the
delivered history as fits — with a line saying how many of how many you are
looking at. Nothing queued is ever off the page.

You can leave a comment whatever state the task is in, finished ones included —
annotating a task after it is over ("superseded by the follow-up", "the branch
was lost") is one of the main things comments are for. On a finished task the
page says so plainly: nothing will carry it to an agent unless the task is
reopened, and until then it is a note for the people reading this later.

## Journal

The **journal** is the task's out-of-prompt record: why something was decided,
what was stubbed, what was deferred to somebody else. Agents write it as they
work, and nothing in it is ever fed back into an agent's prompt — a later turn
is told only that entries exist and reads them if it wants to. That is the whole
difference from a comment: a journal entry informs, it does not instruct.

Members can append Markdown from the **Journal** tab. Saving an entry does not
start or resume a turn, and the entry body is never copied into a later prompt.
The member who saves it is recorded from their signed-in identity.

Entries are newest first, the same order as Turns.

## Reviews

The **Reviews** section lists each formal review an agent ran over this task's
own work: its verdict and its explicit security and data-integrity statements. A
review that filed questions links straight to them, so you can get from "a
review happened" to "and here is what it found" without hunting.

Only reviews that **counted** are listed, which is the same set lazy's own web
UI shows and the same set the accept gate reads. A review that recorded nothing
usable — no questions, and sweep statements that could not be read — is treated
as never having run, and does not appear. A review whose statements could not be
read but which did file questions still counts: it is listed, with a line saying
a statement was unreadable, so the questions are not lost with it.

A review that filed no questions is labelled **no questions filed** — not
"clean". The distinction is deliberate: a review can write findings out without
filing them as questions, and those are not shown here, so "no questions" is
what this list knows and a clean bill of health is not. The review's own verdict
and sweep statements are printed above it; read those.

Reviews here are a record, not a place to act — what a review found is answered
with the task's raised items, where every other question on the task is.

See [Agent reviews](review.md) for what a review is and how one is run.

## Stats

The **Stats** section is where a task's time and tokens went. It is last in the
strip because it is something you open on purpose rather than a step in
reviewing a change.

Four figures at the top — turns, elapsed time, tokens and commits — each with a
line under it saying what qualifies the number ("still running", "5/6 turns
reported usage").

**Where the time went** splits the task's life into three: an agent running,
waiting for a person, and sitting in the backlog. This is wall clock taken from
the task's recorded history, not time an agent spent thinking — a task left
waiting overnight really did spend those hours waiting. Per-turn thinking time
is not recorded anywhere, so it is not shown. If the task has subtasks, the page
also says how much of its own running time overlapped a subtask that was itself
running: a parent waiting on a subtask still counts as running. That figure
comes with a percentage, and it is a share of **this task's own running time** —
not of everything its subtasks ran for — so it reads the same whichever of the
two views below you are in.

**Tokens** breaks the spend into input, output, cache read and cache write, as a
chart per turn, a second chart of the running total, and a foldable table of
every turn with its model and the gap before it.

**Tools** is what filled the conversation: how many times each tool was called,
how many tokens its results added, its share of the total, its average per call
and how many came back as errors. "Tokens" here is the size of what a tool put
into the conversation, counted once per call — it is context the tool added, not
a share of what the model charged, and a request's own usage is never divided
across the tools it carried, because that would be a guess. These cover the
task's whole life; nothing in them expires.

**By model** groups the turns by the model each ran on.

### One task, or everything under it

A task with subtasks can be read two ways, and a toggle at the top switches
between them:

- **This task only** — its own turns, its own time, its own tools.
- **Including subtasks** — the task and every task nested under it, at any
  depth.

Both are ordinary links, so either can be bookmarked or sent to somebody.

One number is worth reading carefully in the rolled-up view. **Time is combined
as a union, not a sum**: the bar shows wall clock during which at least one of
the tasks was in that state, so a parent and a child running at the same moment
count once rather than twice. The timesheet-style total — each task's running
time added up — is given separately underneath, along with how much of it was
time two or more tasks ran at once. Both are true; they answer different
questions.

A task with no subtasks shows no toggle, because both views would be the same
numbers.

### What the page will not claim

**Nothing is priced.** Stats reports tokens and shares of tokens and never a
figure in any currency. Lazy has no price list, and one written into a page
would go out of date without anybody noticing.

**Nothing missing is shown as a zero.** The three cases each say what they are:

- A task lazy never recorded tool statistics for says so, and says it is not a
  claim that no tools were called — it may have run before lazy kept them, or
  its traffic may not have gone through lazy.
- A turn whose agent reported no token usage keeps its row and reads "not
  recorded". It was not a free turn; nobody wrote down what it cost.
- A tool whose results were never sized shows no token count and no per-call
  average, and the page says how many results that covers.

Stats does not say **whose account** paid for a turn: that is not recorded
with a turn's usage, and the page shows nothing rather than guessing.

## Shell: working inside the task's environment

The **Shell** tab, last in the strip, opens terminals on the task. Everything
here runs on the server; your browser only shows the terminal.

- **Shell** opens a new shell. Open as many as you like; each has its own
  **Close**.
- **Pair** takes over the agent's own session, so you drive it. If your
  connection drops, pairing ends by itself within 30 seconds. Pair is not
  offered while the agent is mid-turn or while somebody else is already
  pairing. (Like any open terminal, it also holds the task — see
  [Taking turns with the agent](#taking-turns-with-the-agent).)
- **Chat** is a conversation with the agent about the task. It doesn't take
  over the agent's session and leaves the task's model alone, but like any
  terminal it keeps turns off the task while it is open. It is offered only
  while the task is waiting for you.
- **Watch** shows what the agent is doing right now — its requests, what it is
  running and its own session — as it happens. It is read-only.

### Your own environment

Your terminals never run inside the agent's environment. The first one you open
starts an environment of your own for the task: the task's image, with the
task's files (its checkout, and the agent's saved session, which Pair takes
over) — and nothing else of the agent's. Processes the agent left running are
not in it, and nothing you run can see the agent's credentials or reach lazy on
its behalf. All your terminals on the task share that one environment, so a
server you start in one shell is reachable from another.

Its settings are lazy's own, not the agent's. The agent's configuration (the
hooks, MCP servers and git settings in its home) is not carried into your
environment. Pair and Chat also start Claude Code so that it ignores the task's
own `.claude/settings.json` and any MCP server lazy did not configure. Your
Claude credential only works from your environment (on a Linux server, which
is where Lazy Teams runs; lazy on macOS or Windows cannot tell environments
apart this way): copied anywhere else, the
request is refused.

**What you run is yours to judge.** The task's files are the agent's work. If
you run the project's scripts, tests or build in Shell, or start `claude`
yourself there (which reads the project's own settings), you are running code
the agent wrote, with your credential in the environment. That is the same as
checking out a colleague's branch and running it. Read what you run.

About 30 seconds after you close your last terminal, the environment is
discarded, together with anything still running in it. There is nothing to
start beforehand and nothing to clean up afterwards. The first terminal can take
a moment while the environment starts.

**What your environment shares with other tasks.** The agent of this task is
stopped while you work, but other tasks' agents keep running, and a few things
are common to all of them and to you:

- the project's git object store, which you and they can write (new commits and
  objects are added there by everyone);
- the project's repository, read-only;
- only those of the extra directories and volumes the project mounts into every
  task (`[[mounts]]`, or mounts in `[docker] run_args`) that are **read-only
  for every task** — `readonly = true` in the configuration, unless the same
  storage is writable to the agents through another entry. A read-only
  directory inside one the agents can write (or one that contains it), a volume
  that another entry mounts read-write, and anything inside the tasks' own
  working copies all count as writable.

A shared directory or volume the agents can write is **not in your environment
at all**. Whatever another task's agent wrote there would appear in your
terminal immediately, and a program it left there could run next to your Claude
account. If a cache or toolchain you expect is missing from your terminal, that
is why: ask a project admin to mark it `readonly = true` if every task only
needs to read it.

Services you start (a dev server, a database) run in your environment for as
long as your session lasts. Your environment has a network of its own, so they
are reachable from your own terminals only — not from the agent's turns, and not
through the task's service links — and nothing the agent left listening is
reachable from yours. For the same reason, the project's own container settings
for networks, published ports, host names and DNS (`--network`, `-p`,
`--add-host`, `--dns` and the like in `[docker] run_args`) are not applied to
your environment; its other settings, such as memory limits, are.

**The task's environment variables are not set in your terminals.** The ones
set with `lazy env set` reach the agent's turns only. Many variables make a
shell, an editor, a language runtime or git run something as soon as it starts,
and anyone who can set a task's variables could otherwise run code in your
terminal, next to your Claude account. If a service you start needs a setting,
set it in your terminal yourself.

### What carries over to the agent

What you change in the task's **files** stays, exactly as if you had edited the
checkout yourself: edited and new files, and the git state of the task's own
checkout (what is staged, which commit is checked out). The agent's next turn
sees all of it. Nothing else does: not your processes, not your shell history,
not anything you installed outside the checkout.

That includes the **agent's own home configuration**, which lives inside the
checkout, in `.lazy-task-sandbox/`: its Claude Code settings and hooks
(`.claude/`), the MCP servers listed in `.claude.json`, and its `.gitconfig`.
Your terminals never use it — your environment has a home of its own — but the
agent's next turn loads whatever is there. Change it only if you mean to change
how the agent runs.

The same directory holds the **agent's conversation transcripts**, including
earlier Pair and Chat conversations on the task, whoever had them. They are
readable from your Shell, as they are to anyone who can open a terminal on the
task.

**You can't `git commit` from your terminal** — Shell, Pair or Chat. The
project's branches are read-only in your environment, so a commit fails. Leave
your changes uncommitted, or stage them with `git add`, and the agent's next
turn picks them up; or close your terminals, then unblock the task and ask the
agent to commit them.

### Who pays, and who is named

Every terminal runs **as you**. Anything you or the agent do in it uses your own
Claude account — never a key the project configured, and never another member's
— and what it records, such as a pairing session starting and ending, names you.
If you have no Claude account connected, the tab says so and links to where you
connect one. Because Pair and Chat run on your account, they are offered only
for a task whose agent is Claude Code on Anthropic's own service; on a task that
runs another agent, open a **Shell** instead.

In Pair and Chat the agent cannot use lazy's own tools (committing, raising
questions, starting subtasks), and cannot `git commit` either (see above).
Commit your changes by closing your terminals, then unblocking the task and
asking the agent to; or leave them for its next turn.

### Taking turns with the agent

- Nobody can open a terminal while a turn is running on the task; wait for it
  to pause.
- While **any** of your terminals is open — Shell, Pair, Chat or Run in shell,
  not only Pair — the task is held: no turn starts (unblocking or resuming it is
  refused with your name), and it cannot be synced, accepted, rejected or closed.
  An automatic sync waits and runs afterwards. All of it works again once your
  session has ended, about 30 seconds after you close your last terminal.
- Opening your first terminal stops the agent's own environment, and it stays
  stopped until your session has ended. Anything a turn left running there — a
  dev server, a file watcher — stops with it, so nothing of the agent's runs
  beside you. Its next turn starts it again as usual.
- One person at a time can work in a task, with as many terminals as they like.
  The tab says who it is.
- A terminal left open doesn't hold the task forever. It closes after an hour
  with nobody typing in it — even if something in it is still printing output,
  such as a dev server's log — and after twelve hours in any case. Open a new
  one to carry on.

## Related

- [Structured turn reports](turn-reports.md)
- [Raised items](raised-items.md)
- [Agent reviews](review.md)
- [Self-hosting Lazy Teams](self-hosting-lazy-teams.md)
