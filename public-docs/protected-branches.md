# Protected branches and human approvals

Branch protection flips the builder's default on sensitive merges from
*"accept unless told not to"* to *"cannot accept without a deliberate human
act."* It is **friction, not security**: the builder is an over-eager
cooperator, not an adversary. Treat it as a speed bump that makes an
unreviewed merge require a deliberate act, not as a boundary that would hold
against one.

## Turning it on: one command, zero branch listing

Protection is **opt-in — OFF by default**. A project with no `[protection]`
section (or with `enabled = false`) has no protection at all: accepts into
`main` behave exactly as they always have. That is deliberate — a brand-new
user's first `lazy accept` should merge, not refuse over a gate they have not
heard of yet.

One command turns it on:

```
lazy protect main on
```

That both lists `main` in `[protection].protected_branches` **and** sets
`enabled = true` (it says so when it does). From then on, accepting any task
into `main` requires a human `lazy approve <task>` — or an approval on the
task's PR/MR, which satisfies the same gate.

The equivalent by hand, which needs no branch listing at all because the repo's
**default branch** is protected as soon as the switch is on:

```toml
[protection]
enabled = true   # protects the repo's default branch; set false (or delete) to turn off
```

Toggling `enabled` off and on again loses nothing: the rest of the section is
kept, it just has no effect while disabled. `lazy protect <target> off` never
touches the switch — unprotecting one branch is not the same act as turning
the feature off.

### How you find out it exists

Since protection is off by default, `lazy accept` advertises it: after an
accept **succeeds** into the repo's default branch, it prints one line —

```
Tip: gate future accepts into `main` behind a human approval — lazy protect main on
```

The tip is suppressed once you have expressed an opinion: writing `enabled`
into `[protection]` (either value) stops it for good, as does having protection
on. An explicit `enabled = false` means you know about the feature and said no,
so lazy stops mentioning it.

## Seeing a gate before it bites

Protection is friction, and friction you meet for the first time as a refusal
is just a surprise. Once a project protects anything, every read surface says
so — before you try to accept.

| Surface | What you see |
| --- | --- |
| `lazy show <task>` | a `Protected:` line — `yes (branch gate)`, `yes (task gate)`, or `yes (task gate + branch gate)` — followed by what each gate is and where the approval stands |
| `lazy status <task>` | the same `Protected:` line, in the same words |
| `lazy list` / `lazy active` / `lazy blocked` | a compact `[P]` marker on the goal, `[P][A]` when an approval is recorded and pending, plus a one-line legend under the table |
| `lazy review <task>` | the gate in the header line (and above the hunks under `-i`), so you learn about it before you press `a` |
| MCP `lazy_show` | a `protection` object — `gated`, `target_branch`, `task_gate`, `branch_gate`, `approval_pending`, `markers`, `summary` |
| Web dashboard | the same `[P]` / `[P][A]` badge on the task list, and a `Protected` row on the task detail page |

Two properties are deliberate:

- **Additive only.** A project that protects nothing sees exactly the output it
  saw before — no marker, no legend, no `Protected:` line. Markers sit in the
  last column so no fixed-width column shifts, and they are ASCII (`[P]`, not a
  shield emoji, whose width varies by terminal) so scripts can grep them.
- **Read-only.** These surfaces report gates; they never arrange them. There is
  no MCP write surface for `lazy protect` or `lazy approve` — see
  [surface-asymmetries.md](surface-asymmetries.md). The builder can plan around
  a gate without being able to open it.

A task you listed in `protected_tasks` while `enabled = false` gets no marker —
it gates nothing — but `lazy show` still reports it, as `no — listed in
[protection].protected_tasks, but protection is disabled`. Silence there would
leave you believing a gate was armed when it was not.

All surfaces render one shared vocabulary (`src/protection/status.ts`), which
also resolves the target branch exactly the way accept resolves it. A new
surface renders those helpers; it does not re-derive protection from config.

## What a protected accept looks like

With protection on, `lazy accept` of a task targeting a protected branch
refuses — regardless of who asks (CLI `--yes`, the builder over MCP, any
automation) and on **all** remote drivers, including `local`. The refusal
says exactly what to do: merging into `main` requires human approval — run
`lazy approve <task>`.

```
lazy system passphrase set   # once per MACHINE, at your own terminal
lazy approve <task>          # prompts for the passphrase
lazy accept <task>           # consumes it once it completes
```

