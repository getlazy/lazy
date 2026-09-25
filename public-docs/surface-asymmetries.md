# Surface asymmetries: CLI vs MCP

Lazy exposes two control surfaces over the same daemon: the **CLI**
(the `lazy` commands a person runs) and the **MCP tool surface** (the `lazy_*`
tools advertised to the builder and to task agents). They are
not, and should not be, mirror images.

This document lists the asymmetries that are **deliberate**. If you are about to
file "the MCP surface is missing X" or "why does the CLI let me do Y but the
tool doesn't", check here first — every entry below is a design decision, not a
gap. A difference that is *not* listed here is most likely a real gap — see
[When you find an asymmetry that is not listed
here](#when-you-find-an-asymmetry-that-is-not-listed-here).

## The governing rule: tight MCP, lax CLI

A human at a terminal and an agent calling a tool make different mistakes. The
human mistypes an id, then reads the output and notices. The agent confidently
targets the wrong task, gets a plausible-looking result, and builds on it for
another twenty turns.

So the MCP surface is deliberately narrower and more friction-heavy than the
CLI. The CLI trusts its caller; MCP does not. When the two disagree, that is
usually the rule at work rather than drift.

## 1. Agent-ownership gating (writes only)

Task-mutating MCP tools check the caller. `ctx.taskId` non-empty means a **task
agent**; empty means the **builder**. The builder is unrestricted; a task agent
may only *change* its own task or a direct child.

**Reads are not gated at all, on purpose.** Every read-only tool — `lazy_search`, `lazy_show`, `lazy_diff`, `lazy_list`,
`lazy_blocked`, `lazy_active`, `lazy_status`, `lazy_wait`, the conversation
reads, `lazy_memory_recall` — works on ANY task in the project for an agent
caller. This is the **lazy flywheel**: agents learning from the work of the
agents before them, which was the day-one intent of the system.

Earlier versions gated `lazy_show` / `lazy_diff` / `lazy_wait` by ownership.
That broke the flywheel in practice — an agent told to read a prior task's
findings was refused and had to reconstruct them from search excerpts — so read
gating was removed. **Its absence is not a bug.**

**The one read an agent cannot make is `lazy_scratch`** (and `in:scratch` in
`lazy_search`, which is refused for an agent caller and filtered out of its
results). That is not task-ownership gating — no task owns the scratch sandbox.
It is the [builder↔human boundary](builder-scratch-dir.md): a writable
place the builder shares with agents would let it stage code there and tell an
agent to copy it in, dissolving the builder/agent separation. Capture made
scratch *durable and searchable*; it did not make it an agent channel. Agents
have `lazy_journal` for their own rationale and `lazy_memory_recall` for
cross-task knowledge.

`lazy_wait` is the one judgement call in that list: it mutates nothing but blocks
the caller's turn, so an agent can park up to 600 s on a peer task. It is open
anyway — the cost is bounded, falls entirely on the caller, and one arbitrary
exception to "reads are open" is worse than the risk it averts.

`lazy_wait` does have **one mechanical refusal: the caller's own task**
That is not an ownership rule — it is that the
wait can only ever time out. The caller's turn is exactly what would have to end
for the wait to return, so waiting on itself is a self-deadlock paid for at the
600 s timeout. The refusal message says so, and
points at the real options: wait on a subtask, or end the turn.

The write boundary comes down to three rules, plus a stricter one for
`lazy_start`:

| Rule | Applies to | Who may be targeted |
| --- | --- | --- |
| Ordinary write | unblock, ask, reject, close, stop, edit, reopen, submit, resume, sync | own task, or a direct child |
| Accept | accept | direct child only — an agent can never accept itself |
| Annotation | comment, tag, untag | direct child only — never a peer, never itself |
| Start | start | a direct child only, so an agent cannot restart itself |

### `lazy_journal` is ungated; `lazy_comment` is gated — deliberately

`lazy_journal` is the **one** write an agent may perform on any task in the
project. Every other write is scoped. The split is not an oversight, and the two
halves have the same single cause:

- A **comment is an instruct channel.** It is delivered into the target task's
  next turn prompt, so commenting on a peer task can steer that agent's work — or
  kick work off there. Peer reach on an instruct channel is out. Gated.
- A **journal entry informs and nothing more.** It never triggers a turn, and its
  text is never injected into any agent prompt. The most it produces is a
  mechanistic one-line COUNT in the target's next prompt ("N new journal entries
  since your last turn") plus the call to read them; the agent decides whether to
  look. A note left on a peer task can therefore be read later but can never act.
  That makes peer journaling safe, and useful — it is how one agent leaves a
  durable finding on work it does not own. Ungated.

#### The journal contract, precisely

The journal used to be described as flatly "prompt-immune". That phrasing was
load-bearing in the wrong place: it was read as "agents may not see the journal
at all", which cut agents off from things the human, the builder, and peer agents
were saying *about their own work*. The contract is narrower and stricter than
"never touches a prompt", and all four clauses hold:

1. **Non-triggering.** Appending an entry never starts, resumes, or auto-reacts a
   turn. `lazy journal` emits no daemon signal; nothing hooks a turn off a
   journal write. This is what makes ungated peer journaling safe.
2. **Bodies are never auto-injected.** No code path may place entry text into a
   prompt. Comments and journal entries remain separate entities with no shared
   prompt-assembly path, precisely so a body cannot leak by accident.
3. **Count-notice only.** Prompt assembly may derive exactly one thing from the
   journal: how many entries are new since the agent's last turn, rendered as a labelled block that is
   visually and semantically distinct from the notes/comments block. Count and
   pointer, never text.
4. **Reads are pull-based and open.** An agent may read its own task's journal on
   demand with `lazy_show(task_id="…", sections=["journal"])` — reads are open
   tree-wide. Pulling is the agent's choice; being
   told a count is not being told to act.

Comments **push**: full text, into the prompt, as guidance, unavoidably. The
journal is **pulled**: a count, then the agent's own decision. Keep that
distinction visible in every surface that describes either one.

No new read tool and no new `since` parameter were added for this. `lazy_show`'s
journal section already returns entries chronologically with `created_at` and
`actor`, and because the journal is append-only an entry's index never shifts —
so `offset = total - new` is a stable cursor to the first new entry, computed at
prompt-assembly time and embedded in the notice. The "cursor" for *which* entries
are new is the last agent turn's timestamp, the same cutoff comments already use;
no per-agent cursor state is stored anywhere.

`lazy_tag` / `lazy_untag` are gated with `lazy_comment`: tagging is a durable
regrouping of work the caller does not own.

### The annotation tools stop at direct subtasks — including "not itself"

The annotation rule is deliberately *narrower* than the ordinary write rule.
An agent may annotate a direct subtask and nothing else — not a peer, and **not
its own task**:

- **A comment on itself is circular.** The comment is delivered into the next
  turn's prompt, which for one's own task is one's own prompt. An agent that
  wants to say something about its own work has `lazy_journal` (rationale,
  decisions, memory) and `lazy_raise` (a question, a decision, or orthogonal work it spotted).
- **Tags on one's own task belong to the human and the builder.**
  They are labels *about* the work — which effort it groups under — not statements the worker makes about itself.
- **`lazy_untag` is blanket-refused on self** rather than restricted to tags the
  agent itself applied. Per-tag provenance would be real machinery for a
  capability nobody asked for; the simple rule is the right trade.

The precedent is the accept rule, which draws
the same child-only-never-self line. They are kept separate so each can refuse in
its own vocabulary: accept's message is about review authority, annotation's is
about who owns the labels.

The journal/comment split is not a gap waiting to be made symmetric — the
asymmetry *is* the design. Injecting journal entry *bodies* into agent prompts
would collapse it. The count notice is the deliberate,
bounded exception, and it is bounded on purpose: a count cannot instruct.

Additional per-tool caller rules:

- **`lazy_create`** — an agent's new task is always a child of its own task. A
  `parent` argument is accepted only when it equals `ctx.taskId`. Agents cannot
  create top-level tasks or tasks under someone else's parent.
- **`lazy_link`** — same parent gate as `lazy_create`. An agent may only adopt a
  branch or PR as a child of its own task (`parent` omitted or equal to
  `ctx.taskId`). The builder and the CLI can link a top-level task. The linked
  task is never auto-started.
- **`lazy_accept`** — a direct subtask only. Accepting your *own* task is the
  human's review decision and has no tool.
- **`lazy_edit`** — refuses to change `parent` when the caller is an agent.
- **`lazy_clone`, `lazy_redo`, `lazy_reparent`** — reject agent callers outright.
  All three reshape the task tree outside the caller's subtree.
- **`lazy_memory_save`** — builder-only. Memory records are injected into every
  future builder and agent launch; only the human and the builder curate them.
  Agents read memory freely (`lazy_memory_recall`) and are told to *report* what
  belongs in memory rather than write it.
- **`lazy_raised_promote`** — builder-only.
  Promotion turns a passive raised item into a backlog task; letting task agents
  do that would bypass builder vetting. Agents record items with `lazy_raise`;
  humans and the builder promote after review (`lazy raised promote` on the CLI).
- **`lazy_scratch`** — builder-only, and the only *read* that is. See the
  builder↔human boundary above; `lazy scratch` on the CLI is the human's side of
  the same surface.
- **`lazy_commit`, `lazy_raise`, `lazy_update_progress`** — agent-only.
  All three are defined relative to "the current task"; the builder has no current
  task, so calling them is an error rather than a no-op. `lazy_update_progress`
  additionally has no CLI counterpart at all: a human reporting their own progress
  to themselves is not a thing, and the human side of the channel is the reading
  side (`lazy list`, `lazy status`, `lazy show`, `lazy watch`).

The CLI has none of this. A human running `lazy accept` is the review authority.

**Gating is per-handler; the advertised list is a separate, softer decision.**
Every one of these tools has an unconditional refusal in its handler, keyed on
the caller identity, and that refusal is the enforcement — not what appears in
`tools/list`.

On top of that, the two lists above are also *hidden* from the caller who can
never use them: a builder is not offered the agent-only tools, and a task agent
is not offered the builder-only ones. A caller pays for the whole `tools/list`
reply before its first message, so advertising tools that will only ever be
refused is a context tax plus an invitation to waste a call. The role is known
where the server is built — builder launches pass no task id, task agents always
do.

Hiding is **advertisement only, never enforcement**. A hidden tool stays
registered with its real handler, so a caller whose context still lists it — a
stale system prompt, a resumed conversation, a hand-written client — gets that
handler's actionable refusal rather than the useless "Unknown tool". That is the
original rule intact: a refusal that explains itself is a better teacher than an
absent tool. What changed is only that a caller who was never going to get one
no longer reads the offer. Read-only turns (`lazy ask`) narrow *within* the
role rather than instead of it.

## 2. Two-step confirmation codes (MCP-only friction)

`lazy_accept`, `lazy_reject`, `lazy_close`, `lazy_reopen`, `lazy_redo`,
`lazy_submit` and `lazy_create` (when creating under `main` while an active
task exists) implement a two-step protocol: the
first call returns guidance plus a `confirmation_code`, and only a second call
carrying that code executes.

This is the MCP analogue of the CLI's interactive prompt and `--yes`. It is not
a straight port: the CLI prompt can be skipped with a flag the caller controls,
whereas the MCP code must be *echoed back from a prior response*, which no
single hallucinated call can produce. `lazy_accept` skips the two-step when the
diff is tiny — friction proportional to blast radius. `lazy submit` has `--yes`;
`lazy_submit` does not — that is deliberate: opening a PR is the same class of
irreversible remote action as accept/reject.

Do not add `--yes`-style bypass parameters to these tools.

## 3. MCP never auto-starts work

`lazy redo` starts the replacement task by default (`--no-start` opts out).
`lazy_redo` **never** starts it; the caller must call `lazy_start` separately.
Same for `lazy_clone` / `lazy_create` on both surfaces.

Rationale: starting a task spends money and holds an agent slot. One tool call
should not fan out into a running agent the caller didn't explicitly ask for.
Two calls is the right amount of friction.

For `lazy_redo` the gap does a second job: the replacement is created under the
SAME parent as the old task, and its branch is cut from that parent's HEAD only
when it starts. The pause between the two calls is the caller's window to
re-parent the replacement (`lazy_reparent`, or `lazy_edit` with `parent=""` for
top-level) before that branch exists. The tool description says so explicitly —
an earlier version claimed the replacement started "from current main", and a
caller who believed it lost a task's worth of work to a branch cut from the
inherited parent's release branch.

### Pinned clones: only a human or the builder lifts the pin

A clone made with `lazy clone --same-base` (or `--base`) is pinned to its base
commit so a re-run can be compared like for like (see
[Comparing runs](comparing-runs.md)). `lazy sync` from the CLI, the dashboard,
or the builder's `lazy_sync` merges the parent in and lifts the pin. An
agent's own `lazy_sync` on a pinned task does nothing and says the task is
pinned — as does every automatic sync. An agent must not be able to end a
comparison by itself.

`lazy_clone` has two shapes. Plain, it creates a "(variant)" CHILD of the
source. With `same_base` or `base`, it creates the same SIBLING `lazy clone`
does: a comparison run needs the same parent and goal, and a finished task
cannot take children.

## 4. Human-only commands with no MCP equivalent

- **Per-task custom container images** — when you run `lazy create`, `lazy start`,
  or `lazy edit` from a terminal inside a task worktree whose `Dockerfile.lazy`
  differs from the project's reference, lazy may ask whether to build that
  Dockerfile and use it for **this task**. That is a human TTY consent only:
  build steps run under the host's docker, so an agent must not be able to
  choose the image. There is deliberately no MCP tool, flag, or schema field
  for pinning a custom image. Non-interactive callers (`--yes`, scripts, the
  builder) never see the prompt and always get the project-root image (or a
  daemon-adopted upgrade image, if one is in effect). A subtask inherits a
  parent's already-pinned image on create so stacked work stays consistent
  without giving agents a chooser. `lazy clone` / `lazy redo` (and MCP
  `lazy_clone` / `lazy_redo`) are fresh starts — they use the root image and
  warn when the source or previous attempt had a pin, so you can re-pin from a
  task worktree TTY if needed.
- **Upgrade worktree adoption** — when you run `lazy upgrade` from a terminal,
  every rebuild first announces any valid daemon adoption (TTY: keep it, default
  yes; non-interactive: keep and log). A **new** worktree `Dockerfile.lazy` is
  offered only when cwd is anywhere inside that task worktree (subdirectories
  count) and its content differs from the project reference (default no).
  Running from the project root alone never offers a new adoption. Adoption is
  human TTY consent only and has no MCP surface. It lasts until the next
  upgrade rebuild decides again, and is visible in `lazy doctor` and on daemon
  startup.
- **The protected-merge passphrase at `lazy accept`** — a protected accept
  prompts for the approval passphrase and merges in the same invocation. The CLI
  prompt is TTY-only: no flag, no env var, no stdin route (stdin is the accept
  *reason*), and no MCP parameter can carry the token — the MCP `lazy_accept`
  refuses gated merges unconditionally. The approval token must originate
  outside the builder/agent context, or the gate is decoration. The refused
  builder's `reason` is captured on the task as a pending review the human's
  accept surfaces and attaches. (Pre-v0.22 this was a separate human-only
  `lazy approve` command; the collapse removed it along with its stored,
  floating approval token.) See
  [protected-branches.md](protected-branches.md).

  **The asymmetry is agents vs. humans, not terminal vs. browser.** The web
  review page (`/review/<task>`) asks the reviewer for the same passphrase and
  hands it to the daemon as that accept's inline token — a person sitting at the
  review page is the human the gate was written for. It is verified by the one
  edge gate inside the merge it authorizes, is never stored client-side and
  never logged, and a wrong one is a retryable error that re-offers the form.
  What stays closed is the MCP surface: no tool has a parameter that can carry
  the token, so the builder still cannot satisfy its own gate. See
  [web-review.md](web-review.md).
- **`lazy system passphrase`** (`set`/`status`/`delete`) — enrolling, rotating,
  or removing the machine's approval passphrase. No MCP tool, and — unusually —
  **no daemon RPC either**: enrollment writes the hashed store straight from the
  CLI process on the host, while verification stays daemon-side (inside
  accept). That split is the whole point. If
  enrollment travelled through the daemon, anything that can reach the daemon
  could enroll a *new* passphrase and then satisfy its own gate with it, which
  is the same failure as handing an agent the token.

  Three further restrictions on the CLI side, none of which are gaps: the
  command is **TTY-only** (no flag, no env var, no piped stdin — a
  non-interactive value lives on in shell history and agent transcripts);
  **rotation and deletion both require the current passphrase**, so "delete,
  then enroll my own" is not a one-step bypass; and it **refuses when it detects
  it is running inside a container**, because a task agent's container is not
  the human's terminal.

  "TTY-only" is enforced literally, and that costs something deliberately. The
  command checks for a real terminal itself, ignores every testing override,
  and **refuses outright if any
  prompt testing override is set at all**. Consequence, accepted: enrolling a
  passphrase cannot be driven from a test — because anything a test can drive,
  an agent running lazy from source can drive too. In a released binary those
  overrides are not merely ignored, they are compiled out entirely.

  Honest about the residual: on a machine where nothing has *ever* been
  enrolled, first enrollment is reachable by an agent under the **host-process**
  runner, which shares the user's account. Rotation is not, and the passphrase
  itself is never recoverable (only a hash is stored). Containerized execution
  — the default runner — is the real fix; this is documented rather than
  claimed closed. See
  [protected-branches.md](protected-branches.md#enrolling-the-passphrase-lazy-system-passphrase).
- **`lazy protect`** — edits the `[protection]` section of `lazy.toml`. Deciding
  what is protected is the human's call; an agent that could turn protection off
  makes protection meaningless.

  The asymmetry is on the WRITE side only. MCP `lazy_show` returns a read-only
  `protection` object (gates, target branch, whether a captured builder review
  is pending) so the builder can plan around a gate instead of discovering it
  as a refusal — reading state is harmless, arranging your own gates is not.
  See
  [protected-branches.md](protected-branches.md#seeing-a-gate-before-it-bites).
- **`lazy env`** (`set`/`list`/`unset`/`clear`) — per-task environment
  variables. The whole point of the feature is that one task holds a secret the
  others do not, and the task holding it is exactly the one running the agent
  that would be calling the tool. An agent that could read its own
  `lazy env list` learns the shape of its principal's secret store; one that
  could `set` could hand a token to a subtask it spawned. Neither read nor write
  is exposed, which makes this the one place where even a READ is withheld from
  agents — the flywheel argument in §1 is about learning from prior *work*, and
  a token is not work. The values leave the daemon exactly once, into the launch
  environment, so the agent gets its variable by having it in `process.env` and
  by no other route.
- **`lazy system agent`** — switching the project's default agent
  (`set <id>`, writes `[agent] agent_id` in lazy.toml) and storing an agent
  API key (`set-key <id>`, writes `~/.lazy/daemon/<slug>/agent-credentials.json`,
  mode 0600 and outside the repo every task container mounts) are human
  decisions with no MCP counterpart.
  Credentials especially: **agents must never write credentials** — an agent
  that can install the key it then authenticates with has minted its own
  access. Agents that need a different agent for a subtask already have the
  narrow, per-task `agent` parameter on `lazy_create`/`lazy_start`; the
  project-wide default and the key material stay with the human. That parameter
  is deliberately open to agents, and §18 explains why choosing an agent for a
  subtask is not a way to acquire a credential.
- **`lazy auth`** — storing, rotating and removing the project's model-provider
  credentials ([Credentials](credentials.md)) is human-only for the same reason,
  one step further up: this is the credential the *daemon itself* starts with
  and the proxy presents upstream. An agent able to write it could point every
  task on the project at an account of its choosing. Even `lazy auth list`,
  which prints no secret, has no MCP form — an agent has no decision to make
  about which credential is in effect, and the listing is a human diagnostic
  next to `lazy doctor`. The secret is read only from a masked prompt or piped
  stdin, so there is no argv form for an agent to reach for either.
- **`lazy revert`**, **`lazy pair`**, **`lazy chat`**, **`lazy shell`**,
  **`lazy browse -i`**, **`lazy builder`** — interactive or
  human-in-the-loop by nature.
- **`lazy init`**, **`lazy doctor`**, **`lazy upgrade`**, **`lazy daemon *`**,
  **`lazy system *`**, **`lazy config`**, **`lazy watch`**,
  **`lazy completion`**, **`lazy export-dockerfile`**, **`lazy logs`** —
  host and installation operations. Agents run *inside* the thing these
  commands manage; exposing them would let a task agent restart the daemon
  supervising it.
- **`lazy loop`**, **`lazy branch`** — orchestration verbs that
  belong to whoever is driving the session. (`lazy link` has `lazy_link` — see
  the create-like parent gate above.)

### System messages: agents may post, only the human's side may dismiss or mark read

- **`lazy_message_post` is open to task agents** — the inverse of the memory
  gate, on purpose. A system message is attributed data displayed TO the human,
  never injected into agent prompts as guidance, so agent creation is not a
  prompt-injection channel — and report tasks run as agents, so gating creation
  would break the feature's main producers. The `source` is derived server-side
  from the caller's identity (task code or `builder`), never taken as input.
  One caveat keeps that safety argument honest: unread TITLES are rendered
  into the *builder's* launch prompt, and the builder is itself an agent with
  write powers — which is why titles are single-line by contract. A title
  containing a newline or any control character is rejected at the post
  boundary, so an agent cannot smuggle multi-line, system-framed text (a fake
  heading or directive) into the builder's prompt through its one injected
  line. Bodies may be anything; they are only ever read on demand.
- **`lazy_message_dismiss` is builder/human-only** — same server-side
  `ctx.taskId` gate as `lazy_memory_save`. The inbox belongs to the human; an
  agent that could dismiss messages could silently empty it.
- **The CLI has no `lazy messages post`** — humans don't file reports to
  themselves; producers are MCP callers and the daemon. And **`lazy_messages`
  never marks a message read** while `lazy messages read` does: the MCP tool is
  classified as a read (pre-approved, served on ask turns), and
  read-state tracks the *human* having seen a message — a builder or agent
  fetching a body is not that. See [system-messages.md](system-messages.md).

## 5. Read-only turns

Read-only turns are served a reduced, read-only toolset so reflective turns — including
`lazy_ask` targets — cannot mutate state. `lazy_ask` is itself classified
**write** even though the *asking* is read-only, because it launches an agent
turn on another task. Whether a tool counts as a read is a judgement about its
effects, not something derivable from its schema.

There is no CLI counterpart; a human deciding to only look at things needs no
enforcement.

## 6. `lazy_internal_git` is validated but never advertised

`lazy_internal_git` is a plumbing tool lazy uses internally. It is reachable
over HTTP and therefore schema-validated like every other tool, but it never
appears in any advertised tool list: being callable and being offered are
different questions.

## 7. Presentation flags have no MCP analogue

`--json`, `--tree`, `--flat`, `--ids-only`, `--follow`, `--group`, `--full` and
friends shape terminal output. MCP tools return structured JSON already, so
these are not gaps. `--follow` in particular is a streaming terminal affordance;
the MCP equivalent is polling `lazy_wait`.

The corollary: an MCP tool returning a *differently shaped* object than the
CLI's `--json` is drift worth fixing, but an MCP tool having no `tree` parameter
is not.

## 8. Unblock always carries feedback; resume is the no-feedback path

Both surfaces refuse an empty unblock: `lazy_unblock`'s schema sets
`feedback` `minLength: 1`, and `lazy unblock` rejects a blank or missing
`--message`. That is deliberate — unblock exists to deliver human guidance, and
a silent one reads as guidance that got lost. Resuming a task *without* new
feedback is `lazy_resume` / `lazy resume`, which is why neither is deprecated.

## 9. `start` creates nothing — on either surface

Neither `lazy start` nor `lazy_start` accepts creation parameters. There is no
`--goal`, `--prompt`, `--code`, `--type` or `--parent` on `lazy start`, and
`lazy_start`'s schema takes `task_id` plus run-time overrides only. The only way
to make a task is `lazy create` / `lazy_create`, then start the id it returns.

This is the one entry here that is a *shared* restriction rather than a
CLI-vs-MCP asymmetry, and it is listed for the same reason as the rest: it looks
like a gap and keeps getting filed as one.

`lazy start` once had an inline create mode. It was removed deliberately, on
both surfaces at once.

Rationale: a task created inline is created and started in one irreversible
step, so any parameter the caller forgot is unfixable by the time anyone
notices — most damagingly `--parent`, which strands the task on the default
branch with a running agent already on it. Wrong parenting was the single
largest source of rework in the project, and agents in particular had a
documented habit of starting a task first and trying to reparent it after. The
create-then-start split makes creation cheap, reviewable and correctable:
`lazy edit` can still fix a backlog task's goal, prompt, code, type and parent,
and none of that is available once the agent is running.

So the fix for "I want a task code on a task I started" is
`lazy create --code <code> ... && lazy start <code>`, not a `--code` flag on
`start`.

## 10. Review settings are on both surfaces

A task's [review settings](review-paradigm.md) — mode, gate and auto-fix — are
not an asymmetry: `lazy create` / `lazy start` / `lazy edit` take `--review`,
`--review-gate` and `--review-auto-fix`, and `lazy_create` / `lazy_start` /
`lazy_edit` take `review`, `review_gate` and `review_auto_fix`. The one
restriction is who an agent may set them on — see
[`lazy_edit`'s review settings are refused on the caller's OWN
task](#lazy_edits-review-settings-are-refused-on-the-callers-own-task).

## 11. Asking a conversation: one polymorphic CLI id, a separate MCP tool

`lazy ask <id>` resolves its id the way `lazy show` does: a task id asks that
task's live agent, a stored conversation's session id (or a unique prefix) asks
a throwaway read-only agent that reads the transcript. MCP does not overload
`lazy_ask` the same way — a conversation ask is `lazy_conversation_ask`.

The reason is the ownership gate. `lazy_ask` is an ordinary write: a task
agent may only ask its own task or a direct child. A stored conversation has no
owner, no parent and no place in the task tree, so a polymorphic `lazy_ask`
would have to skip that gate for some values of `task_id` and enforce it for
others — exactly the "plausible-looking result on the wrong target" failure the
gate exists to prevent. A separate tool keeps each one's contract single.

Both surfaces share one implementation, including id resolution, so they
cannot drift into resolving the same string differently.

`lazy_conversation_ask` is classified as a write despite persisting nothing.
A read means "cannot change task state,
worktree contents, **or launch an agent**" — the ask launches one. Classified by
effect, not by what it stores. One consequence worth knowing: a read-only turn
(§5) serves read tools only, so an *asked* agent cannot ask a conversation. That
is the intended reading of "read-only" — an ask turn does not spawn more agents.

## 12. Artifacts: attach and read over MCP, remove only at a terminal

`lazy artifact` has four subcommands — `add`, `list`, `get`, `rm`. MCP has three
tools: `lazy_artifact_add`, `lazy_artifact_list`, `lazy_artifact_get`. There is
deliberately no `lazy_artifact_remove`.

An artifact is frequently the ONLY copy of something a human handed the task —
nine design files synced out of a tool that will not re-emit them identically,
a dump produced by a run that has ended. Attaching is additive and re-attaching
a name replaces it, so the worst an agent can do over MCP is add or overwrite
what it can also see. Deleting is the one artifact operation that destroys
something the caller did not create, and it takes two seconds at a terminal
(`lazy artifact rm <task> <name>`), so exposing it buys nothing and costs the
inputs.

Two smaller asymmetries in the same feature, both on the WRITE side:

- **`origin` defaults differ by caller, not by surface.** A task agent's attach
  defaults to `origin: 'output'` (it is publishing back); the builder's and the
  CLI's default to `'input'` (it is handing the task something). Either can pass
  `origin` explicitly — the field is a descriptive label for humans scanning
  `lazy artifact list`, never a permission.
- **Attach is ownership-gated like the other subtree writes** (own task or a
  direct subtask), while `list` and `get` are open
  tree-wide like every other read — the flywheel rule in §1. Reading a peer
  task's published report is exactly the cross-task learning reads are open for;
  writing files into a task you do not own is not.

Artifacts never instruct: attaching one creates no comment, changes no status
and triggers no turn, and the content is never injected into any prompt — a task
launch carries only names and sizes. That is the same
passive-write contract as raised items and the journal (§1), and it is why an
attach needs no delivery gate: a file the human wants ACTED ON is a comment.
See [artifacts.md](artifacts.md).

## 13. Machine one-shots have no MCP tool at all

Every machine one-shot — accept's fidelity summary, asking a question of a stored
conversation, `lazy report`, memory compaction — runs through one dispatcher which,
outside the daemon, calls a single daemon request that runs one.
(Asking a question of a *task* is not one of these: it resumes that task's own
agent session, so it is an ordinary turn on the task's model.) That verb is
reachable from the CLI and from inside the daemon. It is deliberately NOT an MCP
tool, and it should not become one.

A one-shot is the rawest primitive in the system: "run a model with this
arbitrary prompt". It has no task, so there is nothing for the ownership rule
to gate on (§1) — an agent calling it is not acting *on* anything, which means
the ownership rule that governs every other agent write has no purchase. The
places where an agent legitimately needs a model to read something for it are
already tools with an owner and a scope: `lazy_ask` / `lazy_review` (its own task or a direct
child), `lazy_conversation_ask` (§11). A general "run a prompt" tool would be a
way around both.

The named commands that use one-shots stay CLI-only for the same reason `lazy
report` and memory compaction always have: they are human operations over the
whole project, not task-scoped work.

The RPC verb itself is not a third surface. It is the transport the CLI uses to
reach the daemon's Runner, credential and audit proxy — the daemon is the only
place a one-shot is isolated and billable.

## 14. The task's agent: MCP and CLI listings both carry it

`lazy_show`, `lazy_status`, `lazy_list`, `lazy_blocked` and `lazy_active` all
return the task's `agent` alongside its `model`. The CLI's `lazy list` /
`lazy active` / `lazy blocked` tree and flat tables include an **AGENT** column
with the bare agent id (e.g. `claude-code`, `cursor`). Token totals were
dropped from those tables to make room — they remain on `lazy show` and
`lazy stats`.

Per-TURN agent/model/effort labels are NOT asymmetric: `lazy show`, the
`lazy browse` TUI, the web task page and the MCP `lazy_show` turn payload all
carry them, from one shared formatter.

## 15. Depth scoping: `--levels` on three CLI listings, on two MCP tools

`lazy list`, `lazy active` and `lazy blocked` all take `--levels <n>` to show
only the first N levels of the hierarchy. On MCP, `lazy_list` and `lazy_active`
take the matching `levels` parameter — `lazy_blocked` deliberately does not.

The reason is what each surface can render. Depth is only meaningful against a
visible parent/child structure: the CLI's three listings all draw a tree, and an
elided subtree shows up as `(+N hidden)` on the parent row that survived. The
MCP `lazy_list` and `lazy_active` payloads carry `parent_task_id`, so a client
can reconstruct that same shape and read `hidden_descendants` on the right task.
`lazy_blocked` returns a flat array with no parent field at all — a depth limit
there would silently drop blocked tasks with nothing in the payload explaining
which ones or why, which is exactly the truncation the feature is designed not
to do. Giving `lazy_blocked` a `parent_task_id` first would make `levels` a
straightforward addition; until then the omission is the honest surface.

## 16. Protected-file approval exists only at accept

A protected file the agent changed is approved at merge time, and nowhere else.
Three surfaces offer it: the `--approve-file` flag of `lazy accept`, the
`approved_files` parameter of `lazy_accept`, and the per-file ✅/⛔ controls on
the web review page — whose decisions the other two read, so they are one
decision made in three places rather than three decisions.

**Unblock has no approval channel on any surface** —
no `--approve-file` on `lazy unblock`, no `approved_files` on `lazy_unblock`,
and no per-file question in the review page's Unblock dialog. Passing one of the
retired parameters is an error naming accept, never a silent no-op.

That is deliberate, not a gap. Unblock is a feedback channel, and a task runs
for as many turns as the work needs: forcing an approve-or-revert decision on
every one of them made the reviewer rule on files they had not read yet, and any
caller that answered "none for now" destroyed the agent's committed work. A
decision that only matters at merge time is made at merge time.

What each surface still does:

- **Every turn**, the agent is asked to revert each violated file itself or
  record a keep reason (`lazy_justify_protected`). That is a prompt to the
  agent, not a decision by anyone, and it is what gives the reviewer something
  to read.
- **The review page** is where a human decides per file, next to the rendered
  diff. Un-approving returns a record to *pending* — never to a settled
  refusal, which a later accept would merge — so accept refuses again until it
  is decided.
- **Accept** is all-or-nothing and reverts nothing: every pending violation must
  be named or the accept is refused. Approvals are sticky, so replaying past
  decisions is always safe.

## 17. Raised items: agent raises, human/builder resolves

`lazy_raise` is **agent-only** (current task), same posture as `lazy_commit`. The builder has no current task and reviews
rather than raises — calling `lazy_raise` from builder mode is an error.

Resolving raised items (respond / promote to subtask / promote to peer / dismiss) is a **human or builder**
act at accept, unblock, or the review page. There is deliberately:

- **No agent tool to resolve its own raised items** — that would defeat the accept
  gate. An agent that raised in error says so in the report; the human dismisses.
- **No MCP interactive walk-through** — the CLI can prompt item-by-item on a TTY;
  MCP callers pass an explicit `raised_resolutions` array (all-or-nothing on
  accept). Agents do not get a TTY prompt.
- **No agent tool to change the `blocking` flag.** The agent chooses it when it
  raises (`blocking` is required — an absent flag is refused, because "the agent
  never decided" is not a default anyone can read). Changing it afterwards is a
  review act: `lazy raised blocking`, the item page, and the review page, all
  human or builder. An agent that could demote its own blocking item could walk
  itself past the accept gate.

`--yes` does not skip raised-item resolution (same philosophy as the protected-merge
passphrase). Only **blocking** items gate; non-blocking ones are listed for triage
and never hold up accept. See [raised-items.md](raised-items.md).

## 17a. Declaring a task done is agent-only, and it is its own tool

`lazy_final` — pencils down on the current task — is **agent-only**, same
posture as `lazy_raise` and `lazy_commit`. Builder mode refuses it: the builder
has no current task, and declaring somebody else's work finished is not a claim
it is in a position to make.

Deliberately:

- **No `lazy_final` for another task.** Every other agent write reaches a direct
  subtask; this one does not reach even that far. A final is a claim about work
  you did, in the turn you did it, and a parent declaring its child done would
  put a claim in the record that nobody made.
- **It is a separate tool, not a field on `lazy_report`.** `lazy_report` is
  documented and enforced as a reporting channel that is never a turn-end
  signal (§18 below). Declaring pencils down is exactly a turn-end claim, so
  folding it in would make "report again with a corrected section" silently mean
  "declare done again".
- **Exactly one refusal, and no override.** `lazy_final` refuses while a blocking
  raised item is open, naming it. There is no flag to push past it: a blocking
  raise and a final are the two ways a turn can end, and the refusal is the fork.
- **Declaring does not end the turn, change status, or merge anything.** It
  records a claim about the current head. See [state-machine.md](state-machine.md).

### `accept --allow-queued-comments` has no MCP parameter

Accept refuses while a comment a person queued for the agent — with `lazy
comment`, the web Comments tab, or a web review comment — has not been
delivered yet: merging would end the task with that feedback never read.
`lazy accept <task> --allow-queued-comments` (or the checkbox in the web
Accept dialog) merges anyway. Comments written by the builder, an agent or lazy
itself never count, so an agent accepting its subtasks only meets this gate
when a person left words the subtask's agent has not read — and the way past it
is to deliver them (`lazy_unblock`), not to decide on that person's behalf.

### `accept --allow-review-issues` is CLI-only

Accept refuses while the latest [review](review.md) of a task in `separate`
[review mode](review-paradigm.md) left something above medium severity
outstanding, failed to produce a readable verdict, or never ran.
`lazy accept <task> --allow-review-issues` merges anyway. It has **no MCP
parameter**: an accept through MCP meets the review gate with no way past it.

**This stays human-only, and the gate narrowed instead.** A cluster driver
told to accept its children liberally used to hit this wall on nothing worse
than a style nit, with no override it could reach — which argued for giving
agents one. The answer was the other way round: a finding at medium or below no
longer holds a merge at all, and a task in the default `low_high` mode has no
reviewer verdict to overrule in the first place. So the driver needs no
override, because there is nothing left to override in the cases it was getting
stuck on. What still holds a merge — a critical or high finding, a failed or
never-run review, an outstanding decision — is exactly what a person should be
deciding about, which is the line this asymmetry was drawn on to begin with.

The override has to exist. A review's findings are feedback delivered to the
agent, not items on a queue, so there is nothing for a human to dismiss or
promote instead: without it, a person who has read the work and disagrees with
the reviewer would have no way to accept at all except spending another agent
turn.

The asymmetry is the same ownership line as §1 and §17a above. Overruling a
reviewer is the review authority's own judgement: *I have read this and I
disagree.* That authority is exactly what the MCP surface withholds — an agent
cannot accept its own task, so it may not wave away a review of its own work
either. An agent who finished says so with `lazy_final` (§17a), which starts
the review; the human decides what to do with what it says.

### `lazy_edit`'s review settings are refused on the caller's OWN task

A task's [review settings](review-paradigm.md) — `review`, `review_gate`,
`review_auto_fix` — are editable mid-flight through `lazy_edit`, and an agent
may set them **on a direct subtask** but never **on itself**.

The asymmetry is the same authority as the entry above. The settings decide
whether a review of a task's work can hold its accept, so an agent changing
them on its own task is overruling a review of its own work one step earlier
than `--allow-review-issues` does. That override is CLI/TTY-only for exactly
this reason, and an argument that reaches the same outcome by a different name
is not a different decision.

A DIRECT SUBTASK is the other side, and it has to stay open: a cluster driver
escalating one child to a cold second read — or leaving a batch of children on
the fast default — is *arranging work it is responsible for*, not passing
judgement on itself. The two cases differ by exactly one comparison
(`task.id === ctx.taskId`), which is why the rule is written as one and why
adding a fourth review argument to `lazy_edit` means adding it to that check.

Humans are unaffected: `lazy edit --review*` on any task is a person deciding
about their own project, which is the authority this whole page is about.

## 18. Turn reports and file justifications: agent writes, human reads

`lazy_report`, `lazy_justify_protected`, and `lazy_justify_maintain` are
**agent-only** writes on the current task (same posture as `lazy_raise`). Builder mode refuses them — the builder reviews rather
than authors an agent turn report.

Deliberately:

- **No CLI write** for reports or justifications — humans do not author the
  agent's end-of-turn structure. Read via `lazy show`, web review, and the
  review TUI.
- **Reporting is never a turn-end signal** — calling `lazy_report` does not
  change status and does not end a turn. Skipping it only degrades to prose.
- **Presentation is agent-authored** — the optional `presentation` walkthrough
  on `lazy_report` is the same agent-only write; humans read it on review
  surfaces, not author it.
- **Justification never auto-approves** a protected file — structured reasons
  feed the reviewer; the human still decides.

See [turn-reports.md](turn-reports.md).

## 19. `--allow-broken` is CLI-only

`lazy accept` refuses to merge a task whose configured accept check fails
([accept-check.md](accept-check.md)). `lazy accept <task> --allow-broken`
overrides that refusal; `lazy_accept` has no `allow_broken` parameter and will
not get one.

"This tree does not build, merge it anyway" is a judgement about consequences
outside the task — what the target branch is for, who is about to build on it,
whether the breakage is survivable until a fix lands. An agent accepting a
direct child (§1) can see none of that, and the one thing this gate exists to
stop is exactly the automated decision to proceed past a signal that says the
task is broken. So over MCP the refusal is terminal: fix the task, or hand it to
the human.

The refusal text follows the boundary: on the CLI it names the flag and the exact
command, and over MCP it says the override is a CLI flag with no equivalent there
and that merging a broken tree takes a human at a terminal. Handing an agent a
command its surface cannot run would coach it toward a dead end — or toward
shelling out to the CLI to get around its own boundary.

The report half is NOT asymmetric — reverted protected files are named on both
surfaces, because that is information, not a decision.

## 20. Choosing a subtask's agent is NOT gated by who is asking

A task agent may create a subtask that runs on a *different* agent than itself —
a claude-code agent can call `lazy_create` with `agent: "cursor"`, write that
subtask's prompt, and start it. The `agent` parameter validates that the id is a
registered agent and nothing more; unlike the write gates in §1 it does not care
whether the caller is a human, the builder, or an agent.

This one is listed here because it *looks* like a hole and is not. Choosing an
agent for a subtask is not a way to acquire a credential:

- **A task never receives your agent API key.** Keys live in lazy's own state
  directory outside the repository, readable by the daemon and by nothing lazy
  launches. A container that mounts your project sees the project, not the key.
- **What a task gets instead is a placeholder** — a random value lazy mints for
  that one launch and puts in the environment variable the real key would have
  occupied. The agent's API traffic goes to lazy's proxy, which recognises the
  placeholder, records who spent what, and substitutes the real credential on
  the way upstream. The credential itself never leaves the daemon.
- **A placeholder is worth nothing anywhere else.** It authenticates against
  your own machine's proxy for that project and against no other service, and
  lazy revokes it when the task ends (accept, reject or close). Copied out of
  its container, it is a random string.
- **The agent has to exist for you already.** A task that needs an API key lazy
  cannot find refuses to launch, with the command to set one. An agent cannot
  reach an account you never configured.

What remains is ordinary and visible: while a subtask is running, its requests
spend from the account you configured for that agent, exactly like every other
task's do. Both halves of the decision are in the record you review — the
parent's call that created the subtask, and the subtask's prompt.

Gating the parameter by caller would not change any of the above, and it would
break the case the parameter exists for: splitting work across agents. Note
that this is about *choosing* an agent, not about *installing* one's
credentials — storing an API key stays human-only (§4), because an agent that
can install the key it then authenticates with has minted its own access.

One caveat, and it is about the runner rather than this parameter: the
host-process runner runs an agent as you, on your machine, with your files. An
agent there can read anything you can, no subtask required. That runner's full
name says so, and it is not the default.

## 21. Signing in to the web dashboard is human-only

The dashboard requires a browser session, and the only way to get one is
`lazy dashboard` from a terminal in the project: it asks the daemon for a
one-time login link, opens your browser with it, and the link is exchanged for
an `HttpOnly` session cookie on first use. There is deliberately no MCP tool
that mints a login link, and no tool parameter that carries one.

That is the entire point of the feature rather than an oversight. The daemon
serves the dashboard, `/rpc` and `/mcp` on one loopback port, and task
containers are given a route to that port so their agents can reach `/mcp`. An
agent therefore *can* open a TCP connection to the dashboard — it simply has no
credential the dashboard accepts:

- **An MCP token is not a browser credential.** The gate checks for a session
  cookie and nothing else. An MCP token, the shared daemon bearer token, and an
  actor token are all refused, so holding one buys an agent the sign-in page.
- **Minting a link is an `/rpc` call**, and `/rpc` refuses MCP tokens. Nothing
  an agent holds can produce a session for itself.
- **Sessions are per-host operator secrets**, kept in the daemon's runtime
  state directory outside the repository — not in the store, so a container that
  mounts the project cannot read one.

Without this, a task agent could POST accept, unblock, close and edit on other
tasks through a page that asks it for nothing.

Managed mode goes further and is symmetric about it: on a Lazy Teams fleet host
the dashboard, its assets, the login endpoint and `lazy dashboard` are all off
for everyone, human or agent. `/rpc` and `/mcp` are untouched.

## 22. The web shell is human-only — no MCP surface

The daemon dashboard can open an interactive terminal inside a task's container
(see [Web shell](web-shell.md)). There is a CLI equivalent (`lazy shell
--container`), but **no MCP tool** — an agent cannot open a shell into a
container over the tool surface, its own or any other task's.

This is deliberate, and it is not a missing capability:

- **An agent already has its container.** The whole point of a task is that its
  agent runs *inside* that sandbox — it executes commands there as its ordinary
  work. A tool to "open a shell into the container" would hand the agent a
  second route into the environment it is already in, which buys nothing and
  only adds a way to reach a *different* task's container.
- **The web shell is a review tool for a human.** Its reason to exist is that a
  person reviewing a task wants to try the work by hand. That intent has no
  agent analogue.
- **The same holds for attaching to a session remotely.** A daemon also accepts
  terminal attaches from authenticated remote clients (a person's own client,
  or a hosted front end acting for them). That too is a human surface with no
  MCP tool.
- **It changes the trust story if made agent-reachable.** The shell executes
  arbitrary commands in a container; keeping it off the tool surface keeps it
  behind the same human-facing authorization as the rest of the dashboard — the
  signed-in browser session (§21), which nothing an agent holds can mint —
  rather than the agent-ownership gating the MCP tools use.

Consistent with the governing rule: the human surfaces (CLI, dashboard) can do
this; the agent surface deliberately cannot.

## 23. Dashboard URL: CLI command, MCP field — no dedicated tool

Builder output names tasks as clickable links, which needs the daemon's
dashboard address so that constructing a URL is "base + path". That address is already a CLI command (`lazy daemon dashboard-url`) and a
`Web:` line on `lazy daemon status`. MCP does **not** get a matching
`lazy_dashboard_url` tool.

What it gets is a field: `dashboard_url` on `lazy_status` (the same payload
already used for "where am I"), and the same value on GET `/daemon/status` as
`dashboardUrl`. `null` means the dashboard is off (managed mode) or the daemon
could not be reached — callers must not invent a `lazy.localhost` link.

A dedicated tool would be a third way to ask a question `lazy_status` already
answers, and would tempt agents to call it on every mention of a task. The
builder does not need the tool at all: at launch, the system prompt injects
the base URL and the path patterns (`/tasks/<code>`, `/review/<code>`,
`/raised/<id>`, …) so naming a task as a markdown link is the default.

Signing in stays human-only (§21). This field is the *address*, not a login
link.

## 24. Re-describing a linked task is CLI-only

Both surfaces write a linked task's description: `lazy link` and MCP `lazy_link`
run the same daemon step, so an agent that adopts a branch gets the same prompt
a human would. Re-writing it afterwards — `lazy describe <task>` — has no MCP
tool.

Describing is a model call lazy makes on the human's behalf, on the builder's
credential, and re-running it rewrites a task's prompt. On the CLI that is a
person deciding a stale description should be refreshed. Over MCP it would be an
ungated way for an agent to spend the builder's pool and overwrite the prompt of
a task — including one it does not own — as often as it liked, for an output
nobody asked for. Machine one-shots have no MCP tool at all for the same reason
(§13).

An agent that finds a linked task's description missing or stale should say so;
the human runs the verb.

## 25. Review regions: everyone reads them, only people annotate them (and which source answers)

[Review regions](review-regions.md) cut a task's changes into regions — by
**default, the walkthrough the task's agent declared**, with git provenance
available on demand. Reading them is open on both surfaces and unrestricted by
task ownership, like every other read: `lazy regions <task>` on the CLI,
`lazy_regions(task_id)` over MCP, and a `region` parameter on both `lazy diff`
and `lazy_diff`.

The **human overlay** — naming a region, giving it an owner, signing one off,
withdrawing a sign-off — belongs to the surfaces a *person* uses. On the command
line that is `lazy regions <task> --region <id> --name …` / `--owner` /
`--sign-off` / `--unsign`; on Lazy Teams, the Regions tab of a task assigns an
owner and signs a unit or an area off, and withdraws a sign-off again. There is
deliberately no MCP tool for any of it.

The single-user web page *shows* a region's name and its sign-off, including
when the branch has moved past one, but offers no control to set either — that
is unbuilt work rather than a deliberate asymmetry, and a web control would sit
on the same side of this line as the CLI and Teams.

A sign-off is a claim that a person looked at a slice of the change and is
content with it, recorded against a digest of that region's own files. An agent
signing off its own region is the review equivalent of an agent accepting its
own task, which §1 and §17 already refuse for the same reason. Naming is
grouped with it because the two share one command and one stored record, and
splitting them would put half a reviewer's annotation on the agent surface for
no gain — an agent that wants to say something about a region has
`lazy_journal` and `lazy_raise`.

Agents get the half that makes regions useful to them: a bounded diff per
region, so a large branch can be reviewed one region at a time.

Where lazy knows who is asking — a review surface a person is signed in to —
the overlay write records **that person** against the owner and the sign-off,
and every surface names them. The identity comes from the caller's own
credential and can never be passed as an argument: an argument would let any
caller record an approval in somebody else's name, which is the one thing an
approval may not allow. A caller lazy cannot attribute to a person — the CLI on
a single-machine install, or an operator credential — records no name at all,
and nothing is invented in its place.

That rule is why a whole class of Teams action is refused rather than degraded.
An administrator viewing the app **as somebody else** may not do anything lazy
would record against a person — which, on a team install, is everything a person
does to a task: leaving a note, assigning a region's owner, signing one off,
copying a task or starting one over, and also accepting, stopping, rejecting,
closing, creating and editing one. Lazy will not file the act under the name of
the person being viewed as, and the alternative — a record with no name on it —
is exactly what naming the actor exists to prevent. These are made in your own
name or not at all, and no amount of elevation unlocks them; allowing writes
while viewing as somebody is the administrator taking responsibility for changing
that person's data, which is not the same as being able to sign their name to it.
Stop viewing as them and do it as yourself.

Reading is unaffected: every page, every diff and every report is there to be
looked at, which is the point of viewing as somebody in the first place. So is
the work that belongs to the *account* rather than to a task — diagnosing or
replacing the stored Anthropic credential of the person you are viewing as, and
the team and membership settings an administrator manages anyway.

Accepting, stopping, rejecting and closing a task were on the permitted side of
this line until a team install began naming the person for them too. They are on
the refused side now, and the reason is the record rather than the risk: lazy
records who merged a branch and who ended a task, and neither name available
while viewing as somebody is true.

**Anyone may withdraw anyone's sign-off, and never silently.** A unit holds one
sign-off, not one per person, so restricting withdrawal to whoever gave it
would strand that unit the moment they left the team or changed role. Lazy
allows it and names it instead: on Teams the button says whose approval it will
remove, asks you to confirm before it does, and the confirmation afterwards
reports whose it actually was rather than claiming it was yours. A press made on
a page somebody has acted on since is refused and says what changed, so a stale
page can never quietly replace a colleague's approval with your own.

**A second, smaller difference in the same feature: which source answers, and
who pays for the carve.** The default source everywhere is the **presentation**
the task's final turn declared — the groups the agent named itself. Reading it
is free of git: no walk, no stored cover, no staleness question. `lazy regions`
and `lazy_regions` answer from it alike, and a task whose agent filed no
walkthrough says so in a note rather than erroring.

Git provenance is the second source, reached with
`lazy_regions(provenance: true)`. It is an MCP-only option: it is an authoring
hint for agents writing their walkthrough, and `lazy regions` has no flag for
it because a human review navigates by the walkthrough, not the carve. The
cost question is real there: carving a big branch takes seconds, so a plain
listing may answer `computing: true` once while the carve runs in the background —
naming a region, though, waits, because answering "still computing" to "show
me region X" reads as "there is no region X". The web tabs do not reach the
carve at all: they read the walkthrough, which needs no computation.

Nothing is lost by the walkthrough being first. `lazy_diff`'s `region`
parameter scopes by the declared groups on both surfaces, and a carve unit is
read in full through `lazy_regions(provenance: true)` — the agent scopes diffs
by the groups it goes on to declare in its own report. See
[Review regions](review-regions.md).

**An agent never annotates.** There is no MCP tool to name a region, assign an
owner, sign one off or withdraw a sign-off: see the overlay rule above.

## 26. Promoting a discussion into a task is web-only

Promoting a [raised item](raised-items.md) works on every surface — `lazy
raised promote`, `lazy_raised_items`' resolutions, the review page. Promoting a
**discussion** — the question you asked about a task and the answer you got —
exists only on the review page.

The asymmetry is in the input, not in the permission. A raised item is a
self-contained record with an id, a title and often an agent-proposed prompt:
naming one on a command line is enough to promote it. A discussion is a thread
of messages whose value is the exact text on both sides, and the promote form
is seeded with all of it *for editing* — the goal from your own question, the
prompt from the whole exchange. The editing is the point: a discussion is raw
material, not a filed proposal, and "promote thread `<uuid>` with this prompt"
on a terminal is the same act with the review context stripped out of it.

Asking, by contrast, is **not** narrower anywhere: `lazy ask`, `lazy_ask` and
the web ask box route identically, including
the record route for a finished task. If you want a task out of a discussion
without a browser, read the thread (`lazy show`) and create the task yourself —
`lazy create` takes the prompt you would have edited anyway.

## 27. Promoting a conversation into a task has no MCP tool

Promoting part of a stored builder conversation
([conversations](conversation-import.md)) exists on the web page and on the CLI
(`lazy conversations promote`). There is deliberately no agent tool for it.

Same reasoning as the discussion above, plus one more: a conversation is
*project-scoped*, so the promoted task is not a child of the promoting agent's
task — it is a new piece of work somewhere else in the tree, chosen by whoever
promotes it. `lazy_create` exists so an agent can decompose its OWN task;
deciding that a past dialogue with the builder should become a new task is a
planning act, and planning is the human's. An agent that reads a conversation
and thinks a task should exist can say so — `lazy_raise` with
`blocking: false` — and the human promotes it.

## 28. `lazy ask` / `lazy review` block; `lazy_ask` / `lazy_review` return immediately

On the CLI, `lazy ask` and `lazy review` behave as they always have: they print
progress and stay there until the answer or the report comes back. Over MCP, the
same two verbs **start** the turn and return at once — the task id, and the kind
of turn now running. The agent waits with `lazy_wait` and then reads the answer
off the task's newest `ask` or `review` turn.

Underneath, both surfaces do the same thing, because the daemon itself is
asynchronous now: the turn is started, its answer lands as a turn, and nothing
is holding a connection open on its behalf. The CLI simply does the waiting
*for you*, because a person typing `lazy review` is a person who wants to sit
and read the report. An agent is not: blocking its whole turn on someone else's
turn burns its context window on a wait, makes the pair uninterruptible, and —
when a review of a large diff ran long — used to end with the reviewer killed
and the task stuck. `lazy_wait` already exists, already races several tasks at
once, and already returns the moment any of them settles.

Neither surface has a **time limit** any more. A review of a large diff at high
effort routinely runs many minutes and is allowed to; the guard against one that
hangs is the agent watchdog, exactly as for a work turn. If you no longer want
to wait for one, `lazy stop` / `lazy_stop` ends it — that stops the reviewer or
answerer itself, keeps anything it already filed, and restores the status it
found.

## 29. Syncing a task that is running: only that task's own agent

`lazy sync` refuses a task that is working, and so does `lazy_sync` — except in
one case: a task's **own agent**, syncing **itself**, while its turn is running.
That call always works, and it is the only way a running task can reconcile its
branch.

It is an asymmetry in the caller, not in the command. Everyone else asking to
merge into a running task's worktree is asking to change files underneath a turn
nobody is watching — a human at a terminal, the builder, another task's agent,
and a cluster task syncing a working *child* (which passes the ownership gate and is
still refused). The task's own agent is the one caller who is inside that turn,
so it is also the one caller who can resolve a conflict the merge produces: it
gets the conflicted files back from the call, resolves them, concludes the merge
with `lazy_commit`, and calls `lazy_sync` again.

Identity here is not something a caller can claim. It comes from the
authenticated per-task tool channel, so "sync this task as its own agent" cannot
be requested on behalf of a task you are not.

This is what makes [cluster tasks](cluster-tasks.md) work over long runs: a cluster
is working for its whole turn, and without it every child it starts would branch
from the base its parent had when the cluster began.

## 30. On a shared host, an operator credential cannot take a human action

A daemon on your own machine has one credential, and it is yours: everything it
does is attributed to you, from your git config (see
[identity](identity.md)). A daemon on a **shared host**, with a control
plane in front of it mediating several people, has two kinds of credential — the
operator's, which belongs to the system, and one per person, which names them.

There the asymmetry is between CREDENTIALS rather than between surfaces, and it
is deliberate: **a credential that names no person may not take an action a
person takes.** Accepting, rejecting, closing, stopping, starting, editing,
creating, commenting, signing off, resolving a raised item, curating shared
memory — each is refused on the operator credential, with a message saying to
use the acting person's own. The alternative is what the split exists to
prevent: a task history in which the machine appears to have made everybody's
decisions.

What the operator credential keeps, because none of it is somebody acting:

- **Every read.** Listing, showing, diffing, searching, waiting, the review
  queue. Looking at something is never refused, on any credential.
- **Handing out and withdrawing access**, and pushing a person's model
  credential. Issuing somebody a credential is not that person acting.
- **Configuring a project**, and the container and session plumbing a turn runs
  on. That is the operator acting on infrastructure, and it is audited as such.

None of this exists on a single-machine install: there is no control plane, the
one credential IS the machine's owner, and per-person credentials are refused
outright rather than being an unused second path.

## 31. Logging a machine in to Lazy Teams is human-only

`lazy login` and `lazy logout` have no MCP counterpart, and will not grow one.

Logging in is a person at a keyboard deciding that a machine may act as them, and
confirming it in a browser they are already signed in to. The whole point of the
[device-code flow](teams-login.md) is that the approval happens somewhere an
agent is not: nothing in the exchange can be completed by whoever started it.
Offering an agent a tool that starts a login would be offering it a way to ask a
person to hand it a credential.

The same rule already applies to model credentials — writing one is human-only,
for the same reason (see [credentials](credentials.md)). And it cuts both ways:
`lazy logout` is human-only too, because an agent that could unbind a clone could
cut off the very access its operator is using.

Choosing which project a clone is bound to is human-only for a second reason
besides. It is never inferred from the git remote, and without a terminal to ask,
`--project` is required — a guess there would be a guess about somebody's
infrastructure.

## 32. Editing a comment is a human surface; agents post a follow-up instead

`lazy comment <task> --edit <comment-id>`, the task page's Comments tab and
Lazy Teams can replace the text of a comment **the agent has not been shown
yet**. Once a comment has been delivered in a prompt it can no longer be
edited on any surface — the agent may have acted on what it read, and the
record must keep saying what it read. The refusal says so.

There is no MCP tool for it. An agent's comments are instructions to its own
direct subtasks, and a correction to an instruction is itself an instruction:
a second comment rides the same next prompt, and the history shows both what
was said and what was corrected. Letting an agent rewrite its instructions in
place would widen the agent surface for no case the append-only path does not
already cover, which is the "tight MCP" rule above.

Forge (pull/merge request) comments follow the same rule automatically: a
forge comment edited before the agent saw its imported copy updates that copy;
one edited afterwards is imported as a new comment that names the original.

## 33. Usage-limit readings: each caller sees only what its own person may see

`lazy stats limits --json` and the `lazy_usage_limits` MCP tool return the
same JSON: the latest reading per credential (windows with percent used and
reset time, paid-overage status, raw rate-limit headers), plus the
`[usage_pause]` state (thresholds, a pending override, paused credentials,
tasks waiting on a pause, and each credential it is armed for with whether it
has a usable reading, so one armed with no reading is listed rather than
simply absent). While lazy cannot read its saved readings, both refuse and
name the file instead of answering with an empty list.

What each caller is served:

- **On a single-person install**, the builder is served all of it, exactly
  like the CLI: every credential is yours, and the builder plans work across
  the whole project.
- **On a Lazy Teams host**, the builder is served no more than a member's own
  CLI can read. The project-wide readings are control-plane only there, and a
  builder session belongs to one member. So it sees the project's service
  credential, the credential its own session spends (when it is bound to one),
  and the pause settings, but never another member's reading, pause verdict,
  threshold, or the tasks held on that member's credential. Whether a builder
  on a Teams host should see every member's numbers instead is an open
  question. Until it is decided, the narrower view applies.
- **A task agent** is served only the credential its own current turn is
  spending: its reading, its pause verdict, its configured threshold and its
  own task's hold. When lazy cannot tell which credential a turn spends (for
  example, the turn has already ended), the agent sees no credential at all.

The daemon does all of this narrowing before the answer leaves it, never the
caller's client. The narrowing applies to builder sessions the daemon runs.
A builder using a host-side MCP server that is not one of those sessions is
the operator's own view. It gets exactly what `lazy stats limits --json`
prints: the full project view, including the same fallback that reads the
local record when the daemon is down, and it is refused wherever that
command is refused. Such a server refuses a task agent's call outright. Neither surface ever returns a credential's secret.

## 34. The usage-pause override is a person's

[`[usage_pause]`](lazy-toml.md#usage_pause) stops lazy starting turns on a
credential that is close to paid overage. Its one-shot escape hatch,
`lazy daemon config set usage_pause_threshold off`, is human-only in every
direction:

- **Setting it** needs an interactive terminal. The command refuses when stdin
  is not a terminal, inside a container, and with any of lazy's test prompt
  variables set; the daemon separately refuses a request that does not come
  from the `human` channel. There is no MCP tool and no flag or piped form. On
  a Lazy Teams host the setting is not available to members at all.
- **Using it** is reserved for launches a person asks for on a person's
  channel. Exactly three reach it:
  - **The CLI, from a person's own terminal.** Every command that can launch
    a turn — `lazy start`, `lazy unblock`, `lazy resume`, `lazy review`,
    `lazy ask`, `lazy sync`, `lazy report`, `lazy pair` and `lazy chat` —
    takes it only from an interactive terminal outside a container. Run from
    a script, a pipe or the builder's shell, the same command is judged on the
    configured threshold alone and leaves the override for the person who set
    it.
  - **The local dashboard.** Its Start, Unblock, Resume, Review, Ask, Sync,
    Pair and Chat buttons: the person at the page is signed in to the
    dashboard with its one-time login link, which an agent never has; the
    dashboard does not exist on a Lazy Teams host.
  - **On a Lazy Teams host, a member's own request from the web UI** (Start,
    Resume, Restart, Unblock and Review). A clone bound to Lazy Teams follows
    the CLI's rule above: its commands take the override only when run from a
    person's own terminal, and Lazy Teams passes that along unchanged. Requests
    from Slack do not take it.

  A launch through the agent tools (the builder's or a task agent's), one
  that names no channel, and every turn lazy starts by itself are judged on
  the configured threshold alone and never spend a pending override.
- **Being told about it** is human-only too: a refusal addressed to a person
  names the override command; a refusal addressed to the builder or an agent
  only says when the window resets. The CLI's own hints follow the same rule:
  the check before `lazy unblock` and `lazy ask`, `lazy daemon config get`,
  `lazy doctor` and the usage-pause line in `lazy show` name the command only
  to a person at their own terminal, never when the builder or an agent runs
  them. For a subtask start that is waiting on the pause, `lazy show` says it
  starts by itself after the reset: the override does not release it.

The reason is the whole point of the feature. An agent reads the refusal it
gets and acts on it. If it could set the override, or even learned the
command from the refusal, the pause would be a suggestion it could talk its
way past on every launch — spending exactly the money the person configured
the pause to protect.

One more difference follows from who is waiting. When an agent starts one of
its own subtasks on a paused credential, the start is **held**, not refused:
the subtask starts by itself when the window resets, and lazy then wakes a
cluster task (any other task finds a note on its next turn); the agent was told
to end its turn meanwhile rather than wait and spend. A person's start is refused with the reset time,
because a person can decide what to do instead.

## 35. A pull request into a parent task's branch: a person may ask, an agent may not

A subtask merges into its parent task's branch, and `lazy accept` does that
locally — lazy never opens a pull or merge request for it on its own. When a
reviewer wants one anyway, a person can ask for it: `lazy submit <task>`, the
dashboard's Submit button, or Submit on Lazy Teams opens the PR/MR with the
parent task's branch as its base and tracks it like any submitted task.

`lazy_submit` over MCP — the builder's or a task agent's — keeps refusing, and
its refusal says a person can run `lazy submit`. A PR notifies everybody
watching the repository, and an agent cannot tell a person's explicit request
from its own initiative; the person typing the command can.

## When you find an asymmetry that is not listed here

It is probably accidental — this page is the complete list of the deliberate
ones. Treat an unlisted difference as a gap and report it. Adding a deliberate
asymmetry means adding it to this file in the same change.
