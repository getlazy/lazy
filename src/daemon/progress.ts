/**
 * Phase progress — what a long daemon operation is doing, right now.
 *
 * WHY THIS EXISTS
 *
 * `lazy accept` can run for minutes: the mechanical acceptance gate, remote
 * pushes, an LLM-synthesized merge description, the merge itself, then cleanup.
 * Until this module existed the caller saw NOTHING for that entire window — the
 * CLI sat silent and the MCP client got a bare "still running (Ns)" tick. A
 * command that is silent while working is indistinguishable from one that has
 * hung, and
 * during the v0.20 release that ambiguity is what made accept feel unworkable.
 *
 * The transport already existed: {@link ./heartbeat} frames long replies as
 * newline-delimited JSON so the connection is never idle. This module adds a
 * THIRD line kind to that framing — `{"progress": <event>}` — carrying what
 * phase the daemon entered or left. Heartbeat lines additionally carry the
 * current phase label, so even the 5-second liveness ticks say what is running.
 *
 * INVARIANT (inherited from the heartbeat envelope): every event is written by
 * the daemon at the moment the phase actually changes. Nothing here is a
 * client-side simulation — if the daemon goes quiet, the display goes quiet with
 * it, which is the honest signal.
 */

/** A phase the operation plans to run, as announced up front. */
export interface PlannedPhase {
  /** Stable machine id (e.g. `pre-accept`). */
  id: string;
  /** Human label rendered in the CLI (e.g. `Pre-accept validation turn`). */
  label: string;
  /**
   * True when the phase only runs under some conditions (an opt-in step, a
   * remote-only step). Announced anyway — a phase that is listed and then
   * explicitly skipped is far clearer than one that silently never appears.
   */
  optional?: boolean;
}

/** First progress event: the ordered list of phases about to run. */
export interface ProgressPlanEvent {
  kind: 'plan';
  /** Operation name, e.g. `accept`. */
  operation: string;
  /** What is being operated on, e.g. a task display id. */
  target?: string;
  phases: PlannedPhase[];
}

/**
 * How a phase ended, that it started, or — for `progress` — that it is still
 * running and has something new to say.
 *
 * `progress` is the only NON-terminal state: it carries a fresh `detail` for the
 * phase already open without closing it. It exists because one phase can be the
 * entire wait: resolving the container image inside a turn launch can spend six
 * minutes in `docker build`, and a checklist row that says nothing for six
 * minutes is the silence this whole module was built to remove. The emitter
 * throttles; the renderer overwrites rather than appending on a TTY.
 */
export type PhaseState = 'start' | 'progress' | 'done' | 'skipped' | 'failed';

/** A phase transition. */
export interface ProgressPhaseEvent {
  kind: 'phase';
  id: string;
  label: string;
  state: PhaseState;
  /** 1-based position in the announced plan (0 when the phase was not planned). */
  index: number;
  /** Total planned phases. */
  total: number;
  /** Wall-clock spent in the phase — set on `done` / `skipped` / `failed`. */
  elapsedMs?: number;
  /** Extra context: what was skipped and why, what the phase actually did. */
  detail?: string;
}

/**
 * A live event from a long-lived subscription (today: proxy traffic, streamed
 * to `lazy watch`). Distinct from the phase events above because it narrates a
 * STREAM rather than the progress of the request that carries it — there is no
 * plan, no position, and no end state.
 *
 * `payload` is deliberately opaque here: this module is the transport, and
 * teaching it the shape of proxy audit data would couple the daemon's envelope
 * to the proxy. The subscriber validates the payload at its own boundary (see
 * `parseProxyActivityEvent` in src/proxy/activity.ts).
 */
export interface ProgressActivityEvent {
  kind: 'activity';
  /** Stream this event belongs to, e.g. `proxy`. */
  channel: string;
  payload: unknown;
}

export type ProgressEvent = ProgressPlanEvent | ProgressPhaseEvent | ProgressActivityEvent;

/**
 * Sink for progress events. Supplied by the transport (the heartbeat envelope
 * writes a `{"progress": …}` line) or, on the in-process fallback path, by the
 * CLI itself. Must never throw — see {@link PhaseReporter}.
 */
export type ProgressEmitter = (event: ProgressEvent) => void;

