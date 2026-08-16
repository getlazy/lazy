/**
 * Phase progress — what a long daemon operation is doing, right now.
 *
 * WHY THIS EXISTS
 *
 * `lazy accept` can run for minutes: a pre-accept agent turn, remote pushes, an
 * LLM-synthesized merge description, the merge itself, then cleanup. Until this
 * module existed the caller saw NOTHING for that entire window — the CLI sat
 * silent and the MCP client got a bare "still running (Ns)" tick. A command that
 * is silent while working is indistinguishable from one that has hung, and
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

/** How a phase ended (or that it started). */
export type PhaseState = 'start' | 'done' | 'skipped' | 'failed';

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

export type ProgressEvent = ProgressPlanEvent | ProgressPhaseEvent;

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
  const position = event.total > 0 && event.index > 0 ? `[${event.index}/${event.total}] ` : '';
  const elapsed = event.elapsedMs !== undefined ? ` (${formatDuration(event.elapsedMs)})` : '';
  const detail = event.detail ? ` — ${event.detail}` : '';
  switch (event.state) {
    case 'start': return `${position}${event.label}…`;
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
  remoteState: { id: 'remote-state', label: 'Check remote merge state' },
  preAccept: { id: 'pre-accept', label: 'Pre-accept validation turn', optional: true },
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
 * is always skipped.
 */
export function acceptPhasePlan(preAcceptEnabled: boolean): PlannedPhase[] {
  const p = ACCEPT_PHASES;
  return [
    p.edgeGate,
    p.resurrection,
    p.lfs,
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
