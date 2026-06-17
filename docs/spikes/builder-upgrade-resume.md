# Spike: Seamless builder resume across `lazy upgrade`

**Status:** design spike (no code changes)
**Date:** 2026-05-25
**Goal:** Make interactive `lazy builder` sessions survive a `lazy upgrade` and resume the *same* conversation in the *same* terminal with zero (or near-zero) manual steps — matching the auto-resume that task supervisors already get.

> Every load-bearing claim below cites the code it was verified against. Where I
> could not verify something, I say so explicitly rather than asserting it.

---

## 1. Mechanics, verified

### 1.1 How a builder session is launched and attached to the terminal

`lazy builder` is a **foreground host CLI process** that owns the user's TTY for
the lifetime of the session.

- `commandBuilder` parses flags, builds the system prompt, creates a runner, and
  ultimately calls `runner.launchBuilderInteractive(...)`, awaiting its result
  before printing a session footer and calling `process.exit(exitCode)`
  (`src/cli/commands/builder.ts:335-362`).
- In **docker/podman mode** (`runner.usesSandbox()` is `true` —
  `src/runner/docker-runner.ts:264-266`), `launchBuilderInteractive` runs a
  fresh container with `docker run -it --init --rm --name lazy-builder-<id>` and
  **inherited stdio** (`stdin/stdout/stderr: 'inherit'`), then `await proc.exited`
  (`src/runner/docker-runner.ts:464-535`). The container's entrypoint is
  `lazy-agent builder ...` — the **builder supervisor**, not Claude directly
  (`src/runner/docker-runner.ts:501-509`).
  - **This is NOT a `docker exec` into a persistent container.** It is a
    single-shot `docker run --rm`; when the process exits, the container is
    removed. Confirmed by the `--rm` flag and the upgrade comment "Builder
    containers use --rm flag, so they auto-remove on stop"
    (`src/cli/commands/upgrade.ts:315`).
- Inside the container, the builder supervisor (`runBuilderSupervisor`) spawns
  `claude --append-system-prompt <file> [extra args]` with inherited stdio and
  `await proc.exited` (`src/supervisor/builder.ts:91-115`). So the human's
  keystrokes flow: **terminal → host `docker run -it` → container PID 1 (tini via
  `--init`) → `lazy-agent builder` → `claude`.**
- In **host-process mode** (`usesSandbox()` is `false`),
  `launchBuilderInteractive` spawns `claude` directly on the host with inherited
  stdio — no supervisor, no container (`src/runner/host-process-runner.ts:519-559`).

The key structural fact for this spike: **the human terminal is attached to a
host process (`lazy builder`) that blocks on a child it does not control across
an upgrade.** The daemon has no handle to this TTY.

### 1.2 How `sessionId` is captured and surfaced

Two different paths, and they behave differently — this matters for resume:

- **Docker mode:** `launchBuilderInteractive` returns `{ exitCode, sessionId: null }`
  — the host **never learns the sessionId from the return value**
  (`src/runner/docker-runner.ts:546`). Instead, the in-container supervisor
  detects the Claude sessionId by diffing JSONL files in `~/.claude/projects/...`
  (`startCaptureMonitor` / `findActiveSessionFile`,
  `src/supervisor/builder.ts:171-192, 272-363`), saves the conversation to
  storage via `storage.saveConversation(...)`
  (`src/supervisor/builder.ts:314-315, 343-347`), and prints
  `Builder session: <id>` **to stderr** (`src/supervisor/builder.ts:120-124`).
  Because the host's `sessionId` is `null`, the host-side `Session:` / `Resume:`
  footer in `builder.ts:356-360` **does not print in docker mode** — only the
  supervisor's stderr line does.
- **Host-process mode:** `captureConversation(...)` runs on the host after exit
  and returns the detected sessionId, so the host prints the
  `Session:` / `Resume:` footer (`src/runner/host-process-runner.ts:544-559`,
  `src/cli/commands/builder.ts:356-360`).

### 1.3 What `--resume` does and where the resume source comes from