/** Render an event as one plain-text line (used by MCP progress + non-TTY CLI). */
export function describeProgress(event: ProgressEvent): string {
  if (event.kind === 'plan') {
    const target = event.target ? ` ${event.target}` : '';
    return `${event.operation}${target}: ${event.phases.length} phases`;
  }
  if (event.kind === 'activity') {
    // Generic by design — a caller that wants a rendered activity line renders
    // the payload itself; this is the fallback for surfaces that only know how
    // to print a progress event.
    return `${event.channel} activity`;
  }
  const position = event.total > 0 && event.index > 0 ? `[${event.index}/${event.total}] ` : '';
  const elapsed = event.elapsedMs !== undefined ? ` (${formatDuration(event.elapsedMs)})` : '';
  const detail = event.detail ? ` — ${event.detail}` : '';
  switch (event.state) {
    case 'start': return `${position}${event.label}…`;
    case 'progress': return `${position}${event.label}…${detail}`;
    case 'done': return `${position}${event.label} — done${elapsed}${detail}`;
    case 'skipped': return `${position}${event.label} — skipped${detail}`;
    case 'failed': return `${position}${event.label} — FAILED${elapsed}${detail}`;
  }
}

/** `1.4s`, `2m05s` — compact, human, and stable enough to assert on in tests. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${minutes}m${String(seconds).padStart(2, '0')}s`;
}

/**
 * Drives one operation's phases and emits the events.
 *
 * Owns the timing (so no caller has to remember to stamp a start time) and the
 * plan positions (so `[3/9]` is always consistent with the announced list).
 *
 * NOTHING here may throw into the operation it reports on. A progress write
 * fails when the client hung up, and losing the narration of a merge must never
 * fail the merge — every emit is wrapped.
 */
export class PhaseReporter {
  private plan: PlannedPhase[] = [];
  private current: { id: string; label: string; index: number; startedAt: number } | null = null;

  constructor(
    private readonly emit: ProgressEmitter | undefined,
    private readonly operation: string,
    /** Injectable clock — tests assert on elapsed values. */
    private readonly now: () => number = Date.now,
  ) {}

  /** True when nobody is listening; lets callers skip building detail strings. */
  get inactive(): boolean {
    return this.emit === undefined;
  }

  /** Announce the ordered phase list. Replaces any previous plan. */
  announce(phases: PlannedPhase[], target?: string): void {
    this.plan = phases;
    this.current = null;
    this.send({ kind: 'plan', operation: this.operation, target, phases });
  }

  /** Label of the phase currently running, for heartbeat annotation. */
  currentLabel(): string | undefined {
    return this.current?.label;
  }

  /**
   * Enter a phase. Automatically closes any still-open phase as `done` — the
   * common case is a linear walk, and forgetting an explicit `end()` should not
   * silently leave a phase looking like it never finished.
   *
   * A phase not present in the announced plan still reports (with index 0, so it
   * renders without an `[n/m]` position) — that is how the pre-flight prelude,
   * which runs BEFORE the plan can be known, gets narrated.
   */
  begin(phase: PlannedPhase, detail?: string): void {
    if (this.current) this.end();
    const index = this.plan.findIndex(p => p.id === phase.id);
    this.current = { id: phase.id, label: phase.label, index: index + 1, startedAt: this.now() };
    this.send({
      kind: 'phase', id: phase.id, label: phase.label, state: 'start',
      index: index + 1, total: this.plan.length, detail,
    });
  }

  /**
   * Say something new about the phase that is already running, WITHOUT closing
   * it. No-op when no phase is open — a note is always about a phase, never a
   * phase of its own.
   *
   * This is how a single checklist row narrates a long interior: `Launch agent`
   * stays open while its notes walk through resolving the image, why a rebuild
   * is needed, the docker build's own output, and the container start. Callers
   * that stream (docker build lines) must throttle — see {@link throttleNotes}.
   */
  note(detail: string): void {
    const open = this.current;
    if (!open) return;
    this.send({
      kind: 'phase', id: open.id, label: open.label, state: 'progress',
      index: open.index, total: this.plan.length,
      elapsedMs: this.now() - open.startedAt, detail,
    });
  }

  /**
   * {@link note} as a standalone sink, for handing to code that may narrate but
   * must not be able to open, close or fail a phase (the runner, the image
   * builder). Bound, so it survives being passed around.
   */
  get notify(): PhaseNotify {
    return (detail: string) => this.note(detail);
  }

