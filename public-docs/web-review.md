# Web review surface

The daemon's embedded web server hosts a **review loop**: the list of tasks
awaiting review → a per-line-commentable diff → inline comment threads that
carry a real back-and-forth with the task's agent → unblock/accept.

It is an early implementation: the loop works end to end, but it is **not
hardened**, and it binds to loopback only for that reason. Read [Known
limits](#known-limits) before exposing it on anything else.

## Routes

All served in-process by the daemon (same process, same `storage` instance —
never a second writer). The dashboard's base URL is printed by
`lazy daemon status`.

| Route | Method | What it does |
|---|---|---|
| `/review` | GET | Review queue — blocked tasks, with comment / pending-ask / queued-comment counts |
| `/review/:task` | GET | Review view — anchored diff + inline threads + queued comments + actions (mirrored top and bottom) + sticky status bar |
| `/review/:task/comment` | POST | Post an inline message (JSON), `intent: 'ask' \| 'comment'` |
| `/review/:task/comment/:id/retry` | POST | Re-send a saved question whose ask failed (form; 303 → `/review/:task`) |
| `/review/:task/comment/:id/withdraw` | POST | Retract one of your own messages before it reaches the agent (form; 303 → `/review/:task`) |
| `/review/:task/unblock` | POST | Unblock with feedback, carrying every queued comment (form; 303 → `/tasks/:id`) |
| `/review/:task/accept` | POST | Accept the task (form; carries the approval passphrase when the gate asks for one) |
| `/review/:task/sync` | POST | Merge the parent branch into the task branch — the in-UI remedy for an out-of-sync or conflicted accept (form) |
| `/api/review/queue` | GET | The queue as JSON |
| `/api/review/:task/threads` | GET | `{ threads, pending, pendingDelivery, queued, state }` — what the island polls |

`:task` accepts a short id, a full id, or a task code — the same resolution the
CLI uses. Rendered forms always post to the canonical full id.

## The loop

1. **Queue** (`/review`) lists tasks in `blocked`, each showing its status,
   whether a live agent session exists, and how many comments are still awaiting
   an answer.
2. **Diff** (`/review/:task`) renders the task branch vs. its parent, computed by
   the daemon's own diff path (`handleDiff`), never by shelling git in the
   handler.
3. **Comment** — every diff row is commentable, and every message carries one of
   two reviewer **intents** (see below): *ask* a question, or leave a *comment*
   for the agent to act on later.
4. **Resolve** — unblock with feedback (which also delivers every queued comment)
   or accept. If the accept is refused, the page says what to do about it — see
   [When an accept is refused](#when-an-accept-is-refused).

## When an accept is refused

An accept can be refused for many reasons: the protection gate wants an approval
passphrase, files were touched that the task was not allowed to touch, the branch
is behind its parent, a merge is half-finished, the task has no commits. A bare
"accept failed" leaves the reviewer with nowhere to go, so every refusal renders a
**remedy panel** above the diff:

- **what to do next**, in a sentence;
- the **files involved**, when the refusal is about specific paths (the motivating
  case is a task with dozens of protected files — nobody is retyping those);
- an **in-page action** when one exists — the passphrase form for a gated accept,
  or a *Sync with parent* button for a branch that is behind or conflicted;
- the **exact CLI command**, complete and copy-pasteable, always. It is the
  fallback when there is no in-page action, and the escape hatch when there is.

### The daemon owns the remedy, the page only renders it

The refusal→remedy mapping lives in the daemon, next to the code that refuses.
`AcceptRefusedError` (`src/daemon/accept-refusal.ts`) carries a structured
`AcceptRemedy` — `{ reason, next, command?, uiAction?, files? }` from
`src/types/accept-remedy.ts` — which travels in the RPC error body alongside the
message and is parsed back out client-side. The web layer never pattern-matches
the prose of an error message to decide what to offer, and it never re-derives a
command from config. A refusal the daemon has not mapped simply has no remedy
panel: the daemon's own message is still shown verbatim, so an unmapped case
degrades to what the page did before, never to a dead end.

### The passphrase is a human surface, deliberately

`lazy approve` has no MCP equivalent on purpose — an agent must not be able to
satisfy its own gate. That asymmetry is about *agents*, not about terminals: a
person at the review page is exactly the human the gate was written for, so the
page asks for the passphrase and the daemon completes the gated accept, the same
way `lazy approve` + `lazy accept` do at a shell. The passphrase is posted to the
daemon for verification, is never stored client-side and never logged or echoed
back into the page, and a wrong one re-renders the form with a clear, retryable
error. See [surface-asymmetries.md](surface-asymmetries.md).

### A refused accept never eats what you typed

The reviewer may have a half-written accept reason and half-written unblock
feedback on the page when the accept is refused. Both are carried through the
refusal and echoed back into their boxes, and both ride along as hidden fields
inside the passphrase and sync forms — so a second failure preserves them too.
This is the same never-lose-human-feedback rule the CLI follows with `$EDITOR`
content.

## Two intents: ask vs comment

Each inline message is one of:

| | **Ask agent** | **Add comment** |
|---|---|---|
| Means | a question | a change request or note |
| Dispatched | immediately, as a read-only ask turn | never on its own |
| Reaches the agent | now | batched into your next unblock work turn |
| Can change code | no | yes (it rides a normal work turn) |
| State on the record | `ask_state: pending → answered/failed` | `delivery_state: pending_delivery → delivered` (+ `delivered_turn`) |

The familiar analogue is GitHub's single comment vs. start-a-review: an ask is a
question you want answered right now; comments accumulate until you submit.

Worked example — the reviewer posts C1 (comment), A1 (ask), C2 (comment), A2
(ask), then unblocks. The agent sees exactly **three** turns: A1's ask and reply,
A2's ask and reply, then a single work turn carrying C1 + C2 with their anchors
plus the reviewer's unblock message.

**INVARIANT: a comment must never become a work turn on its own.** That is the
legacy `Comment` behaviour (one comment = one agent turn) and it is precisely
what this model replaces — a reviewer marking up ten lines should produce one
turn, not ten. This mirrors how lazy already treats forge PR comments: collect,
then react in batch.

Both modes stand alone. Comment-only-then-unblock (accumulate, then answer) and
ask-only (pure conversation, no code change) are equally legitimate, and an
unblock with nothing queued behaves exactly as it did before: the message alone,
unwrapped.

### Asks

An ask persists the comment, then resumes the agent's session in **plan mode**
(same machinery as `lazy_ask` and `lazy review -i`'s ask action). The answer is
persisted as a reply in the same thread, anchored to the same line. The human can
reply again; the thread accumulates. Ask turns never change code.

Asks are only possible while the task is `blocked` or `conflict`. The rule and
its wording live in exactly one place — `askUnavailableReason()` in
`src/server/review-actions.ts` — and drive three surfaces: the daemon's gate, the
warning shown above the comment box *before* the reviewer types, and the sticky
status bar. A question posted at any other time is still saved, marked `failed`
with that reason, and the thread offers a **Re-send to agent** button
(`POST /review/:task/comment/:id/retry`) so it never has to be typed twice.
Retry re-checks askability: still unavailable → the current reason is re-recorded
and the question is untouched; askable → it is dispatched as-is into its original
thread. Retrying an ask already in flight is a no-op, and retry refuses anything
that is not one of the reviewer's own questions (a queued comment is delivered by
unblock, not by an ask).

### Comments

A comment is persisted with `delivery_state: 'pending_delivery'` and nothing else
happens — no dispatch, and deliberately **no status gate**: a reviewer may mark up
the diff of a task that is busy or not yet askable, and the notes keep until an
unblock can carry them. The task page previews everything queued and both the
page and the queue show the count, so the reviewer never has to remember what
they wrote.

On unblock, every undelivered comment is rendered into one prompt
(`src/prompts/review-comments-unblock.md`) with its anchor (file, line, side, the
line's text) and any ask conversation that already happened on that thread —
without it, "do what we just agreed" reads as a non-sequitur. The reviewer's
overall message follows.

A comment is marked `delivered` **only after the unblock turn actually launches**,
recording the turn number that carried it. A failed launch leaves it pending for
the next attempt — the persist-first invariant, extended to the batch path.

### Withdrawing: retracted, not deleted

A reviewer can take back one of their own messages while it is still theirs to
take back — a queued comment, or a question whose ask failed (which by
definition never reached the agent, and whose **Re-send to agent** button the
reviewer may simply not want). `POST /review/:task/comment/:id/withdraw`, a
plain form with a redirect for the same reason retry is one.

It is a **state, not a delete**: `withdrawn_at` is stamped on the record, which
keeps its place in its thread (struck through, so the reviewer can see what they
took back) while dropping out of `isPendingDelivery` — and therefore out of the
queued list, the counts, the threads payload the island polls, and every future
unblock prompt. A hard delete would destroy the only durable copy of something a
human wrote, and a `withdrawn` value on `delivery_state` would give a withdrawn
*ask* a delivery state it never had. This is a deliberately narrow, one-way
widening of "a review comment's words are immutable": there is no un-withdraw,
and a reviewer who changes their mind posts again.

Withdrawal is refused, in the daemon and stated in place of the button on the
page, for anything the agent has already seen: a delivered comment, a question
already in flight (the ask turn is running and the answer will land — saying
"withdrawn" over a live conversation would be a lie the reviewer then acts on),
an answered question, and anything the agent wrote. One definition —
`withdrawRefusalReason()` in `src/server/review-actions.ts` — drives the daemon's
refusal, the page's explanation, and the notice after a POST.

### Ordering: asks first

Asks and the unblock work turn share one per-task queue in the daemon, so a
reviewer who asks a question and then unblocks in the same breath gets the answer
before the work starts. One failed ask does not strand the asks or the unblock
behind it.

## Design decisions worth knowing

### Comments are their own storage entity

Inline comments are `ReviewComment`s, not `Comment`s.

- **INVARIANT: they must not feed the daemon's comment auto-react loop.** A
  `Comment` on a blocked task triggers a *work* turn — the exact opposite of both
  a read-only ask and a batched change request. Reusing that entity would make
  every review question rewrite the branch, and every marked-up line its own
  turn.
- They carry an anchor (`file`, `line`, `side`) and a `thread_id`, which
  `Comment` has no place for.

They live in `review-comments.json` per task under FileStorage, in a
`review_comments` table under PostgresStorage (migration V13; `withdrawn_at`
added in V15), and are proxied
like everything else by RemoteStorage.

### The message is saved before anything is attempted

CLAUDE.md's load-bearing invariant. `postComment` writes the reviewer's words
through `Storage` *first*, then decides what to do with them — for an ask, that
means the askability gate is evaluated only after the write.
Every downstream failure — task not askable, worktree lock contention, runner
unavailable, agent crash, 10-minute ask timeout — is recorded **on** the comment
as `ask_state: 'failed'` with an actionable `ask_error`. A comment is never
deleted or rolled back because its ask failed. The same holds on the delivery
side: a comment that could not be delivered stays `pending_delivery`.

The reviewer's overall unblock message has no such durable home before the agent
turn exists, so it is written to `.lazy/recovery/` before launch and removed only
on success. The batched comments need no such backup — they are already durable.

### The POST returns before the agent answers

An ask is synchronous inside the daemon with a 10-minute timeout — far too long
to hold an HTTP request open. `POST /review/:task/comment` returns `201` as soon
as the comment is durable, with `ask_state: 'pending'`. The ask runs in the
background; the browser island polls `/api/review/:task/threads` while
`pending > 0` and stops when it reaches zero. A queued comment never triggers
polling — nothing is happening to it until unblock.

Asks *and* the unblock are serialized per task in the daemon: `launchAskTask`
takes the worktree lock and 409s on contention, so two quickly-posted questions —
or a question and the unblock chasing it — would otherwise race.

### The page is read top-to-bottom, so it must be actionable at the bottom

The queued-comment list, the unblock box and accept are rendered **twice** —
above and below the diff — because a reviewer who has just finished reading 400
lines should not have to scroll back up to act. Both copies are complete,
independently working forms; with JS off there are simply two of each and either
one posts. Consequently `actionsHtml()` contains **no element ids** (they would
duplicate); the island addresses it through `[data-rv-queued]`,
`[data-rv-sync="feedback"]`, `.rv-accept-form` and `.rv-accept-open`, and keeps
the two feedback textareas in sync on `input`.

Unblock owns the full width — it is the box that gets typed in. Accept is a
`<dialog>` that takes the accept reason, opened by an **Accept…** button. The
server renders accept as a plain inline form regardless; the island moves the
first one into the dialog, drops the duplicate, and only *then* un-hides the
Accept… buttons — so with JS off (or without `showModal`) the inline forms remain
and accept still works.

Queued comments are listed **in full**, never truncated: this list is the
reviewer's only record of what they have already written before they commit to
sending it, and the comment cut off at a preview is exactly the one they would
want to re-read. Each entry links back to the diff row it was written against
(`#l-<encoded path>-<side>-<line>`, `anchorDomId()`), which is why every
commentable row carries that id.

### The sticky status bar

A fixed footer always shows the task's status, turn count, last agent activity,
how much is queued, how many asks are in flight, and whether the agent can answer
right now — the `lazy ls` facts, without scrolling out of the diff.

It is refreshed by the **same poll** that refreshes the threads, which therefore
now runs always: every 3s while an ask is pending, every 10s otherwise. That is a
deliberate stopgap: polling is simple and adequate at this scale, and server
push is the better answer once the surface justifies it.

### One diff renderer, shared by both pages

`src/server/review-diff.ts` is the only diff renderer. It is a purpose-built
light-DOM unified-diff parser/renderer: every commentable line carries
`data-file` / `data-side` / `data-line`, and every page that shows a diff — the
review surface and commit detail — goes through it.

Commit detail used to have a second one (`src/server/diff.ts`, rendering through
`@pierre/diffs`). It put its lines in a **Shadow DOM**, where nothing outside can
address a line, so per-line comment affordances were structurally impossible
there — which is why the review surface needed its own renderer in the first
place. Both are deleted. One renderer means one look, one set of behaviours, and
a feature built once shows up on both pages.

Anchors track the old and new numbering spaces independently — a deleted line
has only a pre-image number, an added line only a post-image number. Collapsing
them would make anchors ambiguous.

### The view toolbar, and side-by-side

Above every diff sits a toolbar of **view modes**, one group per mode, defined as
a list in `DIFF_VIEW_MODES` rather than as hand-written controls. Today that is
**Layout** (Unified / Split) and **Long lines** (Scroll / Wrap). Each choice is
one setting for the whole tool, not per file, persisted in `localStorage`
(`lazy:difflayout`, `lazy:diffwrap`) in a try/catch — a private-mode browser
loses the preference and nothing else. The controls ship `hidden` and JS unhides
them, so a diff still renders fully without JS.

The list shape is the point. The review surface is heading towards *presenting* a
change (rendered markdown, diagrams, images) rather than printing its lines, and
every such mode needs an escape hatch back to the raw lines sitting right beside
it. Adding one is a row in `DIFF_VIEW_MODES` plus an applier in
`diffViewScript` — not a second kind of control invented elsewhere on the page.

**Split is a DOM regrouping, not a stylesheet.** Pairing a deletion with the
addition that replaced it merges two `<tr>`s into one, and no CSS can change how
many rows a table has. The server does the fallible half: `pairSplitRows()`
groups each hunk's lines into rows (a change block's deletions zipped index-wise
against its additions, blank filler on whichever side runs out, context lines
occupying both panes) and stamps every line with `data-rv-pair` / `data-rv-pane`.
The browser only regroups rows it is told about, **moving** existing cells rather
than re-rendering text — so nothing client-side can mis-escape a line of code,
and the part that can actually be wrong is unit-tested TypeScript.

Two consequences worth knowing:

- **The anchor moves one level down the tree, and only that.** A split row holds
  two lines, so it cannot carry one anchor: `data-file`/`data-side`/`data-line`
  and the `anchorDomId()` id land on the **code cell of the side they belong
  to**. Same values, same key, same fragment link — so a comment placed in split
  resolves identically in unified and survives a reload. The review island
  addresses anchors through `ANCHOR_SEL` / `anchorElement()` and never assumes a
  row.
- **The unified `<tbody>` is detached, not hidden**, while split is showing
  (stashed on the table element). Two copies in one document would mean two
  elements carrying each anchor's id, and the queued-comment list is built
  entirely out of fragment links.

Wrap and split are **independent and freely combined**: a paired row is as tall
as its taller pane, so wrapping cannot drift the two sides apart — split is if
anything more robust under Wrap than unified was. Below `900px` the layout
**falls back to unified** and the Split button is disabled rather than scrolling
horizontally into uselessness; the stored preference is untouched, so widening
the window restores it. Switching layout swaps the whole `<tbody>`, so the review
island re-renders threads on an `rv:layout` event instead of waiting for the next
poll.

Commit detail gets all of this with no comment affordances — the toolbar and the
split layout are renderer-level, the comment UI is passed in per page.

### The web layer does not import the daemon

`src/daemon/server.ts` already imports `src/server/`, so the reverse edge would
be a cycle. `src/server/review-actions.ts` declares a narrow `ReviewActions`
port; `src/daemon/review-service.ts` implements it and the daemon injects it at
bind time. With no actions injected, the review routes return `503` rather than
a half-working page. This also structurally enforces "all mutations go through
the daemon" — the handler never touches git, locks, or storage writes itself.

### Threads survive a re-diff, even when their line moves

Threads whose anchor no longer appears in the current diff (the agent edited the
file, the hunk moved) are not dropped — they render in an **orphan threads**
section below the diff, with their original anchor. There is no re-anchoring
model yet; see [Known limits](#known-limits).

## Security posture

This surface **binds to loopback only**, and that is load-bearing rather than a
default nobody revisited. The mutating routes — posting a comment, unblocking,
accepting — have no CSRF protection and no write authentication in front of
them. Loopback binding is what stands in for both.

Do not expose it on another interface, a tunnel, or a reverse proxy. Treat
that as a hard constraint of the current implementation, not a configuration
choice.

Comment threads use exact `(file, line, side)` anchors. When a later turn moves
the lines a thread was anchored to, the thread is not re-anchored: it is listed
separately as an orphan thread, keeping its original anchor, rather than being
silently attached to the wrong line.

## Working on the UI: the dev web server

Editing a template and then rebuilding and restarting the daemon to look at it is
a slow loop. The dev web server renders the same handler
(`createWebRequestHandler`) in a throwaway process while the daemon keeps
serving:

```bash
bun run dev:server                             # this project
bun run dev:server -- --project ~/code/foo     # someone else's project
bun run dev:server -- --port 41234
```

It binds `127.0.0.1:26124` by default, outside the daemon's own port window so a
dev tab is never mistaken for the real dashboard. A busy port is an error rather
than a silent move to the next one — the URL has to stay stable across restarts.

### It is a client of the daemon, not a second writer

Everything goes through the running daemon. Reads use `RemoteStorage` over the
`storage` RPC, exactly as the CLI does; writes use the review RPC commands
(`reviewQueue`, `reviewDiff`, `reviewComments`, `reviewPostComment`,
`reviewRetryAsk`, `reviewWithdrawComment`, `reviewUnblock`, `reviewAccept`, `reviewViolationDecision`) and land in
`src/daemon/review-service.ts` — the same implementation the daemon injects into
its own dashboard. So reviewing, commenting, asking, unblocking and accepting all
work here and take effect in the real store; there is no read-only mode, no
banner, and no refused route.

Those RPC commands are a general daemon capability, not a dev-server feature. The
review port used to be reachable only in-process, which meant no other client —
a UI served from source, a client talking to a daemon on another host — could
review at all. The dev server is simply the first client of the transport.

With no daemon running it **refuses to start** and names the fix
(`lazy daemon start`). That is deliberate: a fallback to opening the store
directly would make the same click mutate a real store on one machine and no-op
on another, and could not work at all against a remote daemon, where there is no
store on the local filesystem to open.

### The CLI surface is unchanged

There is no `lazy` command for this and no hidden flag. The entry point is
`src/dev/web-server.ts`, which is not registered in the dispatcher, not listed in
`src/cli/commands/`, and not completable — it is reached only through the
`dev:server` package script.

### What needs a restart, and what does not

- **Stylesheets: nothing.** The CSS lives in `src/server/styles/*.css` and is
  served at `/assets/app.css` by a route that re-reads those files per request
  (with `Cache-Control: no-store`), so an edit is visible on a plain reload. In
  the shipped binary the same parts are compiled in via text imports and composed
  in the same order, so dev and release can never cascade differently.
- **Templates and routes: this process only.** `bun --watch` restarts it; the
  daemon is untouched.
- **The daemon: only when daemon code changes.**

**Use `bun --watch`, not `bun --hot`.** Measured: under `--hot` the process stays
up but keeps serving the pre-edit HTML; under `--watch` it restarts and the next
request renders the edit. Nothing is held in memory here, so a restart is free.
One caveat — an editor that saves by writing a temp file and renaming it over the
original can leave Bun's watcher on the stale inode (a bare `sed -i` does this);
ordinary in-place saves are picked up.

## Known limits

- No write gate: no CSRF, no same-origin check, no auth on the mutating routes.
  Loopback only.
- No re-anchoring: a thread whose line moved falls into the orphan list.
- No live updates; the island polls — 3s while an ask is pending, 10s
  otherwise — to keep the threads and the status bar current.
- Single reviewer assumed — comments record `actor: 'human'` with no identity.
- The queue lists `blocked` only; `conflict` tasks are askable but not listed.
- A queued comment cannot be *edited* before delivery — withdraw it and write it
  again. Withdrawal itself is one-way; there is no un-withdraw.
- No syntax highlighting, and no word-level intra-line diffing — the diff is
  plain text in both layouts.
- The sync remedy starts a sync and reports it; the page does not follow the
  task through it — re-open the review page to see where it landed.
- Split shares one horizontal scroller across both panes, and an open comment
  form is dropped when the layout is toggled (a cloned `<textarea>` would lose
  what was typed).

## Testing

- `test/unit/review-diff.test.ts` — parser, anchors, light-DOM rendering,
  escaping, thread grouping, queue rendering (both counts), the split-row
  pairing and the markup the side-by-side layout is built from, plus the page
  itself: mirrored action blocks, untruncated queued comments linked to their
  line, the retry affordance on a failed ask, and the sticky status bar.
- `test/unit/server-diff.test.ts` — commit detail goes through the shared
  renderer: light-DOM rows, the view toolbar, split without any comment UI.
- `test/unit/review-comments-storage.test.ts` — the storage entity, including
  the "a failed ask never destroys the comment" invariant and the
  `pending_delivery → delivered` transition, plus withdrawal recorded on a
  comment that survives intact.
- `test/unit/review-service.test.ts` — the persist-before-ask invariant, the
  "a comment is never dispatched" invariant, the bundled unblock prompt, and
  withdrawal: allowed for a queued comment and a failed ask, refused for a
  delivered comment, an in-flight or answered ask, an agent reply, and an id
  that is not on this task.
- `test/e2e/server-review.test.ts` — the full loop against a real daemon: the
  comment → ask → threaded agent reply round-trip, N queued comments delivered in
  ONE work turn, ask-before-unblock ordering, a bare unblock still behaving as it
  always did, and the retry path — a question posted while the agent cannot
  answer is saved, survives a retry that still cannot go, and reaches the agent
  once the task is blocked.
- `test/unit/accept-remedy.test.ts` — the shared remedy contract: boundary
  parsing (an unknown reason or a blank `next` degrades to no remedy rather than
  a half-rendered panel) and the composed `--approve-file` command, shell-quoted.
- `test/unit/review-remedy-render.test.ts` — the three panel shapes (passphrase,
  sync, command-only with files), typed drafts surviving into the re-rendered
  forms, and no panel at all when there is no remedy.
- `test/e2e/server-review-remedy.test.ts` — the gated accept end-to-end against a
  real daemon: refusal renders the passphrase form and does not merge, a wrong
  passphrase is a retryable error that keeps the typed text and never echoes the
  attempt, and the right passphrase completes the merge.
- `test/e2e/dev-web-server.test.ts` — the dev web server as a daemon client: a
  review comment posted on its page is read back through the daemon's own
  dashboard, the stylesheet is served from disk and an edit to it is served
  without restarting anything, and with no daemon it refuses to start.