- `--resume <id>` passes `--resume <id>` straight through to Claude Code
  (`src/cli/commands/builder.ts:240-243, 309-316`). Bare `--resume` reads the
  sessionId from the **`LAZY_LAST_SESSION_ID` env var**
  (`getLastSessionId`, `src/cli/commands/builder.ts:135-139, 230-239`).
- **`LAZY_LAST_SESSION_ID` is never written by lazy.** Every reference is a
  *read* or doc text — verified by grepping the whole `src/` tree
  (`src/cli/commands/builder.ts` is the only file that touches it, and only to
  read it). It is a **user-managed shell variable**. So today the human either
  copies the printed sessionId into `--resume <id>`, or has wired
  `LAZY_LAST_SESSION_ID` into their shell themselves.

### 1.4 What survives an upgrade and what is lost

`lazy upgrade` (`src/cli/commands/upgrade.ts`):

1. Discovers builder containers for **this project only** via the
   `lazy.project=<root>` Docker label
   (`discoverProjectBuilderContainers` → `runner.discoverProjectBuilderRuns`,
   `upgrade.ts:87-89`, `docker-runner.ts:223-241`; label applied at launch,
   `docker-runner.ts:470`).
2. Stops each builder container with `runner.stopRun(name)`
   (`upgrade.ts:308-317`). Because the container is `--rm`, stopping it removes
   it.
3. Force-rebuilds the image + agent binary, then restarts the daemon
   (`upgrade.ts:322-349`).

**Survives** (persisted outside the container):
- The Claude **conversation history and sessionId** — they live in the shared
  `~/.claude/` mount (`-v ${getHome()}/.claude:/home/user/.claude`,
  `docker-runner.ts:485`), which is host state untouched by upgrade. This is
  exactly what makes `claude --resume <id>` work afterward.
- The captured conversation in lazy storage (saved incrementally and on exit by
  the supervisor, `src/supervisor/builder.ts:314-315, 343-347`).
- Builder tool-call routing/state: tool calls proxy through the **daemon** MCP
  routes (`queryDaemonMcpConfig`, `src/cli/commands/builder.ts:323-336`;
  `src/daemon/rpc-fallback.ts`), so the daemon — not the container — owns task
  state. Resume only needs to restore the **terminal attachment**, not state.

**Lost** when the container is stopped:
- The container itself (`--rm`) and the **terminal attachment**. The host
  `docker run -it` returns, so the host `lazy builder` process unblocks at
  `await proc.exited` (`docker-runner.ts:535`) and then `process.exit()`s
  (`builder.ts:362`). The interactive session is gone.
- **Any typed-but-unsent input** in the Claude prompt buffer at the moment of
  the stop. This is the **"never lose human feedback"** risk for this spike
  (see CLAUDE.md). I could not find any mechanism that flushes or preserves the
  Claude input buffer on SIGTERM — Claude Code owns that buffer and we pass
  signals straight through `--init`. **Treat unsent input as lost today.**

### 1.5 Exactly why daemon auto-resume cannot cover builders

Task supervisors auto-resume because they are **daemon-owned and headless**:

- The reconciler keys entirely off **tasks in storage** — `reconcileTask` starts
  with `storage.getTask(taskId)` (`src/utils/reconcile.ts:182`) and
  `autoResumeTask` relaunches a **headless supervisor** for an interrupted task
  (`src/utils/auto-resume.ts:109-191`). After upgrade, the restarted daemon
  reconciles stopped task containers → marks interrupted → auto-resumes
  (`upgrade.ts:340-353`).
- **Builders have no task in storage.** `discoverRunningContainers` explicitly
  skips any container whose name has no matching task
  (`upgrade.ts:56-65`), and builder ownership is resolved by Docker *label*
  precisely *because* "Builder containers have no matching task in storage
  (unlike supervisors)" (`upgrade.ts:79-89`). So the reconciler never sees a
  builder and can never auto-resume one.
- Even if it did, **auto-resume relaunches headless** (a background supervisor
  process). A builder must be reattached to a **human TTY**, and the daemon has
  no TTY — it is a background service. This is the core asymmetry: *task
  supervisors are headless and daemon-owned; builders are foreground and
  human-terminal-owned.* The upgrade doc text already states the consequence:
  "Builder containers will restart on next use" (`upgrade.ts:248, 371`).

