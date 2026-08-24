# Surface asymmetries: CLI vs MCP

Lazy exposes two control surfaces over the same daemon: the **CLI**
(`src/cli/commands/*`, dispatched from `src/index.ts`) and the **MCP tool
surface** (`src/mcp/tools.ts`, 37 advertised tools). They are not, and should
not be, mirror images.

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

## 1. Agent-ownership gating

Most task-targeting MCP tools check the caller (the exceptions are listed below). `ctx.taskId` non-empty means a
**task agent**; empty means the **builder**. The builder is unrestricted; a task
agent may only act on its own task or a direct child.

The gates in `src/mcp/tools.ts` that implement this:

| Gate | Applies to | Rule |
| --- | --- | --- |
| `assertAgentMayTarget` | show, unblock, ask, reject, close, stop, edit, reopen | own task, or a direct child |
| `gateAgentTarget` | diff, wait, submit, resume, sync — handlers that don't otherwise open storage | own task, or a direct child, resolve-then-gate |
| `assertAgentMayTargetChildOnly` | accept | direct child only — an agent can never accept itself |
| (own check in the handler) | start | a direct child only — stricter than `assertAgentMayTarget`, so an agent cannot restart itself |

Tools NOT in that table take whatever `task_id` they are given: the listings
(`lazy_list`, `lazy_blocked`, `lazy_active`) by design — agent reads are open
tree-wide, because learning from other agents' work is the point — and the
annotation writes (`lazy_comment`, `lazy_tag`, `lazy_untag`, `lazy_prioritize`)
**not** by design. The decision on record is that annotations belong on a direct
child, and `src/prompts/tool-instructions.md` tells agents exactly that, but no
gate enforces it yet. That is a known gap with a follow-up filed, not an
asymmetry to preserve. `lazy_journal` is deliberately open: a journal entry
never enters anyone's prompt and never triggers a turn.

Additional per-tool caller rules:

- **`lazy_create`** — an agent's new task is always a child of its own task. A
  `parent` argument is accepted only when it equals `ctx.taskId`. Agents cannot
  create top-level tasks or tasks under someone else's parent.
- **`lazy_accept`** — a direct subtask only. Accepting your *own* task is the
  human's review decision and has no tool.
- **`lazy_edit`** — refuses to change `parent` when the caller is an agent.
- **`lazy_clone`, `lazy_redo`, `lazy_reparent`** — reject agent callers outright.
  All three reshape the task tree outside the caller's subtree.
- **`lazy_memory_save`** — builder-only. Memory records are injected into every
  future builder and agent launch; only the human and the builder curate them.
  Agents read memory freely (`lazy_memory_recall`) and are told to *report* what
  belongs in memory rather than write it.
- **`lazy_commit`, `lazy_add_followup`, `lazy_update_progress`** — agent-only.
  All three are defined relative to "the current task"; the builder has no current
  task, so calling them is an error rather than a no-op. `lazy_update_progress`
  additionally has no CLI counterpart at all: a human reporting their own progress
  to themselves is not a thing, and the human side of the channel is the reading
  side (`lazy list`, `lazy status`, `lazy show`, `lazy watch`).

The CLI has none of this. A human running `lazy accept` is the review authority.

**Why gating is per-handler, not per-tool-list.** Every tool is advertised to
both callers and each handler decides. Filtering the advertised list per caller
would mean an agent asking "can I do X?" gets *silence* instead of a reason. A
refusal that explains itself is a better teacher than an absent tool.

## 2. Two-step confirmation codes (MCP-only friction)

`lazy_accept`, `lazy_reject`, `lazy_close`, `lazy_reopen`, `lazy_redo` and
`lazy_create` (when creating under `main` while an active task exists) implement
a two-step protocol (`src/mcp/confirmation.ts`): the first call returns guidance
plus a `confirmation_code`, and only a second call carrying that code executes.

This is the MCP analogue of the CLI's interactive prompt and `--yes`. It is not
a straight port: the CLI prompt can be skipped with a flag the caller controls,
whereas the MCP code must be *echoed back from a prior response*, which no
single hallucinated call can produce. `lazy_accept` skips the two-step when the
diff is tiny — friction proportional to blast radius.

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

## 4. Human-only commands with no MCP equivalent

- **`lazy approve`** — records the one-time human approval that unlocks an
  accept into a protected branch. Its usage text says it outright: *"There is
  deliberately NO `--yes` for this command, and no MCP equivalent: the approval
  token must originate outside the builder/agent context, or the gate is
  decoration."* The passphrase is typed at the command's own masked prompt —
  **interactive only**, with no flag, env var, or piped-stdin route (the piped
  form was supported until v0.23 and was removed: a value a script can supply
  lives on in shell history, CI logs and agent transcripts) — and is checked
  against the machine's hashed enrollment, not against anything in the repo.
  See [protected-branches.md](protected-branches.md).

  **The asymmetry is agents vs. humans, not terminal vs. browser.** The web
  review page (`/review/<task>`) asks the reviewer for the same passphrase and
  completes the gated accept through the daemon, exactly as `lazy approve` +
  `lazy accept` does at a terminal — a person sitting at the review page is the
  human the gate was written for. The passphrase is verified by the daemon, is
  never stored client-side and never logged, and a wrong one is a retryable
  error that re-offers the form. What stays closed is the MCP surface: no tool
  records an approval, so the builder still cannot satisfy its own gate. See
  [web-review.md](web-review.md).