  /** Close the running phase successfully. No-op when none is open. */
  end(detail?: string): void {
    this.settle('done', detail);
  }

  /** Close the running phase as failed (the operation is aborting). */
  fail(detail?: string): void {
    this.settle('failed', detail);
  }

  /** Record a planned phase that did not run, and why. */
  skip(phase: PlannedPhase, detail: string): void {
    if (this.current?.id === phase.id) {
      this.settle('skipped', detail);
      return;
    }
    const index = this.plan.findIndex(p => p.id === phase.id);
    this.send({
      kind: 'phase', id: phase.id, label: phase.label, state: 'skipped',
      index: index + 1, total: this.plan.length, detail,
    });
  }

  private settle(state: PhaseState, detail?: string): void {
    const open = this.current;
    if (!open) return;
    this.current = null;
    this.send({
      kind: 'phase', id: open.id, label: open.label, state,
      index: open.index, total: this.plan.length,
      elapsedMs: this.now() - open.startedAt, detail,
    });
  }

  private send(event: ProgressEvent): void {
    if (!this.emit) return;
    try {
      this.emit(event);
    } catch {
      // The listener is gone (client hung up, stream closed). Narration is
      // strictly observational — swallow so the operation itself is untouched.
      // Deliberately silent: logging here would fire once per phase for every
      // disconnected client and tell an operator nothing they can act on.
    }
  }
}

/**
 * A sink for phase notes — the narrow slice of {@link PhaseReporter} handed to
 * code that only narrates and must not be able to open, close or fail a phase.
 *
 * Deliberately a bare function rather than the reporter: the launch path
 * reaches deep into the runner and the image builder, and none of that code has
 * any business deciding the shape of the caller's checklist.
 */
export type PhaseNotify = (detail: string) => void;

/** Minimum gap between streamed notes, so a chatty source cannot flood the wire. */
export const NOTE_THROTTLE_MS = 400;

/**
 * Rate-limit a note sink.
 *
 * `docker build` emits a line per layer step and can produce hundreds in a
 * second. On a TTY that is invisible (each note overwrites the last) but every
 * one is still a JSON line on the wire and, on a non-TTY, a printed row. The
 * throttle drops intermediate notes rather than queuing them: a stale build line
 * has no value once a newer one exists.
 *
 * `force` bypasses the gate for notes that must not be dropped (a phase's first
 * or last word about itself).
 */
export function throttleNotes(
  notify: PhaseNotify | undefined,
  intervalMs: number = NOTE_THROTTLE_MS,
  now: () => number = Date.now,
): (detail: string, force?: boolean) => void {
  // -Infinity, not 0: the FIRST note must always get through, and a clock that
  // starts near zero (a test clock, or a mocked Date.now) would otherwise put it
  // inside the interval and swallow the only line a short build ever prints.
  let last = -Infinity;
  return (detail: string, force = false) => {
    if (!notify) return;
    const at = now();
    if (!force && at - last < intervalMs) return;
    last = at;
    notify(detail);
  };
}

// ---------------------------------------------------------------------------
// Accept phase catalogue
// ---------------------------------------------------------------------------

/**
 * Every phase `acceptTask` can run, in execution order.
 *
 * Kept as one exported table (rather than string literals sprinkled through
 * task-lifecycle.ts) so the announced plan and the emitted events can never
 * drift, and so a test can assert the plan covers the code path.
 */
export const ACCEPT_PHASES = {
  preflight: { id: 'preflight', label: 'Pre-flight validation' },
  edgeGate: { id: 'edge-gate', label: 'Branch-protection gate' },
  resurrection: { id: 'resurrection', label: 'Deleted-file resurrection check' },
  lfs: { id: 'lfs', label: 'Git LFS pointer check' },
  acceptCheck: { id: 'accept-check', label: 'Accept check (does the task build?)', optional: true },
  remoteState: { id: 'remote-state', label: 'Check remote merge state' },
  preAccept: { id: 'pre-accept', label: 'Acceptance gate', optional: true },
  protection: { id: 'protection', label: 'Target-branch protection check', optional: true },
  remoteRef: { id: 'remote-ref', label: 'Push branch and open PR/MR', optional: true },
  mergeGates: { id: 'merge-gates', label: 'Pre-merge gates (CI, reviews)' },
  pushParent: { id: 'push-parent', label: 'Push parent branch', optional: true },
  description: { id: 'description', label: 'Generate merge description' },
  merge: { id: 'merge', label: 'Merge' },
  finalize: { id: 'finalize', label: 'Fast-forward and finalize' },
  cleanup: { id: 'cleanup', label: 'Clean up worktree and children' },
} as const satisfies Record<string, PlannedPhase>;