- The passphrase lives **nowhere in the repository**. It is enrolled once per
  machine with `lazy system passphrase set`, stored as a `Bun.password` hash
  (argon2id) at `~/.lazy/passphrase.json` with mode `0600`, and covers every
  lazy project on that machine. What makes the approval meaningful is that the
  passphrase is **outside the builder's context** — never paste it into a
  conversation with the builder. See
  [the enrollment section](#enrolling-the-passphrase-lazy-system-passphrase).
- One approval unlocks **exactly one** accept of that task, and it is spent
  **only when that accept completes**. Passing the gate merely reserves the
  approval; it is consumed at the moment the merge becomes durable (the same
  point that writes the accept tag, or that hands the merge to the forge). An
  accept that fails or aborts at any phase — pre-flight, a pre-merge gate, the
  merge itself — leaves the approval pending and says so in the failure, so
  you fix the cause and re-run `lazy accept` **without approving again**.
  Consumption happens inside accept's per-task lock, so two concurrent accepts
  can never both spend one approval.
- `lazy approve` checks enrollment **before** it prompts. With nothing enrolled
  on the machine, it prints the enrollment instructions and exits non-zero
  without asking you to type a secret that could not possibly have matched. The
  interactive prompt is a bare `Approval passphrase:` — it names no file,
  because there is no file to read it from.
- The prompt is **masked** — each character you type shows as `*`, so the
  passphrase never reaches the screen, terminal scrollback, or a screen
  share. Masking needs a real terminal: without one, `lazy approve` refuses
  rather than falling back to an echoing prompt.
- `lazy approve` is CLI-only. There is deliberately **no MCP equivalent**;
  exposing one would let the builder approve its own work.
- The MCP `lazy_accept` tool refuses protected accepts up front and **never
  issues a confirmation code** for them: the two-step confirmation is
  self-satisfiable by the builder and does not count as authorization for a
  protected merge (it remains in place for unprotected operations).

Task-to-task merges (a subtask accepted into its parent's `lazy/*` branch)
are never protected by default — no friction in the inner loop. Re-entry of a
task already in `merging` status is exempt — a human already approved the merge
that reached that state (and it was spent when the forge took the merge over);
re-entry only completes that authorized merge.

### CI and scripting

There is deliberately **no `--yes`** for `lazy approve`, and — since v0.23 —
**no scripted route to the passphrase at all**: no flag, no env var, no piped
stdin. It is typed at the masked prompt, at a terminal, or not at all.

Until v0.23 `echo "$SECRET" | lazy approve <task>` was supported and
documented. It is now refused with a message pointing you at a terminal. The
reason is the same one that moved the passphrase out of the repo: a value a
script can supply is a value that lives on in shell history, CI logs, process
listings and agent transcripts, and a gate whose credential can be replayed by
automation is not proof a human looked at the diff. If a pipeline needs to
merge without a human, the honest answer is to not protect that branch, or to
merge it on the forge where the approval is a person clicking Approve.

### Approving the PR/MR counts

On a GitHub or GitLab project, **approving the task's PR/MR satisfies the same
gate** — no separate `lazy approve` needed. Clicking "Approve" while reading
the diff is the same deliberate human act, expressed where you were already
reviewing; demanding a second local approval on top would be friction with no
extra judgement behind it.

The two are one mechanism, not two: the forge approval is resolved *inside*
the same gate, so a local-driver project and a forge project reach the
identical decision. Details that follow from that:

- The forge is checked **first**, so an already-approved PR does not silently
  burn a pending `lazy approve` record — that record stays for an accept that
  needs it.
- The check **fails closed**: if the forge cannot be reached, the gate stays
  shut and the refusal points you at `lazy approve`, which works offline.
- A refusal on a forge project names both routes; on a `local` project it
  names only `lazy approve`, because there is no PR to approve.

## Enrolling the passphrase: `lazy system passphrase`

```
lazy system passphrase set      # enroll or rotate (asks twice; rotation asks for the current one)
lazy system passphrase status   # is this machine enrolled? never prints or hints at the value
lazy system passphrase delete   # un-enroll (asks for the current passphrase first)
```

**One enrollment per machine, not per project.** Keying the credential to a
project would need a stable project identity, and the only identity available
is the path — which changes the moment the repo is cloned, moved, or opened
from a worktree. A passphrase that silently stops working after `git clone` is
worse than one shared across your projects, and the passphrase is *friction*
(proof a human is at the keyboard), not a per-repo secret.

**Stored hashed, outside every repository.** `~/.lazy/passphrase.json` holds a
`Bun.password` hash (argon2id) and mode `0600` — never the passphrase. It sits
one level *above* `~/.lazy/daemon/`, with its own `LAZY_PASSPHRASE_BASE_DIR`
seam, so `LAZY_DAEMON_BASE_DIR` cannot relocate your credential out from under
you. lazy **refuses** — not warns — to use a store that is group- or
world-readable, and tells you the `chmod` to fix it: a hash other accounts can
read is a hash they can attack offline while you believe the gate is intact.

**There is no recovery — reset instead.** The store holds a hash, so a
forgotten passphrase cannot be read back, and both rotation (`set`) and
`delete` ask for the current one. The way back is to remove the store yourself
and enroll again:

```bash
rm ~/.lazy/passphrase.json      # the file `lazy system passphrase status` names
lazy system passphrase set      # enroll a new one, at your terminal
```

That is a plain local file only your account can write, and removing it resets
the passphrase and nothing else — protection settings, tasks and branches are
untouched. Until you re-enroll, protected merges **fail closed**: `lazy approve`
refuses and points back at `lazy system passphrase set` rather than letting the
merge through.

Three deliberate restrictions, each load-bearing:

- **TTY only.** No flag, no env var, no piped stdin — same reasoning as
  [CI and scripting](#ci-and-scripting) above.
- **No daemon, no MCP tool.** Enrollment writes from the CLI process on your
  host; verification stays daemon-side. If enrollment went *through* the
  daemon, anything that can reach the daemon could enroll a new passphrase and
  then satisfy its own gate.
- **Refuses inside a container.** A task agent's container is not your
  terminal, and the command exists for your terminal.

### Migrating from `.lazy/approve-passphrase`

Before v0.23 the passphrase sat in plaintext inside the repo, at
`.lazy/approve-passphrase` or wherever `[protection].passphrase_file` pointed.
Both are **gone**: the key is removed from the schema (`lazy doctor` explains
the migration if it is still in your `lazy.toml`), and the old file is **never
consulted** — leaving it in place does not satisfy the gate. Run
`lazy system passphrase set`, which offers to delete the stale file for you;
`lazy system passphrase status` and `lazy doctor` flag it until it is gone.

### What this does not close

If nothing has ever been enrolled on a machine, the **first** enrollment is
reachable by an agent running under the **host-process** runner — it shares
your user account, so it could run the command's code path itself. Rotation is
not (it requires the current passphrase), and neither is reading the passphrase
back (only a hash is stored). This residual is accepted rather than papered
over: the real fix is running agents in containers, which is the default
runner and where the command refuses outright.

## Advanced: protecting additional branches

For projects with more than one sensitive branch, `protected_branches` adds
to the automatic default-branch protection (exact names, no globs):

```toml
[protection]
protected_branches = ["release"]
```

`gate_default_branch = false` switches off the automatic default-branch
protection, leaving only the explicit list. See the `[protection]` reference
in [lazy-toml.md](./lazy-toml.md).

### The default branch is an implicit entry

The default branch is gated **without appearing in `protected_branches`** — it
is resolved from the remote (`refs/remotes/<remote>/HEAD`) at decision time, so
it stays correct if the repo's default branch ever changes. Because nobody
typed it into a list, it is surfaced everywhere the list is:

- `lazy protect` shows it under **Protected branches**, marked `(implicit —
  gate_default_branch)`.
- `lazy protect <default-branch> off` does not claim it is unprotected — it
  says what actually protects it and that `gate_default_branch = false` is the
  key that lifts it. (Listing it explicitly is still allowed and is saved: the
  entry outlives a later `gate_default_branch = false`.)
- `lazy doctor` warns when that remote ref is missing, because resolution then
  falls back to the literal `main` — on a `master` repo, a gate you believe is
  armed would protect nothing. The fix it names is
  `git remote set-head <remote> --auto`.

## Protected tasks: gating work on the way OUT

A protected **branch** gates merges coming *in*. A protected **task** gates
one task's work going *out*: merging its branch upward requires approval
**regardless of the target** — including into a `lazy/*` parent branch, which
is otherwise never gated.

Use it when a particular piece of work is the sensitive thing, wherever it
lands: a risky refactor, a task you want to read yourself before it moves
anywhere, a long-running task that accumulates subtask work freely but must
not be promoted without you.

Tasks are listed by **code or short id**, not by branch — the branch is
resolved from the task at decision time, so it stays correct:

```toml
[protection]
protected_tasks = ["add-auth"]
```

The refusal names the task and, as always, `lazy approve <task>`.

### Stale entries fail open — loudly

A listed task that no longer resolves to a branch — deleted, code changed,
identifier now ambiguous, or simply never started — **gates nothing**. It
fails open rather than blocking every accept on a config typo.

That is the dangerous half of the trade: you believe a gate is armed when it
is not. So a stale entry is made loud in three places:

- the accept path **warns** on every gated accept
- `lazy doctor` reports it, naming each stale code and its fix
  (`lazy protect <code> off`) — report-only, never a hard failure
- `lazy protect` shows it as stale in the listing

## The `lazy protect` command

`lazy protect` is the single CLI for all of the above. It edits the
`[protection]` section of `lazy.toml` in place — there is **one store**, and
you can always read or hand-edit it.

```bash
lazy protect                       # Show the current protection state
lazy protect release on            # Protect merges INTO branch 'release'
lazy protect add-auth on           # Protect merges OUT OF task 'add-auth'
lazy protect add-auth off          # Lift that task gate
lazy protect --branch main off     # Stop protecting the 'main' branch
```

- The target resolves as a **task code or short id first**, then as a branch
  name — you think in tasks more often than in branches. When it matches
  both, the command says so and takes the task; `--branch` / `--task` settle
  it explicitly.
- Turning a target **on** also sets `enabled = true` when the switch is off,
  and says so. Protection is opt-in, so a bare list edit would otherwise be
  inert — you would believe you had gated a branch when you had not.
- Turning a target **off** never touches the switch. While protection is
  disabled such an edit is still saved (losing your change would be worse than
  a no-op) but **warns** that it has no effect yet. `lazy doctor` flags the
  same combination: gate keys configured while the switch is off.
- There is deliberately **no MCP equivalent for writing**: the builder must
  not manage its own gates, for the same reason it cannot run `lazy approve`.
  Reading the state is harmless.

### What the config editing does and does not preserve

`lazy protect` edits `lazy.toml` as text rather than reparsing and
re-serializing it, so **comments, blank lines, key order and quoting style
survive**. Known limitations:

- A replaced **multi-line** array collapses to a single line. Comments
  *inside* that array's brackets are lost; comments above and below are not.
- Removing the last entry writes an explicit `protected_branches = []` rather
  than deleting the key — "nothing is protected" said out loud.
- The dotted form (`protection.protected_branches = [...]`) and an inline
  table (`protection = { ... }`) are **rejected with an error** rather than
  edited, since rewriting them safely is not possible at the text level.
  Convert to a `[protection]` section and re-run.

## Mechanics

Verification goes through a pluggable `verifyHumanToken` seam
(`src/protection/verify-token.ts`). The static passphrase is the first-cut
mechanism; TOTP can replace it behind the same seam.

The seam also answers a token-free question — "is anything enrolled?" — which
is what lets `lazy approve` refuse before prompting, and which names the
token's source in the prompt. A mechanism that cannot know the answer without
a token (TOTP has no file to inspect) reports that honestly, and `lazy approve`
falls back to asking and then verifying. The CLI asks the daemon this over a
pre-flight RPC rather than reading config itself, so the answer always comes
from the same project root that will do the verifying.

A forge PR approval is an *additional* satisfier of that same check, not a
parallel mechanism — see [Approving the PR/MR counts](#approving-the-prmr-counts)
above. The accept path hands the gate a probe for it rather than checking the
forge on its own branch of logic, so adding a future satisfier means adding it
in one place.

## A separate gate on the same path

The [deleted-file resurrection guard](resurrection-guard.md) sits immediately
after this one in the accept path and refuses a merge that would silently put
back a file the target branch deleted. It is unrelated to protection — always
on, no config, and it asks about the *content* of the merge rather than about
who is allowed to make it — but it shares the enforcement point and the
`--approve-file` approval channel.

## What this does NOT do

Deliberate non-goals: no threat model against a hostile builder, no
push-prevention (an agent on a host runner can `git push` around the check —
accepted), no cryptographic hardening or rate limiting. The feature succeeds
if it changes the *default* path from auto-accept to human-approved.

Moving the passphrase out of the repo (v0.23) closed one concrete hole — the
secret is no longer sitting in plaintext in a tree every agent can read, at a
path the repo's own config could redirect. It did not turn friction into
security: see
[What this does not close](#what-this-does-not-close) for the residual that
remains under the host-process runner.
