# Protected branches and human approvals

Branch protection flips the builder's default on sensitive merges from
*"accept unless told not to"* to *"cannot accept without a deliberate human
act."* It is **friction, not security**: the builder is an over-eager
cooperator, not an adversary. The design rationale lives in the spike
([docs/spikes/protected-tasks-and-epics.md](./spikes/protected-tasks-and-epics.md));
this page documents the shipped behavior.

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

## What a protected accept looks like

With protection on, `lazy accept` of a task targeting a protected branch
refuses — regardless of who asks (CLI `--yes`, the builder over MCP, any
automation) and on **all** remote drivers, including `local`. The refusal
says exactly what to do: merging into `main` requires human approval — run
`lazy approve <task>`.

```
echo "your-passphrase" > .lazy/approve-passphrase   # once, out-of-band
lazy approve <task>                                  # prompts for the passphrase
lazy accept <task>                                   # consumes the approval
```

- The passphrase file (default `.lazy/approve-passphrase`, configurable via
  `[protection].passphrase_file`) is gitignored and never surfaced through
  MCP. What makes the approval meaningful is that the passphrase is **outside
  the builder's context** — never paste it into a conversation with the
  builder.
- One approval unlocks **exactly one** accept of that task. If the accept
  fails afterwards (e.g. a merge conflict), approve again after resolving —
  the content being merged has changed.
- `lazy approve` checks enrollment **before** it prompts. With no passphrase
  file, it prints the enrollment instructions and exits non-zero without
  asking you to type a secret that could not possibly have matched. The
  interactive prompt names the file it checks against:
  `Approval passphrase (from .lazy/approve-passphrase):`.
- `lazy approve` is CLI-only. There is deliberately **no MCP equivalent**;
  exposing one would let the builder approve its own work.
- The MCP `lazy_accept` tool refuses protected accepts up front and **never
  issues a confirmation code** for them: the two-step confirmation is
  self-satisfiable by the builder and does not count as authorization for a
  protected merge (it remains in place for unprotected operations).

Task-to-task merges (a subtask accepted into its parent's `lazy/*` branch)
are never protected by default — no friction in the inner loop. Re-entry of a
task already in `merging` status is exempt — reaching that state already
consumed an approval; re-entry only completes the authorized merge.

### CI and scripting

There is deliberately **no `--yes`** for `lazy approve`. A flag that skips the
token would make the gate decoration: the whole point is that the token
originates outside the builder/agent context. The supported script-friendly
path is piped stdin, with the passphrase coming from your secret store:

```bash
echo "$LAZY_APPROVE_PASSPHRASE" | lazy approve <task>   # e.g. a CI secret
```

Pipe it — never pass it as an argument, where it would land in shell history,
process listings, and CI logs. For the same reason there is no `--passphrase`
flag.

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

## What this does NOT do

Per the spike's non-goals: no threat model against a hostile builder, no
push-prevention (an agent on a host runner can `git push` around the check —
accepted), no cryptographic hardening, rotation, or rate limiting. The
feature succeeds if it changes the *default* path from auto-accept to
human-approved.
