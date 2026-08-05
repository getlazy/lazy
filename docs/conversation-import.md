# Importing Claude Code conversations

Lazy stores conversations — the reasoning, exploration, and decisions from
interactive Claude Code sessions — as persisted development context alongside
task data. Sessions for a lazy project are captured **live** (see below). This
page covers importing *other* Claude Code history into the store: sessions that
predate lazy, or that recovery left behind.

Adopting lazy on a repo that already has Claude Code history should mean
inheriting that history as builder memory — not starting from scratch.

## Live capture: two paths, both automatic

Nothing needs importing for sessions that happen while lazy is running — they
are captured as they go:

- **The builder's own session** is captured by the in-container builder
  supervisor, on a timer while the session runs and again on exit. That covers
  what the builder can see from inside its container, and nothing else.
- **Every other Claude session for the project** runs on the *host*: any `claude`
  you run in the repo yourself. The daemon sweeps the Claude projects dirs once a
  minute and captures those. It is cheap by construction — discovery is `readdir`
  + `stat` plus one small head-read per session, and a session is parsed only
  when it is new or has changed since the last pass.

### What is deliberately NOT captured

Lazy runs its own machine-generated `claude -p` one-shots — the PR/commit
fidelity summaries on every accept, `lazy report`, and LLM memory compaction.
These are housekeeping, not conversations, and they were ~83% of the store,
drowning real builder conversations in `lazy builder list` and search. They are
now **never** captured, by either path.

They are identified by a marker that `runClaudeOneshot` prepends to the prompt,
so the session JSONL carries it durably (see `src/import/machine-oneshot.ts`).
Detection is structural — marked at the source, not sniffed from prompt wording —
so a real conversation that merely *discusses* the marker is still captured.

The end-of-pairing session summary (`lazy pair`) is marked the same way, even
though it goes through `runClaude` rather than `runClaudeOneshot` — its output
already lands on the task as a turn, so capturing the session too is noise.

Deliberately-skipped one-shots never count as uncaptured, so the capture-rot
check below stays honest instead of going red after every accept.

### Purging housekeeping conversations captured before the marker

Conversations stored *before* the marker shipped carry no marker, so nothing
removes them automatically. `lazy doctor --purge-housekeeping-conversations`
is the **one-time** cleanup for them:

```
lazy doctor --purge-housekeeping-conversations          # lists, deletes nothing
lazy doctor --purge-housekeeping-conversations --yes    # deletes
```

Without `--yes` it prints every conversation it classified — short session ID,
start time, which kind of one-shot it is, and why it was classified — and
deletes nothing. On a TTY it then asks for confirmation, defaulting to **no**;
a non-TTY is told to re-run with `--yes`. Deletion is not recoverable from lazy
(Claude Code prunes the raw JSONL on disk over time), so read the list.

This is the only place in lazy that classifies a conversation by sniffing
prompt wording (`src/import/housekeeping-conversation.ts`). That brittleness is
acceptable *here* precisely because the command is explicit, human-reviewed, and
one-time, where at capture time — running forever, on every sweep tick — it
would not be. Every rule is anchored at the very start of the conversation's
single user message, so a real conversation that quotes a lazy prompt is never
matched.

A caveat worth knowing: because these conversations have no marker on disk,
`lazy doctor --reimport-conversations` will re-import them if their raw JSONL is
still present. Purge is about cleaning up the store, not about rewriting what is
on disk.

If the daemon is not running, the second path is not running either — the
sessions stay on disk until a daemon is up or you import them manually.
`lazy doctor` fails (not warns) when it finds sessions from the last 24 hours
that never reached the store, because that means live capture is broken *now*:

```
✗ Conversation capture is live
  3 conversation(s) written in the last 24h (most recent 41m ago) are on disk
  but never reached the store — live capture is not running.
```

Sessions written in the last few minutes are treated as in flight, not as
failures — the sweep may simply not have ticked yet.

## One surface: `lazy import-conversation`

`lazy import-conversation` is the single surface for bringing Claude Code
history into the store, per-session or in bulk.

```bash
lazy import-conversation              # Preview + import all new sessions
lazy import-conversation --yes        # Import all new sessions, no prompt
lazy import-conversation --list       # List available sessions
lazy import-conversation bc77e1b1     # Import one session (id can be shortened)
lazy import-conversation --all        # Re-import everything (incl. already imported)
lazy import-conversation --show-imported     # Show already-imported conversations
lazy import-conversation --show bc77e1b1     # Show a full conversation transcript
```