---

## 2. Approaches and trade-offs

### Shared sub-problems (apply to every approach)

- **S1 — Getting the sessionId on the host (docker mode).** The host currently
  gets `sessionId: null` (§1.2). Any auto-resume must learn the sessionId. The
  cleanest source that already exists: after the container exits, query
  `storage.listConversations()` for the newest builder conversation for this
  project (the supervisor saves it before exit, `src/supervisor/builder.ts:343-347`).
  Alternative: have the supervisor write the sessionId to a known file in the
  writable data-dir mount (`-v ${dataDir}:${dataDir}`, `docker-runner.ts:477`).
  Either works; the storage query reuses existing machinery.
- **S2 — Distinguishing "upgrade stopped me" from "user quit" / "crash".**
  `docker stop` delivers SIGTERM→SIGKILL; the resulting `docker run` exit code
  (typically 143/137) is **not a reliable upgrade signal** — a user Ctrl-C or an
  OOM kill can produce similar codes, and I did not verify the exact code lazy
  observes. A reliable signal needs to be **explicit** (a marker written by
  `lazy upgrade`), not inferred from exit codes.
- **S3 — Never lose unsent input (§1.4).** No approach below can recover text
  already typed into Claude's prompt buffer unless Claude Code itself persists
  it. The honest mitigation is to **warn before stopping a live builder** and let
  the human hit Enter / save first.

### (a) Supervised relaunch loop (host-side wrapper owns the TTY)

`lazy builder` becomes a thin host-side loop: it owns the TTY, launches the
builder child (container or host `claude`), and on an **upgrade-induced exit**
re-execs itself with `--resume <sameId>` into the same terminal.

- **Upgrade handshake (S2):** `lazy upgrade`, before stopping builder containers
  (`upgrade.ts:308-317`), writes an explicit marker — e.g. a row/file per
  stopped builder keyed by `lazy.project` and container name — saying "I stopped
  this builder for an upgrade; expect to resume." The wrapper, after its child
  exits, checks for a marker matching its own builder id. If present (and only
  then), it waits for the upgrade to finish (daemon healthy again + new image
  built), clears the marker, and re-execs `lazy builder --resume <id>`.
- **SessionId threading (S1):** wrapper resolves the sessionId from storage (or
  the data-dir file) after the child exits, then passes `--resume <id>`.
- **Host-process vs docker:** Works the same shape in both — only the child
  launch differs (the runner already abstracts this). But note host-process mode
  is **not stopped by upgrade at all**: `discoverProjectBuilderRuns` returns `[]`
  for host-process (no builder runs to find — see the invariant comment at
  `upgrade.ts:84-86` and that `forceRebuildImage` is skipped for host runners,
  `upgrade.ts:325-338`). A host-process builder keeps running old in-memory code
  through an "upgrade"; there is nothing to relaunch. So this approach is
  **docker/podman-only in practice** (acceptable — that's the default and the
  reported pain).
- **Failure modes:**
  - *Rebuild fails mid-cycle:* the wrapper is alive and holds the TTY, so it can
    surface the error and offer manual `--resume`. Marker must be **cleared only
    after** a successful relaunch, so a crashed wrapper leaves a discoverable
    marker (recovery path).
  - *Wrapper itself is replaced by upgrade:* the wrapper is the **already-running
    `lazy` binary in memory**; upgrade rebuilds the on-disk binary but cannot
    swap the running process. The re-exec picks up the new binary. Good — no
    chicken-and-egg.
  - *User had unsent input (S3):* lost. Mitigate with a pre-stop warning from
    upgrade.
- **Pros:** Conceptually simple; no new long-lived infra; the human's terminal
  is continuously owned by a lazy process so we control re-attachment and
  messaging. Reuses existing resume + storage machinery.