- **`lazy system passphrase`** (`set`/`status`/`delete`) — enrolling, rotating,
  or removing the machine's approval passphrase. No MCP tool, and — unusually —
  **no daemon RPC either**: enrollment writes the hashed store straight from the
  CLI process on the host, while verification stays daemon-side (inside
  `approveTaskPreflight`/`approveTask`). That split is the whole point. If
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
  command reads `process.stdin.isTTY` itself instead of lazy's `isTTY()` helper
  (which honours the `LAZY_FORCE_TTY` test seam) and **refuses outright if any
  prompt test seam is set at all**. Consequence, accepted: enrolling a
  passphrase cannot be driven from a test — because anything a test can drive,
  an agent running lazy from source can drive too. In a released binary those
  seams are not merely ignored, they are compiled out entirely — by
  `scripts/build.ts` for a local build and by `.github/workflows/build.yml` for
  the binaries CI publishes, both checked per invocation by
  `test/unit/build-release-flags.test.ts`.

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
  `protection` object (gates, target branch, whether an approval is pending) so
  the builder can plan around a gate instead of discovering it as a refusal —
  reading state is harmless, arranging your own gates is not. See
  [protected-branches.md](protected-branches.md#seeing-a-gate-before-it-bites).
- **`lazy system agent`** — switching the project's default agent
  (`set <id>`, writes `[agent] agent_id` in lazy.toml) and storing an agent
  API key (`set-key <id>`, writes `~/.lazy/daemon/<slug>/agent-credentials.json`,
  mode 0600 and outside the repo every task container mounts) are human
  decisions with no MCP counterpart.
  Credentials especially: **agents must never write credentials** — an agent
  that can install the key it then authenticates with has minted its own
  access. Agents that need a different agent for a subtask already have the
  narrow, per-task `agent` parameter on `lazy_create`/`lazy_start`; the
  project-wide default and the key material stay with the human.
- **`lazy revert`**, **`lazy pair`**, **`lazy chat`**, **`lazy shell`**,
  **`lazy review -i`**, **`lazy builder`** — interactive or
  human-in-the-loop by nature.
- **`lazy init`**, **`lazy doctor`**, **`lazy upgrade`**, **`lazy daemon *`**,
  **`lazy system *`**, **`lazy config`**, **`lazy watch`**,
  **`lazy completion`**, **`lazy export-dockerfile`**, **`lazy logs`** —
  host and installation operations. Agents run *inside* the thing these
  commands manage; exposing them would let a task agent restart the daemon
  supervising it.
- **`lazy loop`**, **`lazy branch`**, **`lazy link`** — orchestration verbs that
  belong to whoever is driving the session.

## 5. Read-only turns

`LAZY_MCP_READ_ONLY` serves a reduced toolset built from `READ_ONLY_TOOL_NAMES`
(`src/mcp/tool-access.ts`) so reflective/contemplative turns — including
`lazy_ask` targets — cannot mutate state. `lazy_ask` is itself classified
**write** even though the *asking* is read-only, because it launches an agent
turn on another task. `TOOL_ACCESS` is hand-maintained on purpose: whether a
tool mutates is a judgement about effects, not something derivable from a
schema.

There is no CLI counterpart; a human deciding to only look at things needs no
enforcement.

## 6. `lazy_internal_git` is validated but never advertised

`allDispatchableTools()` = `allTools` + `internalGitTool`. The internal tool is
reachable over HTTP and therefore must be schema-validated, but it never appears
in any advertised tool list. Coverage and discoverability are different
questions (`src/mcp/tool-registry.ts` states this as an invariant).

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

Keeping that pair honest is mechanical: `test/unit/mcp-resume-advice-honesty.test.ts`
fails if any tool description, the builder prompt, or the CLI notice tells anyone
to unblock with empty feedback.

## 9. `start` creates nothing — on either surface

Neither `lazy start` nor `lazy_start` accepts creation parameters. There is no
`--goal`, `--prompt`, `--code`, `--type` or `--parent` on `lazy start`, and
`lazy_start`'s schema takes `task_id` plus run-time overrides only. The only way
to make a task is `lazy create` / `lazy_create`, then start the id it returns.

This is the one entry here that is a *shared* restriction rather than a
CLI-vs-MCP asymmetry, and it is listed for the same reason as the rest: it looks
like a gap and keeps getting filed as one.

`lazy start` did have an inline create mode. It was removed deliberately in
March 2026 (`remove-start-inline-create`, commit `a709663`), which dropped
`--goal`, `--prompt`, `--code`, `--type` and `--parent` from the CLI and cut
`lazy_start`'s schema down to `task_id` in the same change.

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
`start`. Re-adding any creation parameter to either `start` surface reverses
this decision and needs the engineer's explicit approval.

## 10. Asking a conversation: one polymorphic CLI id, a separate MCP tool

`lazy ask <id>` resolves its id the way `lazy show` does: a task id asks that
task's live agent, a stored conversation's session id (or a unique prefix) asks
a throwaway read-only agent that reads the transcript. MCP does not overload
`lazy_ask` the same way — a conversation ask is `lazy_conversation_ask`.

The reason is the ownership gate. `lazy_ask` runs `assertAgentMayTarget`: a task
agent may only ask its own task or a direct child. A stored conversation has no
owner, no parent and no place in the task tree, so a polymorphic `lazy_ask`
would have to skip that gate for some values of `task_id` and enforce it for
others — exactly the "plausible-looking result on the wrong target" failure the
gate exists to prevent. A separate tool keeps each one's contract single.

Both surfaces share `src/conversation/ask.ts`, including id resolution, so they
cannot drift into resolving the same string differently.

`lazy_conversation_ask` is classified `'write'` in `src/mcp/tool-access.ts`
despite persisting nothing. 'read' there means "cannot change task state,
worktree contents, **or launch an agent**" — the ask launches one. Classified by
effect, not by what it stores. One consequence worth knowing: a read-only turn
(§5) serves read tools only, so an *asked* agent cannot ask a conversation. That
is the intended reading of "read-only" — an ask turn does not spawn more agents.

## 11. The task's agent: in every MCP listing, in no CLI list table

`lazy_show`, `lazy_status`, `lazy_list`, `lazy_blocked` and `lazy_active` all
return the task's `agent` alongside its `model`. The CLI's `lazy list` /
`lazy active` tables do not have an AGENT column — on the CLI it is on the
detail surface (`lazy show`'s `Agent:` row) and in the web task list, where it
is also a sortable column.

The reason is width, and it is the one asymmetry here that is about the medium
rather than about trust. A JSON payload has no columns to run out of; the CLI
tree table already spends 112 characters on fixed columns before the goal
starts, so a 12-wide AGENT column pushed the goal — the column a human actually
scans — off a 120-column terminal entirely, and off a 100-column one twice over.
The MCP listings pay nothing for the same field, and a builder scanning twenty
tasks for "which of these ran under cursor?" is exactly who needs it.

Per-TURN agent/model/effort labels are NOT asymmetric: `lazy show`, the
`lazy review` TUI, the web task page and the MCP `lazy_show` turn payload all
carry them, from one shared formatter (`src/utils/turn-labels.ts`).

## 12. Depth scoping: `--levels` on three CLI listings, on two MCP tools

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

## 13. Un-approving a protected file lives only on the review page

Approving a protected-file violation is sticky:
an unblock decides the PENDING violations only, so a record already marked
`approved` survives every later call that says nothing about it. Both
reviewer-facing surfaces can approve — `lazy unblock --approve-file`,
`lazy_unblock`'s `approved_files` — and neither can un-approve. There is no
flag, no sentinel value, and deliberately none planned. The one write path is
`setViolationDecision` in `src/daemon/review-service.ts`, reached from the web
review page.

Three reasons this is deliberate rather than a missing flag:

- **It is a reversal, not a decision.** Every other channel here expresses what
  the reviewer wants *now* about an undecided file. Un-approving retracts a
  decision already acted on — the agent has been told the file was kept and has
  built on it for one or more turns. That is rare enough, and consequential
  enough, to be worth a deliberate visit to the surface that shows the diff.
- **The review page is where the reviewer can see what they are retracting.**
  Un-approving from a terminal flag means naming a path from memory; on the
  review page the decision sits next to the rendered diff it applies to.
- **It does not revert anything by itself, and must not.** `setViolationDecision`
  returns the record to `pending`, NOT to `rejected`, and its comment says why:
  a `rejected` record is a settled decision, so a later accept would happily
  merge the change the reviewer just refused. `pending` instead routes it back
  through the same guard, with the same explicit approve-or-revert choice, on
  the next unblock. A CLI `--unapprove-file` that reverted immediately would
  re-introduce exactly the silent destruction this fix removed; one that only
  set `pending` would be a second, weaker spelling of a button that exists.

The remedy is named wherever stickiness is documented — `lazy unblock --help`,
the `approved_files` MCP schema, and
[lazy-toml.md](lazy-toml.md#resolving-a-conflict-task): un-approve on the review
page, or ask the agent to revert the file in the feedback text. If a reviewer
ever needs this without a browser, it should be scoped as its own task rather
than bolted onto an approval flag.

## When you find an asymmetry that is not listed here

It is probably accidental — this page is the complete list of the deliberate
ones. Treat an unlisted difference as a gap and report it. Adding a deliberate
asymmetry means adding it to this file in the same change.