### Where it looks (multi-root discovery)

Discovery spans **every** Claude projects dir for this repo:

- the shared `~/.claude/projects/<encoded-repo>/` dir, and
- the per-builder isolation dirs under `<data>/builder-projects/<id>/`
  (see `src/builder/projects-isolation.ts` for the layout).

When the same session appears in several dirs (seeding copies a session into
each isolation dir), the most complete copy is used (largest size, newest
mtime). This means a session that only ever lived in an isolation dir is still
importable — both in bulk and by session-id.

Not to be confused with `lazy builder --resume <id> --import`, which is a
different operation entirely: it decides which projects dir a *builder launch*
mounts (adopting a session that has never run under builder isolation), and
writes nothing to lazy's store. See "One `/resume` list per project" in
`docs/lazy-agent-design.md`. Importing a conversation here never affects which
sessions `/resume` lists, and adopting a session there never imports it.

### Bulk import never writes silently

Running `lazy import-conversation` with no session-id previews what would be
imported and asks for confirmation before writing:

```
Found 5 session(s) on disk; 3 missing from the store, 2 already imported.
Import 3 conversation(s) into the store?
```

Pass `--yes` to skip the prompt (for non-interactive callers). On a non-TTY
without `--yes`, it prints what it *would* do and writes nothing. Naming an
explicit session-id, or passing `--all`, imports directly — the argument/flag
is itself explicit intent.

Import is idempotent: sessions already in the store are skipped, and empty or
unparseable JSONL shells are skipped rather than stored as content-free stubs.
Lazy's machine-generated one-shots are excluded from discovery entirely, so no
import path can resurrect them; when any are present the count is reported
(`ignored 2 machine-generated lazy one-shot(s)`) rather than passed over in
silence, and naming one explicitly says so instead of "session not found".

## Recovery is the same flow

`lazy doctor --reimport-conversations` is an alias for the bulk path of
`lazy import-conversation` — same multi-root discovery, dedupe, preview, and
confirmation. It exists as a recovery entry point for stranded builder
conversations (the fallout of a capture bug that left conversations on disk but
out of the store). The `lazy doctor` health sweep also *detects* conversations
on disk but not in the store — a warning for old ones, a failure for recent ones
(see "Live capture" above) — and points at this command; detection is
report-only and never writes.

```bash
lazy doctor --reimport-conversations          # Preview, then confirm
lazy doctor --reimport-conversations --yes    # Recover without prompting
```

## Onboarding: `lazy init` offers to inherit history

When you run `lazy init` on a repo that already has Claude Code history, init
detects it and offers to inherit it. This is deliberately **one** step, not two
disjoint prompt blocks — adopting lazy on an existing repo should feel like a
single "inherit your history?" question, covering both kinds of history the
harness leaves behind:

- **conversations** — past sessions, imported as builder memory (see above)
- **harness memory files** — `<projects-root>/<encoded-cwd>/memory/*.md`,
  imported as lazy shared memory records (see [memory.md](memory.md))

```
This repo already has Claude Code history from before lazy.
  Found 4 existing Claude Code session(s) for this repo.
  Found 3 Claude Code harness memory record(s) with no lazy counterpart.
  Lazy can import both, so you inherit your project's history instead of
  starting from scratch.
  Import 4 conversation(s) as builder memory? [Y/n]
  Import 3 memory record(s) into lazy shared memory? [Y/n]
```

Each half of the offer appears only when there is something to import, so a repo
with sessions but no harness memory sees exactly one prompt.

Detection stays cheap for both: the per-builder isolation dirs don't exist yet at
init, so it's a single scan of `~/.claude/projects` for dirs matching this repo,
plus a `readdir` of each match's `memory/` subdir. The memory count is filtered
against the store, so re-running init never re-offers records lazy already holds.

Both offers are prompts — skipped under `--non-interactive`, never a silent
write. Detection and import are best-effort: a hiccup in either prints a
`(Skipped Claude Code history import: …)` note and never fails init. If you
decline, you can import later with `lazy import-conversation` and
`lazy doctor --import-memory` respectively.