/**
 * The phase plan for a fresh accept.
 *
 * Pre-flight is NOT in the plan: it runs first and is what tells us which plan
 * applies (a task already in `merging` takes the re-entry path). It is narrated
 * as an unplanned prelude so the caller still sees it, and the plan is announced
 * the moment it is actually known — announcing a guess and revising it would be
 * worse than announcing a beat later.
 *
 * `preAcceptEnabled` is reflected in the list rather than shown as a phase that
 * is always skipped. The id keeps the historical `pre-accept` spelling — the
 * gate's config family is still `[automation.pre_accept]` — while the label
 * says what the phase is now: the MECHANICAL acceptance gate, no agent turn.
 */
export function acceptPhasePlan(preAcceptEnabled: boolean): PlannedPhase[] {
  const p = ACCEPT_PHASES;
  return [
    p.edgeGate,
    p.resurrection,
    p.lfs,
    p.acceptCheck,
    ...(preAcceptEnabled ? [p.preAccept] : []),
    p.protection,
    p.remoteRef,
    p.mergeGates,
    p.pushParent,
    p.description,
    p.merge,
    p.finalize,
    p.cleanup,
  ];
}

/**
 * The phase plan when re-entering an accept for a task already in `merging`
 * because a REMOTE merge is pending. Nothing local is re-run — the daemon asks
 * the forge what happened and finishes up.
 */
export function acceptReentryPhasePlan(): PlannedPhase[] {
  const p = ACCEPT_PHASES;
  return [p.remoteState, p.finalize, p.cleanup];
}

// ---------------------------------------------------------------------------
// Start phase catalogue
// ---------------------------------------------------------------------------

/** Every phase `launchTask` can run, in execution order. */
export const START_PHASES = {
  preflight: { id: 'preflight', label: 'Pre-flight validation' },
  resolveBase: { id: 'resolve-base', label: 'Resolve integration base' },
  lfs: { id: 'lfs', label: 'Git LFS pointer check', optional: true },
  worktree: { id: 'worktree', label: 'Create worktree' },
  // The forge fetch behind the supervisor's upstream-merge ref. Its own row
  // because it retries with backoff and runs before the task goes `working`.
  upstreamRef: { id: 'upstream-ref', label: 'Resolve upstream merge ref' },
  publish: { id: 'publish', label: 'Publish branch', optional: true },
  launch: { id: 'launch', label: 'Launch agent' },
} as const satisfies Record<string, PlannedPhase>;

/** Phase plan for a fresh start. Pre-flight is narrated as an unplanned prelude. */
export function startPhasePlan(lfsCheckEnabled: boolean, publishesBranch: boolean): PlannedPhase[] {
  const p = START_PHASES;
  return [
    p.resolveBase,
    ...(lfsCheckEnabled ? [p.lfs] : []),
    p.worktree,
    p.upstreamRef,
    ...(publishesBranch ? [p.publish] : []),
    p.launch,
  ];
}

// ---------------------------------------------------------------------------
// Unblock phase catalogue
// ---------------------------------------------------------------------------

/** Every phase `launchUnblockTask` can run, in execution order. */
export const UNBLOCK_PHASES = {
  preflight: { id: 'preflight', label: 'Pre-flight validation' },
  prepare: { id: 'prepare', label: 'Prepare worktree' },
  // Labelled as unblock feedback so a reviewer who just ran `lazy review`
  // does not read this phase as "recording the reviewer's turn" — it is the
  // human's unblock message being persisted before the agent relaunches.
  feedback: { id: 'feedback', label: 'Save unblock feedback' },
  launch: { id: 'launch', label: 'Launch agent' },
} as const satisfies Record<string, PlannedPhase>;

/** Phase plan for an unblock. Pre-flight is narrated as an unplanned prelude. */
export function unblockPhasePlan(): PlannedPhase[] {
  const p = UNBLOCK_PHASES;
  return [
    p.prepare,
    p.feedback,
    p.launch,
  ];
}