- **Cons:** Requires a real cross-process handshake (upgrade ↔ live builder) and
  a marker store — an **architectural-invariant touch** (coordination between
  `lazy upgrade` and a live builder; storage must own the marker per "Storage is
  abstracted"). Re-exec UX: the screen will clear/redraw as Claude restarts;
  scrollback from the pre-upgrade session is gone (conversation is preserved, raw
  terminal scrollback is not).

### (b) tmux-backed detach/reattach

Run the builder **inside a tmux session** so upgrade can detach it, rebuild, and
reattach without dropping the human terminal.

- **Reality check on current tmux usage:** `src/terminal/` does **not** host
  interactive sessions today. `TmuxDriver.watchTask` only does **read-only**
  attach/switch (`tmux attach -r` / `switch-client -r`,
  `src/terminal/tmux.ts:28-47`), and `createTmuxWatchSession` creates a
  **detached** session that runs a *follow command* like `docker logs -f`
  (`src/terminal/index.ts:47-68`) purely for observation by `lazy watch`. None of
  this runs an interactive Claude attached to a human. So (b) is **mostly new
  infrastructure**, not "reuse `src/terminal/`."
- **How it would work:** `lazy builder` creates/attaches a tmux session
  (e.g. `lazy-builder-<id>`) whose pane runs the `docker run -it` (or host
  `claude`). The human is attached to tmux, not directly to `docker run`. On
  upgrade: the builder **detaches** the human (or upgrade does), the old container
  is stopped, a new one is started **inside the same tmux pane** with
  `--resume <id>`, and the human is reattached. The tmux session survives because
  it is a separate long-lived server process, independent of both the daemon and
  the per-container lifecycle.
- **Upgrade handshake (S2):** still needs an explicit signal — upgrade sends a
  command into the tmux session (`tmux send-keys` / `respawn-pane`) or writes the
  same marker the pane's controller polls. The exit-code ambiguity is unchanged.
- **Host-process vs docker:** tmux can host either child. Unlike (a), tmux could
  in principle keep a host-process builder alive across the (no-op) rebuild —
  but since host-process upgrade doesn't stop anything, there's little to gain.
- **Failure modes:**
  - *Rebuild fails:* the tmux pane is alive; show the error there, leave it for
    manual recovery. Detach/reattach is more robust to wrapper crashes than (a)
    because the session outlives the controlling client.
  - *No tmux installed:* must fall back to (a)-style behavior or to today's
    manual flow. `createTerminal()` already degrades to `VanillaTerminalDriver`
    when `$TMUX` is unset (`src/terminal/index.ts:24-29`), but note that only
    detects *being inside* tmux — launching a fresh tmux server is a new code
    path.
  - *Unsent input (S3):* **best of the options** — if upgrade only *detaches*
    (not kills) and the rebuild could be done without killing the container, the
    buffer might survive. But our builder container is `--rm` single-shot and
    must be replaced with the new image, so in practice the container *is* killed
    and the buffer is still lost. tmux preserves *terminal* state, not Claude's
    internal input buffer.
- **Pros:** Detach/reattach is the natural primitive for "survive a restart in
  the same terminal"; session outlives client crashes; could later enable
  multi-client attach and `lazy watch`-style observation of builders.
- **Cons:** Significant new infrastructure (interactive tmux hosting, lifecycle,
  reattach, naming, cleanup); a hard tmux dependency or a dual-path fallback;
  nested-tmux UX problems if the human already runs tmux (the existing code uses
  `switch-client` when already inside tmux — reattaching a builder pane inside a
  user's existing tmux is fiddly); doesn't actually solve S3 better in our
  `--rm` reality.

### (c) (considered, rejected) Daemon relaunches into a saved TTY

Have upgrade record the builder's controlling TTY (`/dev/pts/N`) and have the
restarted daemon re-spawn the builder attached to that TTY.

- **Rejected:** the daemon is a background service with no claim on the human's
  terminal; writing another process's `/dev/pts` is brittle and racy, breaks if
  the user's shell/terminal changed, and violates "principle of least surprise"
  (a background daemon seizing your terminal). It also fights the existing design
  where the **foreground CLI** owns the TTY. Not pursued.

---

## 3. Recommendation

**Adopt (a), the supervised relaunch loop**, scoped to docker/podman mode.

**Why over (b):** (b)'s headline appeal — "reuse `src/terminal/`" — does not hold
up: the tmux code is read-only observation infra, so (b) is *more* new code, adds
a tmux dependency, and **does not** actually preserve unsent input better given
our `--rm` single-shot container model. (a) reuses the existing resume path,
storage-based conversation capture, and the already-running in-memory binary
(which neatly sidesteps the "upgrade replaces the wrapper" problem). (a) keeps the
foreground-CLI-owns-the-TTY model lazy already has, satisfying "principle of least
surprise."

### Coordination channel: Storage vs the event plane (`src/daemon/events.ts`)

The engineer asked the right question: why a new Storage-backed "resume intent"
rather than lazy's existing internal event plane? The answer is that they solve
*different* halves of the problem, and the design should use **both** — Storage
for the durable cross-gap intent, the event plane for the live pre-stop signal.
Grounding this in the event plane's own code:

**Why the event plane alone cannot carry the resume intent.** The event plane is
explicitly **transient and fire-and-forget**: "Events are NOT stored... if no
connection exists, the event is dropped" (`events.ts:4-9`). Delivery is an
in-memory routing table keyed by task — `connections: Map<taskId, SSEConnection>`
(`events.ts:48-49`), and `sendEvent` returns `false` and bails the instant there
is no connection (`events.ts:129-131`). The resume handshake must bridge a window
where **all three** of the event plane's preconditions fail at once:

1. **The consumer is dead at signal time.** The resume intent only matters
   *after* the builder container is stopped (`upgrade.ts:308-317`). A stopped
   container has no SSE connection, so an event fired then is dropped on the
   floor.
2. **The daemon restarts mid-handshake.** `lazy upgrade` restarts the daemon
   (`upgrade.ts:340-349`), and `stopAllConnections` clears the entire in-memory
   `connections` map on shutdown (`events.ts:422-435`). Any in-flight routing
   state is wiped exactly during the gap the intent must survive.
3. **Builders aren't on the routing table at all.** The SSE client is
   **task-scoped** — supervisors connect with `/events/stream?task_id=<id>`
   (`src/supervisor/event-client.ts:145-149`), and routing is by `taskId`
   throughout `events.ts`. Builders have **no task in storage** (verified in §1.5),
   so the builder supervisor (`src/supervisor/builder.ts`) never starts an event
   client and has no address on the plane.

So the intent must be **durable**, and that is consistent with the event plane's
own stated design — it is not a competing mechanism but a *delivery layer on top
of* Storage: "Catchup on reconnect: derive current state from storage, push
signals" (`events.ts:10`), implemented by `sendCatchupEvents` which rebuilds
signals purely from `storage.getTask(...)` and git state, explicitly "NOT event
replay" (`events.ts:294-324`). **Storage is the source of truth; the event plane
is live delivery on top of it.** A resume intent that must survive the consumer
dying *and* a daemon restart belongs in the source-of-truth layer, full stop.

**Where the event plane genuinely fits: the live pre-stop warning (S3).** The one
part of this design that *is* a transient signal to a *connected* participant is
the "upgrade imminent — finish your unsent message" warning, fired **while the
builder is still alive**, before the stop. That is precisely the event plane's job,
and it is the best available mitigation for the S3 unsent-input loss (§2-S3): the
durable intent cannot help with unsent input because by the time it is read the
buffer is already gone; only a signal delivered *before* the kill can.

Making a live builder an event-plane subscriber, minimally:
- **Addressing.** Builders have no `taskId`, so reuse the existing per-builder
  identifier `lazy-builder-<builderId>` (the container name / label,
  `docker-runner.ts:466,470`) as a **synthetic channel id**. The routing table is
  just `Map<string, SSEConnection>` (`events.ts:49`) — it does not care whether
  the key is a real task id, so a `builder:<builderId>` key needs no schema
  change, only a convention and a non-task registration path.
- **Subscription.** The builder supervisor (`src/supervisor/builder.ts`) would
  start an SSE client like the task supervisor's (`src/supervisor/event-client.ts`)
  but keyed by its synthetic id, connecting to the daemon it already proxies tool
  calls through (`builder.ts:323-336`).
- **Sequence (hybrid):**
  1. `lazy upgrade` enumerates live builders (`discoverProjectBuilderContainers`).
  2. For each, it emits a transient `upgrade.imminent` event to
     `builder:<builderId>` via the event plane.
  3. The live builder surfaces the warning, lets the human finish typing / submit,
     and acknowledges (e.g. an RPC back to the daemon, or a bounded timeout if the
     builder is mid-turn and can't be interrupted).
  4. *Only then* does upgrade write the **durable resume intent** to Storage and
     stop the container (existing stop code).
  5. Post-restart, the host wrapper reads the durable intent and re-execs
     `--resume` (the (a) loop).

**Is the live-signal half worth it for v0.17?** Honestly, **no — defer it.** It
requires a new event type (`upgrade.imminent`), a non-task SSE registration path,
a builder-side event client, and an ack protocol — meaningful surface for a
*mitigation* of a *corner* (input typed in the exact pre-stop window). For v0.17,
the durable-intent half (Storage) delivers the actual headline win (same
conversation, same terminal, no manual `--resume`), and the unsent-input risk is
covered adequately by a **synchronous pre-stop prompt in the `lazy upgrade`
process itself** ("N builder(s) will be restarted — make sure you've submitted
any in-progress message, then press Enter"). That prompt runs in the upgrade CLI,
needs no event plane, and honors "never lose human feedback" for the common case.
Promote the event-plane `upgrade.imminent` path to a **follow-up** once the
durable resume loop is proven — at which point it upgrades the warning from
"prompt the human running `upgrade`" to "warn inside the live builder pane," which
is strictly better but not load-bearing for the core feature.

The split, stated plainly: **Storage carries the durable resume intent (survives
the dead consumer + daemon restart); the event plane is the right home for the
live pre-stop warning, deferred to a follow-up.** We are not defaulting to
storage-only out of habit — the event plane structurally cannot carry the intent,
and it is the *better* carrier for the one transient signal in the design.

### Implementation surface

**New state / signal (the upgrade↔builder handshake):**
- Add a **builder-resume intent** record owned by Storage (per "Storage is
  abstracted — never bypass it"): `{ builderId, projectRoot, sessionId?,
  createdAt }`. `lazy upgrade` writes one per builder it is about to stop
  (`upgrade.ts:308-317`); the wrapper consumes+clears it after a successful
  relaunch. New Storage interface methods (e.g. `saveBuilderResumeIntent`,
  `takeBuilderResumeIntent`, `listBuilderResumeIntents`) added to
  `src/storage/interface.ts` first, then FileStorage.
- **SessionId resolution (S1):** after the child exits, the wrapper resolves the
  sessionId via `storage.listConversations()` (newest builder conversation for
  this project) — or, more robustly, have the in-container supervisor stamp the
  sessionId into the resume-intent record/data-dir file before exit
  (`src/supervisor/builder.ts:119-124` already knows it).

**Files that change:**
- `src/cli/commands/builder.ts` — wrap the single `launchBuilderInteractive`
  call (`builder.ts:321-353`) in a relaunch loop: launch → on exit, check for a
  matching resume intent → if present, wait for upgrade completion (daemon
  healthy via `checkDaemonHealth`, image rebuilt), resolve sessionId, set
  `resumeId`, loop; else print footer and exit as today.
- `src/cli/commands/upgrade.ts` — before stopping each builder
  (`upgrade.ts:308-317`), **(1)** print a **synchronous pre-stop prompt in the
  upgrade process itself** if any builder is live ("N builder(s) will be
  restarted; make sure any in-progress message is submitted, then press Enter")
  honoring "never lose human feedback" — no event plane needed for v0.17, and
  **(2)** write the resume-intent record. Honor `--force`/non-TTY (skip the
  prompt). Add an opt-out flag if needed.
- `src/storage/interface.ts` + `src/storage/file-storage.ts` (and the other
  Storage backends) — the intent CRUD.
- Possibly `src/supervisor/builder.ts` — stamp sessionId into the intent on
  exit.

**Handshake shape:**
1. Human runs `lazy upgrade`. Upgrade discovers this project's builders
   (`discoverProjectBuilderContainers`), **synchronously prompts the human in the
   upgrade process** to submit any in-progress message (v0.17 mitigation for S3;
   the event-plane `upgrade.imminent` warning into the live builder pane is a
   follow-up), writes a resume-intent per builder to Storage, then stops them
   (existing code).
2. Each stopped `docker run` unblocks the corresponding host `lazy builder`
   wrapper at `await proc.exited`.
3. Wrapper sees a matching intent → enters "awaiting upgrade" state, polls until
   the daemon is healthy and the new image exists (bounded timeout), resolves
   sessionId, re-execs the launch with `--resume <id>`, then clears the intent.
4. If no intent (normal quit/crash) → today's behavior (print footer, exit).
5. If the wait times out or rebuild failed → surface an actionable error and
   fall back to printing `lazy builder --resume <id>` so nothing is silently
   lost.

### Rough task breakdown for v0.17

1. **Storage: builder-resume-intent entity** — interface + FileStorage + tests
   (invariant test: intent is created on upgrade-stop, cleared on successful
   relaunch).
2. **Upgrade: write durable intent + synchronous pre-stop prompt** in the upgrade
   process for live builders; honor `--force`/non-TTY paths (skip prompt).
3. **Builder: relaunch loop** — consume intent, wait-for-healthy, resolve
   sessionId from storage, re-exec with `--resume`. e2e test with mocked claude +
   simulated upgrade marker.
4. **SessionId stamping** in the supervisor (robustness over storage-query).
5. **Docs + UX copy** — update `upgrade` and `builder` help text (today's
   "Builder containers will restart on next use", `upgrade.ts:248,371`, becomes
   "running builders auto-resume in place").
6. **(Follow-up, not v0.17) Event-plane `upgrade.imminent`** — add the event
   type, a non-task `builder:<id>` SSE registration path, a builder-side event
   client (mirroring `src/supervisor/event-client.ts`), and an ack protocol, so
   the pre-stop warning surfaces *inside the live builder pane* instead of in the
   `upgrade` process. Strictly better S3 mitigation; not load-bearing for the
   core resume loop.

### Architectural-invariant exceptions to flag for approval

- **Coordination between `lazy upgrade` and a live builder** is new
  cross-process signalling. The **durable resume intent must go through Storage**,
  not ad-hoc files in `.lazy/` (per "Storage is abstracted") and not the event
  plane — which structurally cannot carry it (dead consumer + daemon restart +
  no builder taskId; see §3 "Coordination channel"). The deferred live pre-stop
  warning is the part that belongs on the event plane. Calling this split out
  explicitly for human approval since it adds a new coordination channel.
- The relaunch loop means `lazy builder` no longer exits on the *first* child
  exit. This is a deliberate behavior change; it must remain **predictable** —
  loop **only** when an explicit intent exists, never on a bare exit, to honor
  "defaults are safe" and "clever ain't wise."

---

## 4. Scope honesty

- **Host-process mode is out of scope / a non-problem.** Upgrade does not stop
  host-process builders at all (`discoverProjectBuilderRuns` returns `[]`;
  image rebuild is skipped, `upgrade.ts:325-338`), so there is nothing to
  auto-resume — the running session simply keeps using old in-memory code until
  the human restarts it. We should *say this plainly* rather than pretend (a)
  covers it.
- **Unsent input cannot be recovered** by either approach in our `--rm`
  single-shot container model (§1.4, §2-S3). The only honest mitigation is a
  pre-stop warning. Claiming "zero data loss" would be false; the realistic
  promise is "same conversation, same terminal, no manual `--resume` — but finish
  typing your current message before upgrading."
- **Multiple concurrent builders in different terminals** are supported by the
  design (intents are keyed per `builderId`, and the env-var resume source is
  already terminal-scoped, `src/cli/commands/builder.ts:131-138`), but each
  wrapper only resumes **its own** builder. A builder started in terminal X
  cannot be reattached to terminal Y — that is inherent to "same terminal" and
  not a regression.
- **Exit-code-based upgrade detection is unreliable** and intentionally avoided
  (§2-S2); the design depends on an explicit Storage-backed intent. I did not
  verify the precise exit code `docker stop` yields through `--init`, so no
  approach should lean on it.
