# Web review surface

This page is for anyone reviewing and driving lazy tasks from a browser rather
than the terminal: it describes the dashboard the daemon serves, how to sign in,
what each page and tab shows, and where its limits are. The daemon's embedded web server hosts **one page per task**, at `/tasks/:task`
— the task's code when it has one, its id otherwise, and either works — with
tabs for everything you used to hunt across a task page and a review page:
Summary, Verify, Regions, Changes, Turns, Commits, Reviews, Subtasks, Raised,
Comments, Journal, Stats, Shell, Services, and **Current review**. Review is a tab on that page — the place your
queued comments, ticks, and Unblock / Ask / Accept live — not a second site.
Old `/review/:id` links 308 there.

The **review loop** is still the same work: the queue of tasks awaiting you →
read what changed → comment, ask, or verify → unblock or accept. It just
happens on one address.

It is an early implementation: the loop works end to end, but it is **not
hardened**, and it binds to loopback only for that reason. Read [Known
limits](#known-limits) before exposing it on anything else.

It also requires a **signed-in browser session** — see [Signing
in](#signing-in). Loopback is no longer the only thing standing between the
dashboard and everything else that can reach the daemon's port.

## Signing in

```bash
lazy dashboard          # sign in and open the dashboard in your browser
lazy dashboard --print  # print the one-time login link instead of opening it
```

`lazy dashboard` asks the daemon for a **one-time login link** and opens your
browser at it. The browser trades the link for a session cookie and is
redirected to the plain dashboard URL, so the secret never stays in the address
bar. The link works **once**: run the command again for a new one. The session
lasts **30 days of use** and is refreshed every time you load a page, so
ordinary daily use never asks you to sign in again. It survives
`lazy daemon restart`.

lazy **prints the link instead of opening a browser** when opening one would be
pointless or would spend the link on nothing:

- `--print` (or `--no-open`) was passed,
- there is no terminal (a script, a pipe),
- you are on an SSH session — the browser would open at the far end,
- Linux with no graphical session (no `DISPLAY`, no `WAYLAND_DISPLAY`, not WSL),
- the platform opener (`open`, `xdg-open`, `start`) failed.

Visiting any dashboard route without a session gets **one plain sign-in page**
that says to run `lazy dashboard` — no task list, no counts, no project path.
JSON routes answer `401` with the same instruction.

`lazy daemon dashboard-url` is unchanged and still prints the dashboard's plain
address with no secret in it, for scripts and for pasting into an already
signed-in browser. It does not sign you in.

There is no per-browser sign-out. Sessions live in the daemon's runtime state,
next to its token, at `~/.lazy/daemon/<project>/dashboard-sessions.json`;
deleting that file signs every browser out at once.

## Command palette

From any dashboard page, open a VS Code–style palette without leaving where you
are:

| Shortcut | Mode |
|---|---|
| `Ctrl+K` (`Cmd+K` on macOS) | Search tasks, turns, commits, comments, conversations, memories, and raised items |
| `Ctrl+Shift+K` (`Cmd+Shift+K`) | Command mode — the query starts with `>` |

In command mode you can filter the list (or type `>` yourself in search mode).
Commands include creating a new task (opens a dialog over the current page),
and navigating to the dashboard, clusters, task lists, review queue, inbox, raised
items, conversations, settings, and the full search page.

In search mode the last result is always **Search everything for "…"**, which
opens the full `/search` page for what you typed — the palette shows a short,
flat list, and the page has the filters and the query-syntax reference.

Arrow keys move the selection; Enter runs it; Escape closes. There is no Search
link in the nav: the search box in the header is the no-scripting path, and it
works with scripting off like any other form.

### The dashboard has its own hostname

The dashboard is at **`http://lazy.localhost:<port>`**, not `http://127.0.0.1:<port>`,
and it refuses any request addressed to another host: a session cookie is
neither accepted nor handed out there. If you reach the port by its IP address
you get a short page pointing you at the right URL.

If you put the dashboard behind a trusted reverse proxy, set `[server] dashboard_url`
in `lazy.toml` to its public origin (for example `https://lazy.example.com`).
That origin then becomes the only host the dashboard accepts and the address its
links use; the proxy must forward the original `Host` header, and `lazy doctor`
shows which origin is in effect.

That is a security boundary, not a preference. Browser cookies are scoped by
**hostname, not by port** — one cookie for `127.0.0.1` is sent to *everything*
on `127.0.0.1`, whatever port it is on. Apps your tasks start under `[serve]`
are published on loopback ports, and that code was written by an agent. If the
dashboard shared their hostname, opening a task's app to try it out would hand
your dashboard session to that app, which could then use it against the
dashboard.

### Task apps are subdomains, and stay a separate jar

Each task's services are reachable through this same listener at
`http://<service>.<task>.lazy.localhost:<port>` (see
[serve ports](serve-ports.md)) — a hostname *under* the dashboard's. Three
things keep that from undoing the separation above:

- **The session cookie is host-only.** It is set with no `Domain=` attribute,
  ever, so the browser sends it to `lazy.localhost` and to nothing else. A
  `Domain=lazy.localhost` cookie would be sent to every task app on the machine.
- **The proxy does not forward it.** Any `Cookie` header on a request to a task
  subdomain is dropped before the request reaches the container, so a
  hand-crafted request cannot smuggle the dashboard session in either.
- **A task app cannot widen its own cookies.** `Domain=` is stripped from every
  `Set-Cookie` a task app returns, so it cannot plant a cookie that the browser
  would then send to the dashboard.

There is one thing a subdomain *does* change. `SameSite=Strict` is evaluated on
the registrable domain, and `.localhost` is not a public suffix — so a task's
own app counts as **same-site** with the dashboard, and `SameSite` alone would
not stop a page served by a task from posting to a dashboard route with your
cookie attached. That is why anything that can change state — every unsafe
method, plus WebSocket upgrades — must additionally come from the dashboard's
own **origin**; see [Security posture](#security-posture) below. Plain `GET`
navigation is deliberately exempt, so following a link from a task app back to
the dashboard still works.

`lazy.localhost` is a loopback name — anything under `.localhost` resolves to
your own machine, and Chrome and Firefox resolve it themselves without any
setup. If your browser cannot reach it, `lazy dashboard` says so and prints the
one line to add to `/etc/hosts`:

```
127.0.0.1 lazy.localhost
```

A hosts file cannot hold a wildcard, so that line covers the dashboard but not
the task subdomains: for those you need a browser that resolves `.localhost`
itself, and for `curl` and scripts there is `lazy url <task> <service> --direct`.

## The task page

Every task lives at `/tasks/:task` — the task's code when it has one, its id
otherwise; both resolve, so old id-based links keep working. The tabs are always
the same, in this order,
so muscle memory survives moving from one task to another. Only **Shell** hides,
and only when the runner has no container to enter.

| Tab | What it is |
|---|---|
| **Summary** | Status-driven: what this task is, what just happened, the agent's report of what a user would notice. |
| **Verify** | How to check the work — the latest turn's steps, older ones collapsed as superseded. |
| **Regions** | The groups the agent's walkthrough declares — in the order it declared them, `Other changes` last, each with its tier and owner. Picking one scopes the Changes tab to it. See [Review regions](review-regions.md). |
| **Changes** | The diff, presented when the agent declared a walkthrough, raw files one click away. A small card above it says how many regions there are and which one is in force. |
| **Turns** | The record, reviewed a **chunk** at a time. A chunk is what happened since you last acted — your turn and every agent, nudge and auto-resume turn that followed, until you acted again — and it is one card: headed by the turn that opened it and the first line of what you asked for, with those turns, plus any comments and journal entries from the same window, inside it. Each agent turn lists the commits it made underneath, and each can be collapsed on its own. Ticking a chunk Viewed and the `j` / `k` keys both move a whole chunk. Newest first throughout. |
| **Commits** | Every commit on the task, newest first — the same rows as under each turn, in one list. |
| **Reviews** | Successful formal agent reviews — when, verdict, raise count, links to the turn and Raises (including reviews that filed issues). A turn that produced no usable Raises and no **clean** parseable security/data-integrity sweeps does not get a row here — check **Turns** for an unparsed banner or an incomplete recording. |
| **Subtasks** | Direct children, grouped by status, each group listing the most recently updated child first. Click a column header to re-sort a group; the jump bar above the groups opens and scrolls to any group in one click. The **Nested** column counts everything under that child — its own subtasks, theirs, and so on — and links into that child's Subtasks tab; a dash means nothing is nested under it. |
| **Raised** | Questions and proposals; a row opens the item in a dialog. |
| **Comments** | Every comment on the task, oldest first, split into the ones the agent has already been shown and the ones still queued for its next turn. Add one here in any status, finished tasks included — it is saved and nothing else, it reaches the agent in the prompt of the next Unblock, and it never starts a turn on its own. On a finished task a comment is an annotation for whoever reads the task later; if the task is reopened or redone, it rides that next turn. The tab's badge reads `queued/total` while any are waiting. If the store cannot be written, the page hands your text back so nothing you typed is lost. |
| **Journal** | The task's out-of-prompt record — rationale, deferrals, notes to whoever picks the task up next. Newest first. Journal entries are never injected into an agent's prompt; a later turn is only told how many new ones exist. Append with `lazy journal <task>`. |
| **Stats** | Where this task's time and tokens went, and — for a task with subtasks — its whole subtree's. See [What the Stats tab means](#what-the-stats-tab-means) below. The tab's badge is the total tokens recorded across its own turns. |
| **Shell** | Terminals in the task's container, plus Pair and Chat. See [Web shell](web-shell.md). |
| **Services** | Declared ports, liveness, Start container / Start services. |
| **Current review** | Your in-progress review — queued comments, ticks, and the buttons that end the turn. |

Clicking a tab with JavaScript on swaps the body in place, so a terminal you
opened under a verification step keeps running. A full navigation or reload
still closes every shell. Without JavaScript each tab is a real page.

Numbers 1–9 jump to Summary, Verify, Regions, Changes, Turns, Subtasks, Raised,
Shell and Current review, in that order (Summary is 1, Current review is 9).
Commits, Reviews, Comments, Journal, Stats and Services have no number — use `[` / `]`
or click them.
Current review comes last, picked out in the accent colour.

The strip shows every tab: when they do not all fit across the window it wraps
onto a second and third row rather than letting the last ones slide out of
sight.

## Clusters

**Clusters** is the second entry in the top nav, right after Dashboard. It lists
every **cluster task** — a task whose agent does not do the work itself but
creates subtasks and drives them: deciding which of them can run at the same
time, reviewing each one as it comes back, then accepting it.

Each cluster shows:

- **k of n accepted** — how many of its subtasks have landed, out of the ones
  still expected to. Subtasks the cluster closed are reported separately and do
  not inflate the denominator.
- **What is running** — every subtask in flight; a cluster may have any number.
- **What was deferred** — subtasks the cluster set aside for later.
- **Every subtask**, with its status, so you can see where a cluster is without
  opening it.

Those numbers are worked out from the subtasks themselves every time the page is
drawn, so they cannot go stale when a subtask is closed, moved, or accepted by
you rather than by the cluster.

**New cluster** at the top of the page opens the ordinary create form with the
type already set to `cluster` — the same fields as `lazy create --type cluster`.

## Settings

**Settings** in the top nav is where project memory and installation health
live:

- **Memories** — the shared memory records (the same store as `lazy memory`).
  `/memory` still works; it redirects here.
- **Doctor** — the last `lazy doctor` report this machine produced, a **Run**
  button that executes the same sweep, and a button per cleanup flag. Opening
  the page does not probe docker or git; Run does. Cleanup of worktrees,
  images or containers lists what it would remove and asks before acting.

## Routes

All served in-process by the daemon (same process, same `storage` instance —
never a second writer). The dashboard's base URL is printed by
`lazy daemon status`, and every route below needs a session.

| Route | Method | What it does |
|---|---|---|
| `/review` | GET | Review queue — blocked tasks, with last activity, subtask count, and comment / pending-ask / queued-comment counts; `?sort=<column>` re-orders it (a leading `-` means descending) |
| `/review/:task` | GET | **308** → `/tasks/:task/review` (Current review tab). Bookmarks and old links keep working. |
| `/review/:task/<action>` | POST | **308** → `/tasks/:task/review/<action>` (method and body preserved) |
| `/tasks/:task/review` | GET | Current review tab — queued comments, accept checklist, Unblock / Ask / Accept (each a dialog), Reject / Sync / Submit. Review is a tab on the task page, not a separate page. |
| `/tasks/:task/review/comment` | POST | Post a line-anchored message (JSON), `intent: 'ask' \| 'comment'` |
| `/tasks/:task/review/ask` | POST | Ask a task-level reflective question (form or JSON; 303 → `/tasks/:task/review` without JS) |
| `/tasks/:task/review/thread/:thread/promote` | POST | Promote an answered discussion into a new backlog task — goal, code, prompt and subtask-vs-sibling from the form (303 → `/tasks/:task/review?promoted=<code>`) |
| `/tasks/:task/review/comment/:id/retry` | POST | Re-send a saved question whose ask failed (form; 303 → `/tasks/:task/review`) |
| `/tasks/:task/review/comment/:id/withdraw` | POST | Retract one of your own messages before it reaches the agent (form; 303 → `/tasks/:task/review`) |
| `/tasks/:task/review/raised` | POST | Decide one open raised item (respond / acknowledge / dismiss / promote to subtask / promote to peer), blocking or not; the comment — and, for a promotion, the new task — lands on the next unblock or accept |
| `/tasks/:task/review/raised/unresolve` | POST | Undo a resolution whose comment has not been delivered yet |
| `/tasks/:task/review/unblock` | POST | Unblock with feedback, carrying every queued comment (form; 303 → `/tasks/:task/review`); may also carry raised-item resolutions |
| `/tasks/:task/review/accept` | POST | Accept the task (form; carries the approval passphrase when the gate asks for one, raised-item resolutions when deciding on the page, and `allow_queued_comments=1` when you choose to merge without delivering queued comments) |
| `/tasks/:task/review/sync` | POST | Merge the parent branch into the task branch — the in-UI remedy for an out-of-sync or conflicted accept (form) |
| `/tasks/:task/review/draft` | POST | Autosave the review in progress — unsent feedback, unsent accept reason, viewed/collapsed ticks (JSON `{ patch }`) |
| `/api/review/queue` | GET | The queue as JSON, in the order `/review` would show it (`?sort=` accepted) |
| `/api/review/:task/file-lines` | GET | A line range of one file at the task's diff revisions (`path`, `side`, `start`, `end`) — what the diff's expand controls read; refuses any path that is not part of the diff |
| `/api/review/:task/threads` | GET | `{ threads, taskThreads, pending, pendingDelivery, everQueued, everAsked, queued, state }` — what the island polls |
| `/tasks/:task/review/session` | GET | **410** unless a stored builder-review transcript exists (read-only archive). Start/send are gone. |
| `/tasks/:task/review/session/start` | POST | **410** — Review with builder cannot be started |
| `/tasks/:task/review/session/send` | POST | **410** — Review with builder cannot be continued |
| `/api/review/:task/session` | GET | **410** unless a stored transcript exists (JSON archive) |
| `/tasks/:task` | GET | Task page, Summary tab — goal, status, parent, PR/MR link, lifecycle actions, and a body that follows the task's status (including `behavior_change` / `capabilities_lost` from the agent's report) |
| `/tasks/:task/changes` | GET | Changes tab — the presented/raw diff, with the report's `implementation` section as preamble |
| `/tasks/:task/verify` | GET | Verify tab — latest how-to-verify steps, superseded history, per-step ticks |
| `/tasks/:task/turns` | GET | Turns tab — one card per turn chunk, with comments and journal folded in by time; each agent turn lists the commits it made underneath; newest-first throughout, with a line saying what a chunk is |
| `/tasks/:task/turns/:n` | GET | Redirects to `/tasks/:task/turns#turn-:n` — the Turns tab, scrolled to that turn inside its chunk. A sequence the task does not have is a 404 |
| `/tasks/:task/commits` | GET | Commits tab — every commit on the task, newest first |
| `/tasks/:task/reviews` | GET | Reviews tab — successful formal agent reviews (failed/unparsed reviews omitted) |
| `/tasks/:task/subtasks` | GET | Subtasks tab — direct children grouped by status, with a filter and no cap |
| `/tasks/:task/raised` | GET | Raised tab — blocking and non-blocking items |
| `/tasks/:task/comments` | GET | Comments tab — every comment, oldest first, split into seen by the agent and queued for its next turn |
| `/tasks/:task/comments/add` | POST | Adds a comment and nothing else — no turn is started. Redirects back to the Comments tab |
| `/tasks/:task/comments/:comment/edit` | POST | Replaces the text of a comment the agent has not been shown yet. A comment it has already seen is refused, with the reason and your text handed back. Redirects back to the Comments tab |
| `/tasks/:task/journal` | GET | Journal tab — the task's out-of-prompt record, newest first |
| `/tasks/:task/stats` | GET | Stats tab — turn count, the time split, per-turn and cumulative token charts, and per-tool calls and result tokens when the proxy recorded any. `?scope=task` narrows it to the task alone; a task with descendants defaults to the whole subtree |
| `/tasks/:task/shell` | GET | Shell tab — index of this page's terminals, Pair, Chat; hidden when the runner has no container |
| `/tasks/:task/services` | GET | Services tab — declared ports, liveness, and ports this branch added that the project root does not publish |
| `/tasks/:task/commits/:commit` | GET | One commit on its own page, with its diff |
| `/tasks/:task/prompts/:version` | GET | One version of the task's prompt |
| `/tasks/:task/edit` | GET | Edit form for a task's goal and prompt (and the model, effort and agent its next turn will use) |
| `/tasks/:task/edit` | POST | Save those edits (form; 303 → `/tasks/:task`) — see [Editing a task](#editing-a-task) |
| `/tasks/new` | GET / POST | Create a task — see [Creating a task](#creating-a-task) |
| `/tasks/link` | GET / POST | Link a branch or PR as a blocked task — see [Linking a branch or PR](#linking-a-branch-or-pr) |
| `/tasks/:task/actions/:verb` | POST | Lifecycle action from the task page — `start`, `stop`, `close`, `reject`, `resume`, `reopen`, `sync`, `submit`, or `review` (form; 303 → `/tasks/:task`) — see [Acting on a task](#acting-on-a-task). With scripting on, returns 202 and the page follows `/tasks/:task/action-runs/:runId`. |
| `/tasks/:task/live-status` | GET | Cheap JSON freshness keys the open task page polls — one per section, so only the parts that moved react |
| `/raised` | GET | Cross-task raised-item queue (open items by default; `/raised?all=1` for resolved); `?gate=blocking` / `?gate=non-blocking` filter by whether they gate accept, and `?sort=<column>` re-orders it (a leading `-` means descending), composing with the filters |
| `/raised/:id` | GET | Opens the owning task's Raised tab with that item in a dialog (JS off: the same page, dialog in-flow). The address bar reads `/raised/:id`; Back and ESC close without acting. |
| `/raised/:id/decide` | POST | Decide that item — respond, acknowledge, dismiss (with an optional note), or promote to a backlog task (form; 303 → the item, or the new task on promote) |
| `/raised/:id/blocking` | POST | Change whether that item gates accept (form; 303 → the item) |
| `/followups`, `/followups/:id`, `/api/followups` | GET | The pre-unification paths — 308-redirected to their `/raised` equivalents rather than 404ing, because they are in old task prompts and bookmarks |
| `/sessions` | GET | **410** — Review with builder was removed |
| `/conversations` | GET | Captured builder conversations, newest first; `?q=` searches their message bodies (an invalid or too-slow pattern is refused, not a server error) |
| `/conversations/:session` | GET | One conversation's transcript, paged 40 messages at a time (`?offset=`) |
| `/api/conversations` | GET | The conversation listing as JSON — metadata only, never transcripts |
| `/scratch` | GET | Captured builder scratch files, grouped by builder session, with size and capture time; files recorded by name only are marked with the reason. `?q=` searches within them |
| `/scratch/file?path=` | GET | One scratch file — markdown rendered, `&raw=1` for the source; a name-only file says why it has no body |
| `/api/scratch` | GET | The scratch listing as JSON — grouped by session, never file bodies |
| `/settings` | GET | Settings — Memories tab (same listing as `/settings/memory`) |
| `/settings/memory` | GET | Shared memory records — the Memories tab (live by default; `?all=1` includes removed ones) |
| `/settings/doctor` | GET | Doctor — last health report this machine produced, or an empty state. Does not run checks. |
| `/settings/doctor/run` | POST | Run doctor (the same sweep as `lazy doctor`); streams progress. |
| `/settings/doctor/remedy/:flag` | POST | Preview or apply a `lazy doctor --<flag>` remedy. Cleanup of worktrees, images or containers lists what it would remove and waits for confirm. |
| `/memory` | GET | **308** → `/settings/memory` (query string kept) |
| `/memory/new` | GET | Form to create a record (same write as `lazy memory save`) |
| `/memory` | POST | Create a record; 303 to `/memory/:name` |
| `/memory/:name` | GET / POST | One record in full, with write history; POST saves an edit |
| `/memory/:name/remove` | GET / POST | Confirm, then tombstone the record (history is kept) |
| `/memory/compact` | GET | The current compact (what launches inject) plus size and staleness |
| `/memory/compact` | POST | Run compact (auto / mechanical / llm); streams progress as it runs |
| `/memory/compact/clear` | POST | Drop the compact; injection falls back to the full index |
| `/api/memory` | GET | The record listing as JSON — index fields only, never bodies |
| `/clusters` | GET | Every cluster task with its derived progress, and a form to create a new one — see [Clusters](#clusters) |
| `/api/nav-counts` | GET | The nav badge counts in one payload — see [The nav counts](#the-nav-counts) |

`:task` accepts a short id, a full id, or a task code — the same resolution the
CLI uses. Links the server renders use the task's code when it has one (the id
when it does not, or when another task carries the same code); either resolves.
Old id-based links and bookmarks keep working.

Every task page, task list and review queue includes a
`Server-Timing` response header with per-phase render times and size counts
(diff bytes and files, HTML bytes, turns, children, threads). Open the browser
Network panel's Timing view to read it, or grep the daemon log for
`web-timing` — the same numbers, on one line per request, when debug logging is
on.

### Linking to a task from a builder or agent

The builder's system prompt includes the dashboard's base URL (the same address
`lazy daemon dashboard-url` prints) and these path patterns, so a task the
you will act on is written as a markdown link — `[fix-login](http://lazy.localhost:<port>/tasks/fix-login)`. Agents and tools that need the
base URL without a new tool read `dashboard_url` on `lazy_status` (`null` when
the dashboard is off — managed mode — so they must not invent a link).

There is no dedicated "give me the dashboard URL" MCP tool. The CLI already
has `lazy daemon dashboard-url`; MCP reuses `lazy_status`. See
[surface-asymmetries](surface-asymmetries.md).

## The nav counts

Five nav entries carry a small count badge, so something waiting for you is
visible from whatever page you are already on:

- **Clusters** — cluster tasks that have not finished yet.
- **Review** — tasks awaiting review right now: the same queue `/review` lists.
- **Inbox** — unread system messages.
- **Raised** — open (un-decided) raised items: the same set `/raised` shows by
  default. This one badge carries two numbers, blocking first — `2/11` is two
  open blocking items and eleven open non-blocking ones — because they are one
  destination, not two. A zero blocking count is left out rather than shown as
  `0/11`.
- **Conversations** — conversations captured since you last opened
  `/conversations`.

Each count is the count its own page shows — the badge runs the page's own
query, so the two can't drift apart. A count of zero shows no badge at all,
which means a bare nav is the honest answer for a quiet project, not a broken
one.

Every page makes **one** request, to `/api/nav-counts`, and fills every badge
from it. That endpoint returns counts only — no titles, goals or
bodies — and needs a session like every other route. With scripting off the
badges are simply absent; nothing else about the nav changes, and every page
they point at works as before.

The counts are independent: if one of them can't be worked out, that badge is
absent and the others still appear. An absent badge is never lazy claiming
there is nothing there — it is either a count of zero or a count it couldn't
take, and the page itself remains the authority either way.

**The Conversations count is per browser.** Conversations have no read state in
the store — they are captured, never authored — so lazy does not invent one.
Instead your browser remembers the newest conversation it has been shown (in
`localStorage`, under `lazy.conversationsSeenAt`), sends that back with the
request, and the badge counts what arrived after it. Opening `/conversations`
clears the badge and sets the new mark. A second browser, a private window, or
cleared site data therefore starts over and counts every conversation as new —
which is right: "since you last looked" is a fact about a person at a screen,
not about the project. A search (`/conversations?q=`) shows a subset, so it
never advances the mark.

## Creating a task

**New task** on the Tasks list opens **`/tasks/new`**. From a task page,
**New subtask** opens the same form with that task already chosen as the
parent. This is the browser's version of `lazy create`:

- **Goal** is required. **Prompt** is markdown, with the same rendered preview
  the edit form uses.
- **Code** is optional kebab-case. Leave it blank and lazy derives one from the
  goal when the goal itself makes a valid code; otherwise the task is addressed
  by its id.
- **Parent** is a task (a subtask) or a branch name (a top-level task targeting
  that branch). Leave it blank for the repo default branch.
- **Review** picks how the task gets read once it declares done — `low-high`
  (the default: the writer self-reviews in its own session), `separate` (a
  reviewer runs afterwards and gates accept, at three to four times the cost),
  or `off`. See [the review paradigm](review-paradigm.md).
- **Type**, **agent profile**, **model** and **effort** are the same choices
  `lazy create` takes. The **Agent profile** dropdown lists the project's own
  `[agents.<name>]` profiles first, under *Configured profiles (lazy.toml)*,
  with the implicit per-harness **built-in profiles** beneath them; each option
  shows what it runs (harness, model, endpoint, credential). **Model** and
  **effort** on the same form override the chosen profile for this one task —
  that is how you run an ad-hoc combination without defining a profile for it.
  The task edit page offers the same picker; if that task names an agent the
  list does not otherwise offer — a profile you have since removed, say — it
  stays selectable in a *Pinned on this task* group, so saving the form never
  switches it behind your back. When lazy cannot read your `lazy.toml` at all,
  the picker says so and offers the built-in agents only.
- **Start now** launches the first agent turn after creating. Leave it
  unchecked and the task lands in the backlog. Starting needs a prompt.

A refused create — empty goal, a code that is already in use, an unknown
parent — redisplays the form with **what you typed still in it** and the
daemon's reason. Those checks run before the task is written. Prompt, model,
effort and an explicit branch parent are saved just after; if one of those
writes fails you still land on the new task with a notice, so submitting
again cannot create a second one.

With scripting off the form is a plain POST. With scripting on, **Start now**
opens the same action dialog the Start button uses, so you see the launch
phases. The task is created before those phases begin: if the browser never
hears back, open the Tasks list rather than submitting again. A start that
fails after create still takes you to the new task, with the reason.

## Linking a branch or PR

**Link…** on the Tasks list opens **`/tasks/link`**. This is the browser's
version of [`lazy link`](link.md): paste a pull-request URL or type a branch
name, optionally a parent and a code. The new task uses that existing branch,
starts blocked (not running), and is marked **linked** on the list and on its
page — with the branch, and the PR once one is known.

A refused link redisplays the form with what you typed and the reason. With
scripting off the form is a plain POST. With scripting on, Link always opens
the action dialog so you see the fetch and worktree steps. Two people (or two
tabs) linking at once each get their own run — they do not share a queue slot.

## Agent review from the task page

**Review** on a paused task's action row is the browser's version of
[`lazy review`](review.md). It is a read-only agent pass — security and data
integrity first — that files each issue as a **Raise** on the Raised tab (with
`blocking` chosen per item). It is not the **Go to Current review** tab (that
is where you accept or unblock). The task stays in its current status
afterwards. The button is offered only while the task is paused (`blocked`,
`conflict`, `submitted`, or `interrupted`) — the same statuses the daemon
accepts.

Optionally tick **Automatically fix — start a work turn that injects any Raises
the review files**. When the review files at least one Raise, lazy starts a
normal work turn whose notes include every finding (ids and text) and asks the
agent to reply per item with `lazy_raised_item_comment`. A clean review or a
turn that produced nothing usable does not start that turn. Agent comments do
not dismiss Raises — only you do, on the Raised tab.

The report stays on this page. Lazy does not post reviews to a pull or merge
request — see [reviews stay on the task](review.md#reviews-stay-on-the-task).

The **Reviews** tab lists every *successful* formal review: when it ran, the
verdict, how many Raises it filed, and links to the review turn and those
Raises. A review counts when it filed usable Raises or produced parseable
**clean** security/data-integrity statements (`none found`). Unparsed leftover
JSON with no Raises is treated as if the review never happened for the list
and accept gates (the turn itself may still show a failed-parse banner on the
Turns tab). A
review that names issues in those sweeps but somehow records no Raises is
also treated as failed — not as a clean pass. Accept refuses while a
successful review that raised issues has not been followed by a work turn
(dismissing Raises alone is not enough). A Raise you **promote to its own
task** is the exception: the work is tracked in that task, so it stops
counting towards the gate, and accept no longer asks you to unblock the agent
for work nobody owes. Current review's **Before you can accept** list names
that gate even when the Raises are non-blocking or already dismissed — the
list would otherwise look clear while Accept still refuses — and it counts
exactly the Raises that still hold accept back. When a task's work is
declared done, lazy starts a review on it without anyone asking (see
[the review page](review.md)); by the time you open Accept that review has
usually already run and its verdict is on the task. **Review** stays its own
button for a second opinion or for work nobody declared final — which you can
still accept, since the declaration gates nothing.

## Editing a task

**Edit task** on a task page (and *edit task* on Current review)
opens **`/tasks/:task/edit`**. It is the browser's version of `lazy edit`, and it
obeys exactly the same rules:

- **Before the first turn** you can rewrite the **goal** and the **prompt**. The
  prompt is markdown, so the form shows it rendered above the textarea you are
  typing in — expand or collapse that preview as you like. The preview is
  rendered by the server, so it catches up whenever the page reloads.
- **Once a turn has run**, the goal and prompt are locked: an agent has already
  read them and acted on them. The page says so in as many words, and drops
  those fields rather than letting you type into a box that would be refused.
- **Model, effort and agent** stay editable for as long as the task is alive.
  They take effect on the task's **next** turn.
- **A finished task** (complete or abandoned) cannot be edited at all, and the
  page says which of the two it is.

Saving a prompt creates a **new prompt version** — nothing is overwritten. The
old text stays readable under **Prompt History** on the task page, the same as
after a `lazy edit --prompt`.

If a save is refused — an effort level that does not exist, an empty goal — the
form comes back with **what you typed still in it** and a plain sentence saying
why. Nothing is half-saved: the daemon checks every field before it writes any
of them, so a refusal means the task is exactly as it was.

An empty model box means "leave the model alone", so on a task that already has
a model override, emptying it is refused with that explanation rather than
silently doing nothing — type a different model, or change it in a terminal with
`lazy edit <task> --model <name>`.

## Acting on a task

The task page (`/tasks/:task`) carries a small action row, and it offers only
the verbs that are legal for the task's current state — the same rules the CLI
enforces, so a button you can see is a button that will work:

- **Backlog** — **Start** launches the first agent turn (worktree, branch and
  all, exactly like `lazy start`), and **Close** ends the task without one.
- **Working** — **Stop** halts the agent without auto-resume, like
  `lazy stop`. The reason you type is recorded on the task.
- **Blocked** — **Go to Current review** leads the row (that tab is where a
  turn ends), with **Resume** (relaunch with no new feedback, like `lazy resume`)
  and **Close** beside it. **Reject** lives on Current review next to Accept.
  **Submit** and **Sync** are on both the Summary row and Current review.
  **Reparent**, **Redo** and **Clone** sit on Summary.
- **Finished** (complete or abandoned) — **Reopen** brings the task back to
  blocked (if it had run) or backlog (if it never did). Reopening an accepted
  task asks for a reason, which is recorded as a comment.

Every one of those verbs opens a dialog. The dialog shows the same steps the
CLI prints for that command (`lazy accept`, `lazy stop`, `lazy sync`, …) as
they run. If everything succeeds, the dialog closes and the page refreshes to
the new state. If a step fails, the dialog stays open with the failed step.
A protected-branch accept that needs the approval passphrase asks for it
**in that same dialog**, under the failed step: the passphrase field and
**Approve and accept** are primary, and the exact CLI command (including
`--approve-file` for every already-approved file, and `--reason` if you typed
one) is the secondary alternative. Stop, close and reject still require a
short reason — typed in the dialog, the same reasons the CLI asks for.
Without scripting, the same forms post and redirect as they always did.

**Watch** opens a live output panel below the button — the same stream
`lazy watch <task>` prints in a terminal, in the browser: the agent's thinking
and tool calls, its API traffic through lazy's proxy, the supervisor's own
output, and a status line every few seconds. Like the [web shell](web-shell.md)
it spans the full width of the page's content column and re-flows whenever the
window or the panel changes size — drag the bottom edge to make it taller. It is
read-only; you cannot type into it. When the task is not running the panel says
so and stays open, so the next turn appears without reopening it. **Close**
dismisses the panel. Watch needs scripting; with it off, reload the page to see
the latest agent output.

## Staying up to date without losing your place

The task page keeps itself current on its own (when scripting is on), and it
does it per section rather than all at once. A short poll asks the server what
has moved — the status and progress line, subtasks and their statuses, turns,
comments, journal entries, raised items, commits, the branch's latest commit —
and only the parts that actually moved react. A task that stays *working* while
its subtasks come and go now updates its Subtasks tab; it used to sit there
stale until you reloaded.

What happens next depends on which tab you are reading:

| Tab | What an update does |
| --- | --- |
| Header, tab strip, status bar | Update in place immediately, always. |
| Summary, Subtasks, Reviews, Raised | Patched in place, silently. Your scroll position, text selection, open sections and anything you have typed are kept. |
| Turns, Commits, Comments, Journal | New entries appear in place. They land at the top, so the page holds your viewport where it was and offers **New content above** if you want to jump. |
| Changes, Current review, Regions, Stats | Never swapped under you. A small **updated — reload** button appears in the corner; you choose when. |
| Shell, Verify | Never touched, so a terminal you have open keeps running. |

A tab you are *not* on is not refetched behind your back. It gets a dot in the
tab strip, and its content is fetched fresh the moment you switch to it — so a
stale Subtasks tab is visible from Changes without costing anything.

Nothing is patched while you are working in it: if you are typing in a box,
have text selected, or have just scrolled, the update waits and offers itself
as a button instead. **A draft you have typed is never cleared by a refresh.**

**An update you decline is not forgotten.** If you ignore the **reload** button,
or the page holds an update back because you were busy, that tab is still behind
— so it keeps its dot, and moving away and back to it fetches it fresh. The tab
you are currently reading shows no dot, because the button in the corner is the
offer; the dot appears the moment you leave it.

An open Watch panel, Shell session or Verify terminal is left alone throughout.
Without scripting, reload the page as before.

## Since you last looked

Both the Current review tab and Summary lead with a **Since you last looked**
card: everything that happened after your last action on the task — agent turns,
commits, new comments, journal entries and raised items — one line
each, linked to the page that shows it in full. Merge commits from syncing with
the parent branch are left out, since they are not work the agent did.

The window starts at your last intervention: the unblock, start or ask you last
sent, not the last commit. If nothing has happened since, the card says so in
one line. Tick **Viewed** to fold it away; it comes back the moment something
new lands.

## The loop

1. **Queue** (`/review`) lists tasks in `blocked`, each showing its type and
   goal, when its agent was last active, how many subtasks sit under it (every
   descendant, not just direct children), whether a live agent session exists,
   and how many comments are still awaiting an answer. It is sorted by **last
   activity, newest first**, stated in a line under the heading, and every
   column header is a link that re-sorts the queue — clicking the column you
   are already sorted by flips the direction. Sorting by **Subtasks**
   descending brings the parent tasks — the ones with work stacked
   under them — to the top. Opening a row lands on that task's **Summary**
   tab.
2. **Summary, then Verify, then Changes.** Summary leads with the agent's
   **Screenshots** when it declared any (see below), then the report of what a
   user would notice. **Verify** is the latest turn's how-to-verify steps.
   **Raised** holds open items — blocking ones gate accept. **Services** lists
   the task's declared `[serve]` ports. **Changes** is the diff: when the agent
   declared a presentation on `lazy_report`, a semantic walkthrough (groups,
   tiers, snippets) is shown first with a **Presented / Raw files** toggle;
   otherwise the per-file diff appears as before. A task with accepted children
   (a parent task) lists those children on **Subtasks** and shows only the
   parent's own direct changes here — the children's files were already reviewed
   when each child was accepted. `lazy diff` and `lazy_diff` use that same
   scoped diff; pass `--full-branch` / `full_branch` for the whole branch.
3. **Diff** renders the task branch vs. its parent, computed by the daemon — the same diff `lazy diff` shows. A parent task's
   default diff is its own commits only (see above). A diff only
   shows a few lines around each change, so every gap — above the first hunk,
   between two hunks, and after the last one — carries **expand controls**: ↑ and
   ↓ reveal 20 more lines against the hunk they belong to, and ↔ reveals
   the whole gap (to the start or end of the file at the edges). Revealed lines
   that were unchanged in the diff are ordinary context rows (line numbers on
   both sides, commentable). When the Changes walkthrough shows only a
   **snippet** of a file, expanding can also reveal additions the snippet
   left out — those still paint as additions (green, `+`), never as old code,
   and the file header's `+N −M` updates; a partial snippet also shows
   `of +X −Y` for the whole file so a one-line card is not mistaken for a
   one-line change. The lines come from the daemon, read from
   the task's own worktree at the same revisions the diff was rendered from —
   only files that are part of the diff can be read this way. The controls need
   JavaScript; without it the diff renders as it always did.
4. **Files with a presented form are shown, not just diffed.** Some files read
   better as themselves than as a column of `+`/`-` lines. Markdown is the first
   of them: a `.md`, `.markdown` or `.mdx` file in the diff is shown as the
   document it is — headings, lists, tables, links and Mermaid diagrams all
   render, exactly as they do elsewhere in the review surface.
   - An **added** file renders whole. A **removed** file renders its old
     content, muted and labelled as deleted.
   - A **modified** file renders the new version whole, with every untouched
     stretch folded into a "N unchanged lines" summary you can click open. The
     passages the change touched stay open at full strength, and inside them the
     green accent lands on what actually changed — the individual heading,
     paragraph, list item or table row — so one added bullet reads as one added
     bullet, not as a rewrite of the list it joined. Text that was removed is
     shown in place beneath it, struck through. A heading immediately above a
     change is never folded away: whatever labels the change stays visible.
   - **You can ask about it where you are reading it.** Every presented
     document carries a **Comment** button in its header: it opens the ordinary
     Ask / Add comment box against the document, without making you go and find
     a line first. Use it for the question that is about the passage rather than
     about one line.
   - **The line diff is always one click away.** The toolbar carries a
     **Files: Presented / Source** switch that applies to every presentable
     file on the page and is remembered between visits, and each presented file
     also has its own **Source — comment line by line** button, which says what
     it buys: a comment pinned to one specific line. Comment threads live on the
     source diff rows, so the "+" button on a presented block switches to the
     source view with that line in view, ready to comment, and the presented
     header says how many comments a file already has. Without JavaScript you
     get the ordinary diff, as before.

   The switch is not about markdown — markdown is simply the first file type
   with a presented form. As more arrive (diagrams, images, and other formats
   worth showing rather than listing), the same control governs them, and it
   stays a no-op for files that have no presented form.
5. **Comment** — every diff row is commentable, and every message carries one of
   two reviewer **intents** (see below): *ask* a question, or leave a *comment*
   for the agent to act on later.
6. **Resolve** — unblock with feedback (which also delivers every queued comment)
   or accept. If the accept is refused, the page says what to do about it — see
   [When an accept is refused](#when-an-accept-is-refused). Open raised items
   must be responded to, promoted, or dismissed before accept succeeds.
## The Screenshots card

When a task built something you can look at, its agent can show you rather than
describe it: it attaches images to the task and names them in its report's
presentation (see [Structured turn reports](turn-reports.md)). Those images get
a **Screenshots** card at the very top of Summary — above the raised
items and the report — each with the agent's caption. Like every other card it
collapses once you have marked it viewed.

**Clicking one opens it in place.** The picture fills the window over the page
you were on, with its caption and its position in the set ("2 of 3"). The `←`
and `→` keys — and the arrows either side of the image — walk through the rest,
so a set of screenshots is one look rather than a tab per picture. `Esc`, the
**Close** button or a click outside the image closes it and puts you back where
you were. To zoom into a detail, **Open full size** in the overlay gives you the
image on its own, in its own tab.

**You can ask about a screenshot.** Hover a caption and the same anchored "+"
the agent's report paragraphs carry appears next to it: the question is filed
against that caption, so the agent is told which picture you meant.

The images come from the task's artifact store through the dashboard itself, so
they are behind the same sign-in as everything else on the page and stay
readable long after the task's worktree is gone. Only raster images (png, jpeg,
gif, webp) are shown; a report naming anything else fails when the agent files
it, so a screenshot card never renders a broken image.

## The Verify tab

The latest agent turn's `how_to_verify` is **the** current set. Older turns'
steps sit under **Earlier verification steps**, each labelled with its turn
number and marked superseded — they were written against a branch that may no
longer exist in that shape, so treating them as a single accumulating "how to
check" document would present falsehoods as truths.

The section body stays plain markdown. Prose paragraphs render as text, and
every fenced code block becomes a **command panel** with a language label and a
one-click **Copy** button. A console-style block whose lines start with `$ `
copies with the prompt markers stripped, and each line gets its own copy
control. Without JavaScript (or without clipboard access) the buttons stay
hidden and each command is still a selectable code block, plus one line naming
`lazy shell <task>` as the terminal equivalent.

Each step has a **Verified** tick, saved with the rest of the review draft, so
it survives a reload and shows up on another device. The tick is keyed by turn,
step index, and the step's text: edit the step and it comes back unticked. The
tab badge and Current review both show "N of M verified".

Shell blocks also get **Run in shell**. A click opens a terminal **directly
under that step** — no jump to a panel at the top of the page — and runs the
block there, **inside the task's container**: the same text Copy would have
given you, in the place the agent worked. A step whose session is already live
shows **Open** and **Re-run** instead of stacking a second terminal. The
[Shell tab](web-shell.md) lists that session and links to it; it does not draw
a second copy. Maximise enlarges the same terminal in place.

Blocks tagged as data or source (`json`, `toml`, `ts`, …) are not runnable and
show Copy only, and when no shell can be opened Run is disabled with the reason.
A stopped container is not one of those reasons: Run starts the container and
narrates the start in the terminal it opens.

When the agent gave no verification steps, the tab still renders and says so
— an absent tab would hide the gap; the visible one is what gets it filled
next turn.

## What the Stats tab means

The **Stats** tab answers one question: where did this task's time and tokens
actually go. It is an insight surface, so every number on it is either sourced
from something lazy recorded or marked *not recorded*. Nothing is estimated,
and nothing is filled in by a plausible guess.

### This task, or the whole subtree

A task that drives subtasks — a parent task, a cluster — does almost none of its
own work, so its own turns are not its spend. When a task has anything nested
under it, the tab opens on the **subtree** view: this task plus every descendant,
at every depth. A toggle at the top switches to **This task only**, and a line
under it always says which of the two you are reading. A task with nothing
nested under it has no toggle, because both views would be the same numbers.

Turn counts, token totals and charts, commits and the per-tool table are all
sums over the subtree, with the tool rows merged by tool name. **Time is not
summed** — see below.

The same rollup is on the CLI: `lazy stats tokens --task <task> --subtree` and
`lazy stats tools <task> --subtree`.

### The four tiles

**Turns** is every turn on the task, split into agent turns and the human or
builder turns that asked for them. **Elapsed** is wall clock from creation to
completion, or to now if the task is still going. **Tokens** is the total the
agent reported across its turns, with a note saying how many turns reported
usage at all. **Commits** is the count on the task's branch.

### Where the time went

The split — *Agent running*, *Awaiting a human*, *In backlog* — is derived
from the task's recorded status history, and it is **wall clock**. A task left
blocked overnight really did spend those hours blocked. That is not the same
thing as an agent burning tokens for those hours, and the tab says so, because
confusing the two is the easiest way to misread a spend.

*Agent running* covers the statuses where lazy is doing the work (working,
pairing, merging). *Awaiting a human* covers everything that is stopped and
waiting for you — blocked, a merge conflict, a submitted PR, an interrupted
turn. *In backlog* is the time before the task was ever started.

If the task has direct subtasks, one more line tells you how much of the
running time overlapped a subtask that was itself running. A cluster task's agent
sits in *working* while it waits for a child, so that time is a **subset** of
the running time rather than a fourth slice of the clock.

**In the subtree view, time is combined rather than added.** A parent sits in
*working* for exactly as long as its children run, so adding the wall clocks
would bill the same minute two or three times. The bar is instead the time
during which **at least one** task in the subtree was in that state — running
takes precedence over awaiting, awaiting over backlog, so the three still divide
one window. The added-up figure is a real number too, and is printed next to the
bar along with how much of it is time two or more tasks ran at once. A stretch
during which every task was finished and the next not yet created belongs to no
state at all and is shown as *No task active* rather than folded into one.

Per-turn agent runtime is **not recorded anywhere**, so it is not shown. The
per-turn table's *Span* column is the gap between one turn's timestamp and the
previous turn's — which includes however long the turn sat waiting for you.

### Tokens

The legend gives the four counters — input, output, cache read, cache write —
with totals and shares. **Per turn** stacks those four for every agent turn,
oldest on the left; **Cumulative** is the same turns as a running total, which
is the one to look at when you want to know whether spend is accelerating.

A turn that reported no token usage is **absent from the chart**, not drawn as
a zero-height bar: usage is recorded when the agent reports it, and a missing
report is not a free turn. The count of such turns is printed under the chart.
On a task with a great many turns the charts show the most recent ones and say
how many earlier turns, worth how many tokens, are in the totals but off the
chart — the totals are always complete.

**Per-turn numbers** under the charts is the same data as a table, including
the model and effort each turn ran with. `unknown` there means the turn predates
that field being recorded; lazy never back-fills it with today's default. In the
subtree view the table gains a **Task** column and the merged series is ordered
by time rather than by turn number — every task has a turn 1, so turn numbers
alone would interleave unrelated conversations.

### Tools

As lazy's proxy forwards each model request, it folds that request's tool calls
into the task's own **tool record**. The table covers the task's whole life and
nothing in it expires. A task with no record — one that ran before lazy started
keeping them, or whose traffic did not go through the proxy — shows a line
saying exactly that, which is not the same claim as "this task called no tools".

The table gives, per tool: how many times it was called, how many tokens its
results added, that tool's share of those tokens, and the average per call.

**What the Tokens column means matters.** It is the size of what that tool's
results put into the conversation — the output the tool handed back — measured
once per call. It is **not** that tool's share of the model bill. Those are
different numbers, and the second one is not knowable: a request is billed as a
whole, and one model response routinely asks for several tools at once, so
splitting a request's usage across them would be invented. lazy does not do it.

The number you want for "which tool should I reduce" is usually **Per call**.
Three cheap reads and one enormous fetch are not the same problem, and the call
count alone cannot tell them apart.

Expect the tokens the proxy observed for the same requests — printed above the
table — to be far larger than the tool totals. That is not a contradiction:
every request re-sends the whole conversation those results sit in, so a large
result is paid for again, more cheaply, on every turn after it. That is exactly
why a verbose tool is worth finding.

Two lines may appear under the table, and both exist so the rows add up
honestly. Results recorded before lazy measured their size are counted as **not
recorded**, never as zero. Results answering a call lazy never saw — a
conversation already under way when recording started — have no known tool, so
their tokens are reported separately rather than filed under a guess.

The same breakdown is on the CLI as `lazy stats tools <task>` — same numbers,
same caveats, for when you are tuning spend from a terminal and do not want to
open the dashboard. Add `--subtree` there to fold in every descendant, exactly
as the tab's subtree view does. `--since` asks a different question: what a
task's tools cost over a stretch of time, which only the proxy's bounded audit
trail can answer, so that reading is a recent window and says so.

### No costs

The tab shows no money. lazy has no price table, and a hardcoded one would go
stale without anyone noticing — so it says nothing rather than something wrong.

## The Services card

The Services card lists the `[serve]` services the task declares and says, for
each one, whether anything is actually answering. Liveness is measured by the
daemon, not by your browser: a bare TCP connect to the published port, opened
and closed, never a request to the app. Three states, and they look different on
purpose:

- **Listening** — a green dot and a clickable URL: the task's own name for that
  service, `http://<service>.<task>.lazy.localhost:<port>`. It is loopback-only,
  so it works from the machine the task runs on, which is the machine serving
  this page.
- **Published, nothing listening** — a hollow red dot and the plain text
  *nothing listening on port 3000*, deliberately **not** a link. The port is
  mapped, but no server is behind it, and the URL would only send you back to
  this same page with a banner on it — the card is already where that banner
  would point.
- **Container not running** — one line for the whole card, not one row per
  service, because every service is down for the same reason.

Each row also carries the `lazy url <task> <service>` command, with a Copy
button when your browser allows clipboard access.

If a task's own branch declares a `[serve]` port that the project root does
not, the Services tab lists it separately and shows `lazy forward <task> <port>`
as the way to reach it. A worktree `lazy.toml` never publishes the port itself —
only the project root's config does. The banner you see after opening a dead
service URL still lands on the task's first tab and links here.

### Start container

When a task's container is not running, the Services card offers a **Start
container** button. It brings the task's container up through the same path
`lazy shell` uses — no turn is started, no agent runs, and nothing is committed.

This is the one place the button lives, because the Services card is the one
place with nothing to open: everywhere else — Watch, Shell, Pair, Chat, and Run
on a verification step — asking for the thing starts the container as part of
doing it, and shows the start's progress on that panel's own status line. A
Start button appears next to a terminal only after a start has failed, with the
failure text beside it.

Opening a page never starts anything, and two panels opened together share one
start rather than launching two containers. Starting usually takes seconds, but
if the image has to be rebuilt it can take minutes, so whatever surface you
asked from shows what the launch is doing until it finishes or fails. Nothing is
started for a task that is closed or complete, or for a runner with no
containers (the `host-process` runner shares your machine's network, so there is
nothing to start).

### Start services

Once your project has a Start services command, the card also offers a
**Start services** button.

The Services card lets you **designate** the command: type it (for example
`bin/dev`) and save. It is one command for the whole project, not a per-task
override, and it is saved in the project's store — lazy does not edit your
`lazy.toml`. The command must be a single line. You can change it the same way
later, from any task's Services card; Lazy Teams offers the same control on its
Services card. After it is saved, **Start services** appears whenever the shell
is available.

To remove it, press **Clear command** on the Services card. The project then
has no Start services command until someone designates one again — a
`start_services_cmd` still sitting in `lazy.toml` is not read back.

If your `lazy.toml` already sets `start_services_cmd` in `[serve]`, the daemon
imports that value into the store the next time it starts, so it keeps working.
After the import, the store's value is the one used; edit it from the Services
card rather than in `lazy.toml` (or clear it there).

Pressing **Start services** opens the web shell on that task and runs the
command there, in the container, so you watch the output in a real terminal
instead of a spinner. The command never comes from a task's own files, which the
agent working in that task can edit.

That is the whole point of the key: your agents do not have to leave a dev
server running for you to look at their work. They end their turn; you press the
button.

## Navigating a long review

**Changes** can hold dozens of files, and Summary has the report cards.

The first cut on a large branch is the **Regions tab**, which sits before
Changes: it lists the groups the agent's walkthrough declares, in the order it
declared them with `Other changes` last, each with its size, its tier, its owner
and the line the walkthrough wrote about it — on `Other changes`, how many of the
change's files the walkthrough never named. Picking one opens Changes
with `?region=<id>` applied, so a scoped review is a link you can send to
someone. Past the twelfth region the rest fold under **Other regions** rather
than disappearing. See [Review regions](review-regions.md).

Within whatever you are looking at, viewed ticks and keyboard navigation follow
the section you are in:

- **The card header stays with you.** Scrolling through a long file keeps that
  file's header — its path, its `+`/`−` counts, Approve / Reject, Viewed —
  parked directly under the tab strip, so you never have to scroll back up to
  find out what you are reading or how to accept it. Scroll out of one card and
  into the next and the header swaps with it. Markdown cards do the same. Moving
  with `j` / `k` (or following a link to a file) lands with the header visible
  rather than tucked behind the tabs.

- **Viewed** — every file and every markdown card carries a Viewed checkbox.
  Tick it and the section collapses to its header line; the tick is remembered
  per task on your machine and clears itself if the content changes before you
  come back. **Approving a protected file also ticks its Viewed box** — the
  decision means you are done with that file — while rejecting leaves it
  unticked, since you may want to look again. Approve/Reject is one control
  on the **file** header: a walkthrough that splits a file into several
  hunks still decides the file once, not each hunk. Opening a viewed card
  (the chevron) clears the tick: an open card is not viewed, and the
  checkbox always matches.
- **A current section** — one section at a time can be *current*, marked with
  an accent bar and outline. `j`/`k` (press `?` for the legend) move it in page
  order; clicking inside a section also makes it current. Scrolling alone never
  moves it, so the marker is a reliable "where was I". When you start
  navigating with no current section, the first section visible at the top of
  the window becomes current. Navigating to a section you have already marked
  Viewed leaves it collapsed and scrolls to its header; re-opening it is the
  chevron, which clears the tick.

Keyboard shortcuts act on the current section (press `?` on the page for the
same list):

| Key | Action |
|---|---|
| `j` / `n` | next section |
| `k` / `p` | previous section |
| `v` | mark Viewed and go to the next section |
| `v` (already viewed) | un-view it and stay put |
| `a` | approve (protected file with a decision control) |
| `r` | reject (same) |
| `s` | toggle diff layout (Unified / Split) |
| `w` | toggle Wrap for long lines |
| `f` | toggle Files (Presented / Source), on a page that has something to present |
| Hold `Shift` | show key hints beside the controls that have one |
| `?` | show / hide the shortcut legend |

`v` advances on purpose: ticking a section off is how you say "done with this
one, next". Un-ticking is a correction, so it leaves you where you are. Use
`j` / `n` to move without deciding anything.

`s` / `w` / `f` click the same toolbar buttons your mouse would (below), so a
disabled Split button below the 900px breakpoint stays disabled for the key
too — there is no way around that layout limit from the keyboard. A page with
nothing to present has no Files control, so `f` simply does nothing there.

To discover shortcuts without leaving the page, hold `Shift` for about half a
second: a small key hint appears next to every control that has one — the `?`
help, the current section's Viewed checkbox,
and its Approve / Reject buttons. Release `Shift` and they disappear. Opening
the `?` legend shows them too.

Shortcuts are ignored while you are typing in any input or while a dialog is
open. The current section is a reading position, not review state — it is not
persisted, and none of this touches the server except the approve/reject posts
that already exist. Without JavaScript there are no navigation controls and
every section is simply expanded.

These page shortcuts never use `Ctrl` / `Cmd`. The global command palette
(`Ctrl/Cmd+K` and `Ctrl/Cmd+Shift+K`) is separate — see [Command
palette](#command-palette).

**The same navigation works on a task's detail page** (`/tasks/<task>`), which is
built from the same cards — chunks, comments, journal entries and raised items.
`j` / `k` / `v` and the Shift hints behave identically there; `a` and `r` do
nothing, because a task page has no approve/reject control.

**On the Turns tab a card is a chunk**, so `j` / `k` / `n` / `p` move a whole
chunk at a time and `v` ticks the chunk off. The turns inside are collapsible
individually, but they are not separate stops — a nudge and the work it caused
are one thing to read.

**A link to a single turn** (`/tasks/<task>/turns/<n>`) opens the Turns tab
scrolled to that turn, inside its chunk. Old links and pasted URLs keep
working; a turn the task does not have is still a 404. If you had already
ticked that chunk off, a **turn** link re-opens it — you asked for that turn by
name, so it is shown rather than hidden behind the collapsed header, and the
Viewed tick clears to match (exactly as re-opening it by hand would).

Only a turn link does that, and only when you follow one. Links to a comment or
a journal entry — the rows on *Since you last looked*, for instance — scroll to
the note without re-opening a chunk you have ticked off. Neither does reloading
the page, going Back to it, or reopening a restored tab: the tick you set after
following the link stays set. Following one never quietly undoes review progress
you have recorded.

## Times

Every turn, note, report and review card says when it happened, without a
click. The visible form is relative — "3m ago", "5d ago" — because that is what
you read a page with; hover it for the exact UTC time.

Those relative times **keep up while the page is open**. Task pages are the kind
you park — the Turns tab is where you sit while a task runs — so a "2m ago"
rendered when the page was served would otherwise go on saying "2m ago" an hour
later. It is recomputed on a timer, including for content that arrived after the
page loaded, so what you read is what is true now.

A timestamp lazy cannot make sense of reads `unknown` rather than a guess.

## When an accept is refused

An accept can be refused for many reasons: the protection gate wants an approval
passphrase, files were touched that the task was not allowed to touch, the branch
is behind its parent, a merge is half-finished, the task has no commits. A bare
"accept failed" leaves the reviewer with nowhere to go, so every refusal renders a
**remedy panel** above the diff — or, with scripting on, **inside the Accept
dialog** as the failed step plus the in-page action, so the refusal is not
shown twice:

- **what to do next**, in a sentence;
- the **files involved**, when the refusal is about specific paths (the motivating
  case is a task with dozens of protected files — nobody is retyping those);
- an **in-page action** when one exists — the passphrase form for a gated accept
  (primary, right under the failed step), or a *Sync with parent* button for a
  branch that is behind or conflicted;
- the **exact CLI command**, complete and copy-pasteable, always. For a
  conflict task that already has approved files it includes `--approve-file`
  for each of them and `--reason` if you typed one. It is the fallback when
  there is no in-page action, and the secondary alternative when there is.

### The daemon owns the remedy, the page only renders it

The refusal→remedy mapping lives in the daemon, next to the code that refuses:
every refusal carries a structured remedy (the reason, the next step, and where
they apply the command, in-page action and files) alongside its message. The web layer never pattern-matches
the prose of an error message to decide what to offer, and it never re-derives a
command from config. A refusal the daemon has not mapped simply has no remedy
panel: the daemon's own message is still shown verbatim, so an unmapped case
degrades to what the page did before, never to a dead end.

### The passphrase is a human surface, deliberately

`lazy approve` has no MCP equivalent on purpose — an agent must not be able to
satisfy its own gate. That asymmetry is about *agents*, not about terminals: a
person at Current review is exactly the human the gate was written for, so the
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
Approved protected files ride the same way (`approved_files` hidden fields), so
a passphrase retry of a conflict-task accept cannot drop a file you already
ticked ✅. The CLI treats what you typed in
`$EDITOR` the same way: your input is never dropped.

### A review in progress belongs to the task, not to the tab

Reviewing a change is not a single sitting. You read half the diff, type half a
thought into the feedback box, go look at something else, and come back — maybe
in another tab, maybe in another browser, maybe tomorrow. All of that comes
back:

- **Unsent feedback** and an **unsent accept reason** are saved as you type
  (debounced) and filled back into their boxes on the next load.
- **A half-typed comment on a line, a report paragraph or a presented block** is
  saved the same way, under the box you opened it in — and the box is re-opened
  with your words in it, with the cursor where you left it. That is what makes
  the page safe to move underneath you: expanding context to see what surrounds
  a change, switching between unified and side-by-side, the page refreshing
  itself while the agent works, or an accidental reload no longer costs you the
  question you were half way through writing. Sending it or pressing **Cancel**
  clears it; nothing else does. A box with words in it is never closed behind
  your back.

  **A box always comes back somewhere you can see it.** If the line it was
  written on is not on the page — it is inside a collapsed file or an
  unexpanded stretch of context, it is in a view this tab is not showing
  (Presented / Source, or Changes: Presented / Raw files), or the agent has
  rewritten the file since — the box re-opens **above the diff** instead,
  labelled with the file and line it belongs to. You can read it, edit it and
  send it from there. Nothing is ever restored into a pane you are not looking
  at, and the page never switches views by itself to show you one.

  If a review somehow ends up holding the maximum number of unsent boxes at
  once, the box that cannot be kept is named — the rest of what you typed still
  saves, and the words stay in the box.

  Each box is saved on its own, so **two tabs cannot erase each other's work**:
  a tab only ever writes the box you are typing in, and everything else on the
  task is left as it stands. What a tab shows you is the state of the review
  when that tab loaded — a box opened in the other tab since then appears when
  you reload — but nothing you have typed in either can be deleted by the
  other. Two boxes that happen to sit on the same line of the same file (a
  comment on the diff row, and a question about the rendered document or the
  diagram that line produced) are two drafts, not one.
- **Viewed / collapsed ticks** on each file are saved the same way, keyed by the
  file's content hash — so a file that CHANGED under you comes back unviewed
  rather than falsely ticked.
The draft lives on the task in lazy's own storage, so a second tab, a second
browser, and the same page tomorrow all show the same review in progress.
Nothing about it is kept in the browser. Two exceptions, deliberately: the
**view-mode toolbars** (Unified/Split, Scroll/Wrap, Files Presented/Source, and
the Changes block's own Presented/Raw files) stay in `localStorage`, because
those are per-machine display preferences rather than review work.

A draft is cleared only when its words have actually been **delivered** — the
unblock that carries the feedback, the accept that carries the reason. A refused
accept or a failed unblock leaves it exactly where it was. It does not matter
where you deliver them from: typing feedback on this page and then running
`lazy unblock` in a terminal clears the draft too, because the clear happens
where the unblock does. An **Unblock** pressed under a comment box or in the
Ask dialog delivers the words in *that* box, not your draft, so the draft stays
until the Unblock box's own Unblock (or a terminal unblock) sends it.

Drafts are keyed per reviewer. On the daemon's own dashboard, which has no
sign-in, there is one reviewer; in Lazy Teams the key is the signed-in member,
and the daemon takes it from the authenticated caller rather than from the
request — so nobody can read or overwrite someone else's unsent words. That is
one key, not a multi-user review model.

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

### Unblock from the same box

Every box that offers **Ask agent** also offers **Unblock**: the row is always
**Ask agent · Add comment · Unblock · Cancel**. Unblock saves what you typed as a
comment on that line, report paragraph or document — exactly as **Add comment**
would, anchor and quote included — and then unblocks the task, so the agent starts
working on it straight away, along with any other comments you had queued. If the
task cannot be unblocked right now (it is still working, say), the comment stays
queued for your next unblock and the box says why nothing started.

An action the task cannot take right now is shown disabled, with the reason when
you hover over it, rather than hidden. The **Ask** dialog offers the same row: its
**Add comment** saves a task comment (as `lazy comment` does, starting nothing) and
its **Unblock** sends the text as unblock feedback. The steps on the **Verify** tab
take the same **+** as the report, and each command block has a **Comment** button, so
you can ask, comment or unblock about the exact step you are checking. The Ask dialog
itself lives on the **Current review** tab.

Worked example — the reviewer posts C1 (comment), A1 (ask), C2 (comment), A2
(ask), then unblocks. The agent sees exactly **three** turns: A1's ask and reply,
A2's ask and reply, then a single work turn carrying C1 + C2 with their anchors
plus the reviewer's unblock message.

**A comment never becomes a work turn on its own** — a reviewer marking up ten lines should produce one
turn, not ten. This mirrors how lazy already treats forge PR comments: collect,
then react in batch.

Both modes stand alone. Comment-only-then-unblock (accumulate, then answer) and
ask-only (pure conversation, no code change) are equally legitimate, and an
unblock with nothing queued behaves exactly as it did before: the message alone,
unwrapped.

### Asks

An ask persists the comment, then answers it. While the task is paused for
review and its agent session can still be resumed, the answer comes from that
agent in **reflective mode** (same machinery as `lazy_ask`). Once it cannot —
the task is finished, its session has ended, its worktree is gone — the question
is answered from what lazy STORED about the task instead: its turns, its raised
items, its commits and its diff, read by a throwaway read-only agent. Either
way the answer is persisted as a reply in the same thread, anchored to the same
line; the human can reply again and the thread accumulates. Ask turns never
change code.

A record-derived answer **says so**, in the reply itself and above the ask box:
it is not the original agent and it is not looking at a live worktree. Only a
task that has never run has nothing to answer from.

**Line-anchored asks** are posted from the diff's gutter buttons; **task-level
asks** are posted from the Ask dialog on Current review (or via
`POST /tasks/:task/review/ask`). Task-level threads appear in `taskThreads` in the
poll payload and render on Current review with their delivery state. Unblock,
Ask and Accept are three buttons on that page; each opens a dialog that
narrates the operation the way the CLI does, then closes on success or stays
open on failure. Without JS the same forms still post. The sticky status
bar carries `data-rv-askable` so a question asked while the agent is busy is
saved and can be re-sent.

**Asks are filed with the review they belong to.** When you end a review —
the unblock that delivers it, or the accept that finishes the task — every
question that has been answered is marked filed and moves out of the **Asks**
list into a collapsed **Filed asks** section on the same page. Nothing is
deleted: the question, the agent's answer and their state stay exactly as they
were, one click away. Questions the agent has *not* consumed are deliberately
never filed — one still in flight, and one whose dispatch failed (whose only
**Re-send to agent** button lives on that thread) — so they stay in the list
until they are answered. Nor is a thread filed while it still carries a comment
waiting to be delivered: replying to an answer with *Add comment* keeps that
conversation in the open list until your next unblock takes it.

The list is what is still open, so a conversation the agent has nothing left to
take — every question answered and submitted, every comment delivered — sits
under **Filed asks**, including one you only ever commented on.

Filing happens when *you* submit a review — your Unblock, your Accept, or the
auto-fix unblock you asked for when you started a formal review. Work the
daemon starts on its own does not file anything.

**Reply** on a task-level thread offers the same two intents as a reply on a
line thread: *Ask agent* (answered now, read-only) or *Add comment* (queued for
your next unblock). Reading an answer and wanting to say "alright, do that"
without hunting for a code line to attach it to is the common case, so it is a
plain comment on the conversation you are already in.

Which of the two routes a question takes — and the one case where neither is
possible — is decided in exactly one place in the daemon, and drives every surface: the daemon's dispatch,
the note shown above the comment box *before* the reviewer types, the sticky
status bar, `lazy ask` and the `lazy_ask` MCP tool. A question that cannot be
answered at all is still saved, marked `failed` with the reason, and the thread
offers a **Re-send to agent** button
(`POST /tasks/:task/review/comment/:id/retry`) so it never has to be typed twice.
Retry re-checks availability: still unanswerable → the current reason is
re-recorded and the question is untouched; otherwise it is dispatched as-is into
its original thread, by whichever route now applies. Retrying an ask already in flight is a no-op, and retry refuses anything
that is not one of the reviewer's own questions (a queued comment is delivered by
unblock, not by an ask).

### Promoting a discussion into a task

A discussion is where the work a task did *not* do usually gets named: you ask
why something is the way it is, the answer explains, and the next task is
sitting there in plain text. **Promote to a task** on any answered task-level
thread writes it down.

The form is seeded from the discussion and everything in it is editable before
anything is created:

- **Goal** — the first sentence of your own question.
- **Code** — derived from that goal; a collision gets a `-2`, `-3` suffix.
- **Where it goes** — a subtask of this task (the default) or a sibling of it.
- **Prompt** — the whole exchange verbatim, your question and the agent's
  answer, plus a line saying which task it was promoted from. Withdrawn
  messages are left out.

The created task is a **backlog** task. Nothing starts until you start it — the
web UI never auto-starts work. It inherits the originating task's agent, model
and effort, exactly as a promoted [raised item](raised-items.md) does, and goes
through the same task-seeding path.

One promotion per discussion: the link is recorded on the thread, which then
shows **Promoted to `<code>`** instead of the form, and a second press is
refused naming the task the first one made.

It is a plain form (`POST /tasks/:task/review/thread/:thread/promote`), so it
works with scripting off, and it is post-redirect-get, so a refresh cannot
promote twice.

### Comments

A comment is persisted with `delivery_state: 'pending_delivery'` and nothing else
happens — no dispatch, and deliberately **no status gate**: a reviewer may mark up
the diff of a task that is busy or not yet askable, and the notes keep until an
unblock can carry them. The task page previews everything queued and both the
page and the queue show the count, so the reviewer never has to remember what
they wrote.

On unblock, every undelivered comment is rendered into one prompt with its anchor (file, line, side, the
line's text) and any ask conversation that already happened on that thread —
without it, "do what we just agreed" reads as a non-sequitur. The reviewer's
overall message follows.

Two kinds of comment have no diff line to name. A **prose-anchored** comment (on
the agent's report or a raised item — see below) is delivered with
the line it points at quoted, not with a file and line number. A **reply on a
task-level thread** is delivered as a reply on that conversation, with the
question and the agent's answer quoted under it. A *fresh* task-level comment —
one that replies to nothing — is refused, because
that is exactly what the Unblock tab's message box already is.

"The next unblock" means **whichever unblock comes next, from any surface**: the
review page's form, `lazy unblock` in the terminal, or `lazy_unblock` over MCP
all run the same batching in the daemon. The CLI prints
`Also delivering N queued review comment(s)` so you are never surprised by what
the turn carries, and the MCP result reports the count.

A comment is marked `delivered` **only after the unblock turn actually launches**,
recording the turn number that carried it (and when). A failed launch leaves it
pending for the next attempt — the persist-first invariant, extended to the
batch path.

### Delivery state is always stated

Every reviewer-authored item on the page shows one of two states, so you never
have to unblock again just to ask the agent whether your note arrived:

- **Pending — rides the next unblock.** The item is durably saved but has not
  reached the agent. Queued comments say it under the message; a decided raised
  item says it next to its **Undo** button (undo works exactly as long as the
  decision has not been delivered).
- **Delivered in turn N (time).** The item reached the agent in that turn.
  Delivered items render as one compact line each — a delivered raised-item
  decision shows its outcome ("Promoted to subtask → the task", "Responded",
  "Dismissed") with the delivering turn, and offers **no undo**: the agent has
  read it, so the only honest correction is saying so in your next unblock.
  Records delivered before lazy stored the turn number (or delivered at accept,
  where no turn runs) show the timestamp alone.

Every decision is recorded the moment you apply it, blocking or not — a decided
item collapses to one compact line (its decision, any note, and a link to the
item) with no decide controls left behind. Deciding a blocking item is what
lifts it off the accept gate; deciding a non-blocking one only records that you
looked.

### Anchoring to the agent's prose

Diff lines are not the only thing worth reacting to: the sentence you want to
question is often in the agent's **report**. Hovering any line of the agent's
prose — a report section paragraph, a list item, a heading, a raised
item — shows the same small **+** the diff gutter has, and clicking it
opens the same two-intent form. "Why?" is an **Ask**, answered now in a
read-only turn; "track this separately" is a **Comment**, queued into your
next unblock. Same two verbs, same machinery, no third concept.

The anchor is a stable content hash of the block's text (plus its report
section), not a position — so it survives reloads and re-renders, and moves
only when the words themselves change. A thread whose anchor text is gone (the
agent reported again) is never lost: it falls back to a **Conversations on the
report** block with its quoted line, exactly as diff threads whose lines left
the diff do.

The agent never sees the anchor's internals. A prose-anchored message is
delivered as *"On your report, the line:"* followed by the quoted text — in an
ask turn immediately, or in the batched unblock prompt alongside the diff-line
comments. The queued list shows these as *"on the report: «quoted text»"*
instead of a file link, and they count toward the queued total like any other
comment.

### Withdrawing: retracted, not deleted

A reviewer can take back one of their own messages while it is still theirs to
take back — a queued comment, or a question whose ask failed (which by
definition never reached the agent, and whose **Re-send to agent** button the
reviewer may simply not want). `POST /review/:task/comment/:id/withdraw`, a
plain form with a redirect for the same reason retry is one.

It is a **state, not a delete**: `withdrawn_at` is stamped on the record, which
keeps its place in its thread (struck through, so the reviewer can see what they
took back) while no longer counting as awaiting delivery — and therefore out of the
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
an answered question, and anything the agent wrote. One rule in the daemon drives its
refusal, the page's explanation, and the notice after a POST.

### Ordering: asks first

Asks and the unblock work turn share one per-task queue in the daemon, so a
reviewer who asks a question and then unblocks in the same breath gets the answer
before the work starts. One failed ask does not strand the asks or the unblock
behind it.

## Design decisions worth knowing

### Comments are their own storage entity

Inline review comments are stored separately from ordinary task comments.

- **They are a batch, not a stream of notes.** A task comment is
  delivered wholesale into the next turn's prompt; a review is a marked-up diff
  whose remarks are anchored to lines and threaded, and which the reviewer sends
  when it is complete. Reusing task comments would flatten every anchor and mix
  half-written review notes into the next turn.
- They carry an anchor (`file`, `line`, `side`) and a thread, which
  a task comment has no place for.

### The message is saved before anything is attempted

lazy never loses what you typed. Posting writes the reviewer's words
to the store *first*, then decides what to do with them — for an ask, that
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

Asks *and* the unblock are serialized per task in the daemon: an ask holds the
task's worktree lock while it runs, and a second question or an unblock arriving
meanwhile is refused (409) rather than racing it.

### Current review is the one place a turn ends

The Current review tab holds the human's in-progress review: queued comments,
ask threads with their delivery state, an autosaved feedback box, and the
terminal actions. Unblock, Ask and Accept are dialogs, not an in-card tab
control; Submit sits on that same row. Reject and Sync sit beside them and also open dialogs. The
action block is rendered **once**. The diff lives on Changes, so there is no
second copy at the bottom of a long page and no script keeping two forms in
sync. While the task is working or pairing, Unblock and Accept are disabled
with a visible reason under the buttons; the sticky-bar poll flips that gate
live so a mid-review page never offers a click the daemon will refuse. Without
JavaScript, the noscript Unblock/Accept forms are omitted on that same first
paint (Ask still works) so a no-JS browser cannot POST into a 409 either.

A **Before you can accept** checklist names each open blocking raised item
and each protected file that still needs a decision, and links to the tab
that resolves it. A protected-file row opens that file's card on Changes
(not the top of the tab). It is disclosure only — the daemon still refuses
accept if anything is open.

Above it, **Declared done** / **Not declared done** says whether anybody has
said this work is finished, with who, when and at which commit. It is
information, not a gate: a task nobody declared is still yours to accept, and
what the declaration decides is whether lazy ran a review of it.

Unblock asks nothing about protected files and never reverts one. A pending
protected file neither blocks the Unblock dialog nor travels with it — the
decision belongs to accept, and the per-file ✅/⛔ controls on Changes are where
you make it, next to the diff it applies to. Unblock the agent as many times as
the work needs; the files keep the content the agent left.

The empty state is usable if you want to accept immediately: the checklist,
a progress line (queued comments, files viewed, verified steps), the
actions, and one sentence saying comments come from a line in Changes or
from the report on Summary.

**Submit** is on the task header (next to Sync) and on Current review next
to Accept, so you do not have to open the review tab to find it. It asks
before it opens a PR. A protected target is a checkbox (yes, create the PR).
An unprotected or unknown target requires typing the target branch name or
the task code — the same tiers as `lazy submit` and `lazy_submit`. If submit
cannot run (for example there is no remote), the dialog says why instead of
hiding the button. `--yes` skips the CLI prompt; MCP has no equivalent (it
uses a `confirmation_code` instead). On success the page shows the PR URL.

The Tasks list has a **Submitted** filter next to Working, Interrupted and
Blocked, and the dashboard throughput graph plots submitted tasks as their
own series.

The header also shows whether the task is behind its parent (as of last
fetch — no network). **Sync** on this tab and on Summary runs the same
action.

Queued comments are listed **in full**, never truncated: this list is the
reviewer's only record of what they have already written before they commit to
sending it. Each entry links to where its anchor lives — a Changes line, a
Summary report line, or a raised item. Diff-line anchors still use
`#l-<encoded path>-<side>-<line>`.

### The sticky status bar

A fixed footer always shows the task's status, turn count, last agent activity
and whether the agent can answer right now — the `lazy ls` facts, without
scrolling out of the diff.

Two of its items are about **your review**, not about any queue of work:

- **`N comments queued`** — review comments you have written and not sent. They
  all ride the next Unblock.
- **`N asks awaiting an answer`** — questions you asked the agent that it has
  not answered yet. Back to zero when the answer lands.

Each has a hover tooltip saying the same thing. Neither appears at all until
something has been queued or asked on this review — and once something has,
the counter stays visible even at zero, so you can watch it drain before you
accept.

On a **cluster** task the bar also carries the cluster's own progress: `Cluster: 3/8
accepted · running <child>`, with the running children linked. Those are the same
numbers `lazy show` prints and the Subtasks tab rolls up, derived from the
children themselves — accepted children out of the ones still expected to land,
what is running now, what the cluster set aside, and what it closed.

It is refreshed by the **same poll** that refreshes the threads and the
Unblock / Accept busy gate, which therefore now runs always: every 3s while an
ask is pending or the task is working/pairing, every 10s otherwise. That is a
deliberate stopgap: polling is simple and adequate at this scale, and server
push is the better answer once the surface justifies it.

While the task is working or pairing (for example during an agent Review),
Unblock and Accept stay disabled and the reason is visible under the buttons —
not only a hover tooltip — so a page left open mid-review cannot offer a click
the daemon will refuse.

### One diff renderer, shared by both pages

There is one diff renderer. It is a purpose-built
light-DOM unified-diff parser/renderer: every commentable line carries
`data-file` / `data-side` / `data-line`, and every page that shows a diff — the
review surface and commit detail — goes through it.

One renderer means one look, one set of behaviours, and
a feature built once shows up on both pages.

Anchors track the old and new numbering spaces independently — a deleted line
has only a pre-image number, an added line only a post-image number. Collapsing
them would make anchors ambiguous.

### The view toolbar, and side-by-side

Above every diff sits a toolbar of **view modes**, one group per mode, defined as
a list. Today that is
**Layout** (Unified / Split) and **Long lines** (Scroll / Wrap), plus **Files**
(Presented / Source) on any page that has something to present. Each choice is
one setting for the whole tool, not per file, persisted in `localStorage`
(`lazy:difflayout`, `lazy:diffwrap`, `lazy:diffpresented`) in a try/catch — a
private-mode browser loses the preference and nothing else. The controls ship
`hidden` and JS unhides them, so a diff still renders fully without JS.

The toolbar is **sticky**, so it never scrolls out of reach on a long review —
switch layout or wrap at whatever file you are currently reading, with no trip
back to the top. The same three toggles also have keyboard shortcuts (`s` / `w`
/ `f`, above), for the same reason.

What stays on screen while you scroll is a **stack of three**, each parked under
the one above it: the tab strip at the top, then this toolbar, then the header
of whichever file you are currently inside. All three are visible at once — the
file header is never tucked underneath the toolbar — so at any point in a long
review you can see where you are, what you are reading, and how to change the
view, without scrolling anywhere.

The list shape is the point. The review surface is heading towards *presenting* a
change (rendered markdown, diagrams, images) rather than printing its lines, and
every such mode needs an escape hatch back to the raw lines sitting right beside
it. Each new mode joins the same view switch — not a second kind of control
invented elsewhere on the page.

The **Files** group is that idea already in place. It is deliberately not named
after any file type: a presented pane and its source pane both ship in the page,
marked `data-rv-show="presented"` and `data-rv-show="source"`, and the switch
flips between them for every file that has both. A file with no presented form
has only the source pane, and the switch leaves it alone. Markdown is the first
type to grow one; nothing about the control assumes it is the last. The group is
labelled **Files** rather than **View** because the Changes block just above has
its own Presented / Raw files toggle for the agent's walkthrough — two different
questions, which must not read as one.

**Split is a DOM regrouping, not a stylesheet.** Pairing a deletion with the
addition that replaced it merges two `<tr>`s into one, and no CSS can change how
many rows a table has. The server groups each hunk's lines into rows (a change block's deletions zipped index-wise
against its additions, blank filler on whichever side runs out, context lines
occupying both panes) and the browser only regroups rows it is told about, **moving** existing cells rather
than re-rendering text — so nothing client-side can mis-escape a line of code.

Two consequences worth knowing:

- **The anchor moves one level down the tree, and only that.** A split row holds
  two lines, so it cannot carry one anchor: `data-file`/`data-side`/`data-line`
  and the anchor id land on the **code cell of the side they belong
  to**. Same values, same key, same fragment link — so a comment placed in split
  resolves identically in unified and survives a reload.
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

### Mermaid diagrams in diffs (and markdown)

A complete fenced block tagged `mermaid` — in a markdown file, or embedded in
any other text the diff shows — renders as a diagram instead of as raw source.
Each block has a **Diagram / Source** toggle: the diagram is the default once
it has rendered, and Source is the one-click escape hatch back to the exact
fence characters (including the `+`/`-` markers when the fence itself changed).

Only **complete** post-image fences are presented. A mid-edit fence with no
closing <code>```</code> stays as source. A fence that fails to render (invalid
syntax, timeout, library load failure) also stays as source, with a short error
on the page — never a blank pane. The library is vendored and served from
`/assets/mermaid.js` (no CDN); the page loads it only when a mermaid block is
present.

The fence lines keep their per-line comment anchors. The diagram is a
presentation row layered after the closing fence, not a replacement for those
rows — so commenting on a mermaid line still works the same way as on any other
line.

The toolbar also carries a **Comment** button, next to Diagram / Source: a
question about a diagram is asked while looking at the diagram, not after
switching back to the fence and hunting for the right line. It opens the same
Ask / Add comment box, anchored to the line the fence opens on, with the
diagram's source as the quote the agent receives.

### Threads survive a re-diff, even when their line moves

Threads whose anchor no longer appears in the current diff (the agent edited the
file, the hunk moved) are not dropped — they render in an **orphan threads**
section below the diff, with their original anchor. There is no re-anchoring
model yet; see [Known limits](#known-limits).

## Security posture

Two things guard this surface: a **browser session** and a **loopback bind**.

**The session.** Every dashboard route — every page, every asset, every `/api`
route — requires the cookie described in [Signing in](#signing-in). This
matters because the dashboard shares one TCP port with the daemon's `/rpc` and
`/mcp` endpoints, and task containers are given a route to that port so their
agents can use MCP. Until the session gate existed, an agent inside any task
container could read the whole task list and POST accept, unblock, close and
edit on the dashboard, using no credential at all.

The credentials an agent *does* hold do not open the dashboard: MCP tokens and
the shared daemon bearer token are refused by the gate, and a login link can be
minted only over `/rpc`, which refuses MCP tokens. The two credential systems
are deliberately separate.

`SameSite=Strict` on the session cookie is half the CSRF story for the mutating
routes: another *site* cannot make your browser use it. The cookie is
`HttpOnly`, and deliberately not `Secure` — the dashboard is plain HTTP on
loopback, where a `Secure` cookie would never be sent back at all.

The other half is an **origin check**, and it is there because task apps are
served on subdomains of the dashboard's own hostname. `SameSite` treats those as
the same site, so it would let a page served by a task post to a dashboard
route. Every request that can change state — any unsafe method, plus WebSocket
upgrades, which is how the web shell into a container is opened — must therefore
carry an `Origin` (or a `Sec-Fetch-Site`) that says it came from the dashboard
itself; anything else is refused with a `403` before the login ticket or the
cookie is even looked at. Safe `GET` navigations are exempt on purpose: they
change nothing, every mutating route answers `405` to one, and a link from a
task app back to the dashboard has to keep working. A request with neither
header is a non-browser client (curl, a script) and is allowed — it is not
carrying anyone's cookie by accident.

**No framing.** The origin check cannot see one last trick: a task's own app
could put the dashboard in an invisible `<iframe>`, cover it, and let one of
your clicks land on a real button behind it — a request that genuinely does come
from the dashboard. So every dashboard response refuses to be framed at all
(`Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY`).
Your own apps are unaffected: pages served through a task's hostname are passed
through untouched, including any framing rules they set for themselves.

**The bind.** The surface still **binds to loopback only**, and that is still
load-bearing: the sign-in gate is authentication, not hardening. Do not expose
it on another interface, a tunnel, or a reverse proxy. Treat that as a hard
constraint of the current implementation, not a configuration choice.

### Managed mode: no dashboard at all

On a managed daemon (a Lazy Teams fleet host — see
[managed-config.md](managed-config.md)) the dashboard does not exist. Every
page, asset, `/api` route, the login endpoint and `lazy dashboard` itself answer
with one line: *this daemon is managed; use Lazy Teams*. Pages and assets 404;
`lazy dashboard` exits non-zero with the same message.

`/rpc` and `/mcp` are untouched, which is why a managed host loses nothing:
Lazy Teams talks to daemons over `/rpc` with actor tokens, and never loads a
page from this surface.

Comment threads use exact `(file, line, side)` anchors. When a later turn moves
the lines a thread was anchored to, the thread is not re-anchored: it is listed
separately as an orphan thread, keeping its original anchor, rather than being
silently attached to the wrong line.

## Known limits

- Single-operator sign-in: one session credential for the machine's owner, no
  users, no passwords, no OAuth, and no per-browser sign-out. A session is a
  bearer credential — anyone who can read the cookie or an unspent login link is
  signed in.
- No re-anchoring: a thread whose line moved falls into the orphan list.
- No live updates; the island polls — 3s while an ask is pending, 10s
  otherwise — to keep the threads and the status bar current.
- Single reviewer assumed — comments record `actor: 'human'` with no identity.
- The queue lists `blocked` only; `conflict` tasks are askable but not listed.
- A queued comment cannot be *edited* before delivery — withdraw it and write it
  again. Withdrawal itself is one-way; there is no un-withdraw.
- No syntax highlighting, and no word-level intra-line diffing — the diff is
  plain text in both layouts. Complete `mermaid` fences are the exception:
  they render as diagrams with a Source toggle (incomplete or broken fences
  stay as source).
- The sync remedy starts a sync and reports it; the page does not follow the
  task through it — re-open the task page to see where it landed.
- Split shares one horizontal scroller across both panes, and an open comment
  form is dropped when the layout is toggled (a cloned `<textarea>` would lose
  what was typed).
- Mermaid rendering is post-image only: a changed fence shows the new diagram,
  not a before/after pair. Toggle to Source to inspect the character-level diff.
- Inside a blockquote the accent lands on the whole quote rather than the line
  within it, and a change that touches only blank lines opens its passage with
  no accent at all. Source has the exact lines in both cases.
- Without scripting, **Review** (and Accept, and the other long verbs) POST and
  wait on that one request. The dashboard cuts the page off after about 105
  seconds — the same deadline Accept hit before action dialogs — so a
  minutes-long review never finishes in the browser. Scripting-on follows the
  run in a dialog instead; or run `lazy review` in a terminal.