// ---------------------------------------------------------------------------
// Sync phase catalogue
// ---------------------------------------------------------------------------

/**
 * Every phase `syncTask` can run, in execution order.
 *
 * `upstream` is the fetch: on a cold remote it is slow, and it was the first
 * half of the six-minute silence that produced this catalogue (the second half
 * was the image build, which narrates as notes on `launch`).
 */
export const SYNC_PHASES = {
  preflight: { id: 'preflight', label: 'Pre-flight validation' },
  // A sync reconciles the task's OWN branch with origin before it merges the
  // parent, so the origin check gets its own named row: "skipped — driver is
  // local" and "origin/lazy/x has 2 new commits" are different outcomes and the
  // reader must be able to tell which one happened.
  origin: { id: 'origin', label: 'Check task branch on origin', optional: true },
  upstream: { id: 'upstream', label: 'Fetch and resolve upstream' },
  compare: { id: 'compare', label: 'Compare with upstream' },
  prepare: { id: 'prepare', label: 'Prepare worktree', optional: true },
  launch: { id: 'launch', label: 'Launch agent to merge', optional: true },
} as const satisfies Record<string, PlannedPhase>;

/**
 * Phase plan for a sync. Pre-flight is narrated as an unplanned prelude.
 *
 * `prepare` and `launch` are optional because an already up-to-date task stops
 * after `compare` — announced anyway, so "nothing to merge" reads as a decision
 * the daemon made rather than as steps that mysteriously never appeared.
 */
export function syncPhasePlan(): PlannedPhase[] {
  const p = SYNC_PHASES;
  return [p.origin, p.upstream, p.compare, p.prepare, p.launch];
}

// ---------------------------------------------------------------------------
// Reparent phase catalogue
// ---------------------------------------------------------------------------

/** Repointing a task at a new parent, then the sync that merges it in. */
export const REPARENT_PHASES = {
  preflight: { id: 'preflight', label: 'Pre-flight validation' },
  repoint: { id: 'repoint', label: 'Repoint task to new parent' },
} as const satisfies Record<string, PlannedPhase>;

/**
 * Phase plan for a reparent: the repoint, then sync's own phases inline.
 *
 * Reparent delegates the merge to `syncTask` and hands it this same reporter, so
 * one plan covers the whole operation — a second `plan` event mid-flight would
 * make the display restart its checklist for what the user asked for as one
 * command.
 */
export function reparentPhasePlan(): PlannedPhase[] {
  return [REPARENT_PHASES.repoint, ...syncPhasePlan()];
}

// ---------------------------------------------------------------------------
// Ask / resume phase catalogues
// ---------------------------------------------------------------------------

/** Every phase `launchAskTask` can run, in execution order. */
export const ASK_PHASES = {
  preflight: { id: 'preflight', label: 'Pre-flight validation' },
  prepare: { id: 'prepare', label: 'Prepare worktree' },
  launch: { id: 'launch', label: 'Launch agent' },
  answer: { id: 'answer', label: 'Wait for the agent’s answer' },
  read_record: { id: 'read_record', label: 'Read the task’s stored record' },
} as const satisfies Record<string, PlannedPhase>;

/**
 * Phase plan for an ask.
 *
 * Two plans, because an ask has two routes: resuming the live agent, or reading
 * the stored record when there is no live session left to resume. Announcing
 * the worktree/launch checklist for a record ask would narrate three steps that
 * never run.
 */
export function askPhasePlan(route: 'live' | 'record' = 'live'): PlannedPhase[] {
  const p = ASK_PHASES;
  // The live plan STOPS at launch: `launchAskTask` returns once the agent is
  // running. Waiting for the answer is a separate call with its own plan
  // (`claimedTurnWaitPhasePlan`) — narrating "wait for the answer" as part of
  // the start would leave a checklist item hanging the moment it returned.
  return route === 'record' ? [p.read_record] : [p.prepare, p.launch];
}

/** Every phase `launchReviewTask` can run, in execution order. */
export const REVIEW_PHASES = {
  preflight: { id: 'preflight', label: 'Pre-flight validation' },
  prepare: { id: 'prepare', label: 'Prepare worktree' },
  launch: { id: 'launch', label: 'Launch reviewer' },
  answer: { id: 'answer', label: 'Wait for the review' },
} as const satisfies Record<string, PlannedPhase>;

/**
 * Phase plan for STARTING a review. Pre-flight is narrated as an unplanned
 * prelude, and `answer` belongs to the wait — see {@link askPhasePlan}.
 *
 * There is no posting phase: a review lands on the task and is never written
 * to a PR/MR (engineer decision, 2026-09-21). The `post` phase this used to
 * carry ("Post findings to the PR") narrated a step that no longer exists.
 */
export function reviewPhasePlan(): PlannedPhase[] {
  const p = REVIEW_PHASES;
  return [p.prepare, p.launch];
}

/**
 * Phase plan for WAITING on a claimed ask/review turn.
 *
 * One step, and deliberately no deadline in its label: the wait has no ceiling,
 * so a narration promising one would be a lie a reviewer eventually catches.
 */
export function claimedTurnWaitPhasePlan(): PlannedPhase[] {
  return [ASK_PHASES.answer];
}

/** Every phase `resumeTask` can run, in execution order. */
export const RESUME_PHASES = {
  preflight: { id: 'preflight', label: 'Pre-flight validation' },
  prepare: { id: 'prepare', label: 'Prepare worktree' },
  launch: { id: 'launch', label: 'Launch agent' },
} as const satisfies Record<string, PlannedPhase>;

/** Phase plan for a resume. Pre-flight is narrated as an unplanned prelude. */
export function resumePhasePlan(): PlannedPhase[] {
  const p = RESUME_PHASES;
  return [p.prepare, p.launch];
}

// ---------------------------------------------------------------------------
// Close / reject phase catalogue
// ---------------------------------------------------------------------------

/** Phases shared by close and reject — terminal cleanup operations. */
export const TERMINATE_PHASES = {
  preflight: { id: 'preflight', label: 'Pre-flight validation' },
  stop: { id: 'stop', label: 'Stop running agent', optional: true },
  finalize: { id: 'finalize', label: 'Update task status' },
  remote: { id: 'remote', label: 'Close remote PR/MR', optional: true },
  cleanup: { id: 'cleanup', label: 'Clean up worktree', optional: true },
} as const satisfies Record<string, PlannedPhase>;

export function closePhasePlan(wasWorking: boolean, hasSession: boolean): PlannedPhase[] {
  const p = TERMINATE_PHASES;
  return [
    ...(wasWorking ? [p.stop] : []),
    p.finalize,
    ...(hasSession ? [p.cleanup] : []),
  ];
}

export function rejectPhasePlan(wasWorking: boolean): PlannedPhase[] {
  const p = TERMINATE_PHASES;
  return [
    ...(wasWorking ? [p.stop] : []),
    p.finalize,
    p.remote,
    p.cleanup,
  ];
}

/** Phases `stopTask` runs — halt a working agent without auto-resume. */
export const STOP_PHASES = {
  preflight: { id: 'preflight', label: 'Pre-flight validation' },
  record: { id: 'record', label: 'Record stop intent' },
  halt: { id: 'halt', label: 'Halt running agent' },
  finalize: { id: 'finalize', label: 'Update task status' },
} as const satisfies Record<string, PlannedPhase>;

/** Phase plan for a stop. Pre-flight is narrated as an unplanned prelude. */
export function stopPhasePlan(): PlannedPhase[] {
  const p = STOP_PHASES;
  return [p.record, p.halt, p.finalize];
}

// ---------------------------------------------------------------------------
// Link phase catalogue
// ---------------------------------------------------------------------------

/** Every phase `linkTask` can run, in execution order. */
export const LINK_PHASES = {
  preflight: { id: 'preflight', label: 'Pre-flight validation' },
  resolve: { id: 'resolve', label: 'Resolve branch or pull request' },
  fetch: { id: 'fetch', label: 'Fetch branch' },
  worktree: { id: 'worktree', label: 'Create worktree' },
  create: { id: 'create', label: 'Create task' },
  describe: { id: 'describe', label: 'Describe the task from its branch and PR' },
} as const satisfies Record<string, PlannedPhase>;

/** Phase plan for a link. Pre-flight is narrated as an unplanned prelude. */
export function linkPhasePlan(): PlannedPhase[] {
  const p = LINK_PHASES;
  return [p.resolve, p.fetch, p.worktree, p.create, p.describe];
}
