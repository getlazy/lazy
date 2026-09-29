/**
 * The trail one builder start leaves in the daemon log.
 *
 * A Teams builder start crosses four processes (the Rails request, this
 * daemon, the builder container, Claude Code inside it) and until this existed
 * it left one line — its total duration — keyed by an id nobody searched for.
 * Every line here starts with the same `builder start` prefix and carries the
 * RUN id (the builder session row id, which is what the Teams URL
 * `builders/runs/<id>` shows) together with the builder id (which names the
 * container, `lazy-builder-<builderId>`), so a god-mode Logs search for either
 * finds the whole start: each phase with how long it took, and a failed phase
 * with its real cause.
 *
 * INFO for phases that finished, WARN for the one that failed, so the Logs
 * page's level filter can narrow a noisy log to the failures.
 */
import { logger } from '../utils/logger';
import type { BuilderStartEvent } from '../storage/types';

export class BuilderStartTrace {
  private readonly started = Date.now();
  private runId: string | null = null;
  private readonly events: BuilderStartEvent[] = [];
  /** The builder the run is currently on — the minted id until a row says otherwise. */
  private shownBuilderId: string;

  constructor(readonly builderId: string, readonly memberEmail: string | null) {
    this.shownBuilderId = builderId;
  }

  /**
   * Name the run, and the builder it is on right now: an EXISTING row names
   * its own builder (whose container is real); a launch claims the row for the
   * id this trace minted. Logged once per (run, builder) pair.
   */
  setRunId(runId: string, builderId: string = this.builderId): void {
    if (this.runId === runId && this.shownBuilderId === builderId) return;
    this.runId = runId;
    this.shownBuilderId = builderId;
    this.note(`run ${runId} is builder ${builderId} (container lazy-builder-${builderId})`);
  }

  /** True once the run row is on the builder THIS start launched (it claimed or created it). */
  ownsRun(): boolean {
    return this.runId !== null && this.shownBuilderId === this.builderId;
  }

  private prefix(): string {
    return `builder start [run ${this.runId ?? 'not yet created'}, builder ${this.shownBuilderId}]`;
  }
  /** A free-form line in this start's trail (image build progress, decisions). */
  note(message: string): void {
    this.push({ kind: 'note', step: message });
    logger.info(`${this.prefix()}: ${message} (+${Date.now() - this.started}ms)`);
  }

  /** Run one phase, logging how long it took or why it failed. */
  async phase<T>(name: string, work: () => Promise<T>): Promise<T> {
    const t0 = Date.now();
    try {
      const result = await work();
      this.push({ kind: 'step', step: name, ms: Date.now() - t0 });
      logger.info(`${this.prefix()}: ${name} took ${Date.now() - t0}ms (+${Date.now() - this.started}ms)`);
      return result;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.push({ kind: 'failed', step: name, ms: Date.now() - t0, detail });
      logger.warn(`${this.prefix()}: ${name} FAILED after ${Date.now() - t0}ms (+${Date.now() - this.started}ms): ${detail}`);
      throw err;
    }
  }

  /** Elapsed since the start began. */
  elapsedMs(): number {
    return Date.now() - this.started;
  }

  begin(): void {
    const who = this.memberEmail ?? 'the local operator';
    this.push({ kind: 'note', step: `start asked for by ${who}` });
    logger.info(`${this.prefix()}: started for ${who}`);
  }

  finish(outcome: string): void {
    this.push({ kind: 'done', step: outcome, ms: this.elapsedMs() });
    logger.info(`${this.prefix()}: ${outcome} after ${this.elapsedMs()}ms`);
  }

  fail(err: unknown): void {
    const detail = err instanceof Error ? err.message : String(err);
    this.push({ kind: 'failed', step: 'start', ms: this.elapsedMs(), detail });
    logger.warn(`${this.prefix()}: start FAILED after ${this.elapsedMs()}ms: ${detail}`);
  }

  /** The timeline so far — what {@link persist} writes onto the run's row. */
  timeline(): BuilderStartEvent[] {
    return [...this.events];
  }

  /**
   * Write the timeline onto the run's row, so the run's page shows where a
   * start got to and why it stopped without a log search. A no-op before the
   * run has a row. Never throws: losing the copy on the row costs a page, the
   * log still has every line.
   */
  async persist(write: (runId: string, timeline: BuilderStartEvent[]) => Promise<unknown>): Promise<void> {
    if (!this.runId) return;
    try {
      await write(this.runId, this.timeline());
    } catch (err) {
      logger.warn(`${this.prefix()}: could not record the start timeline on the run: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Add an event that happened outside a timed phase (the launch watch). */
  record(kind: BuilderStartEvent['kind'], step: string, detail?: string): void {
    this.push({ kind, step, ...(detail ? { detail } : {}) });
  }

  private push(event: Omit<BuilderStartEvent, 'at' | 'offsetMs'>): void {
    if (this.events.length >= MAX_TIMELINE_EVENTS) this.events.splice(1, 1);
    this.events.push({
      at: new Date().toISOString(),
      offsetMs: Date.now() - this.started,
      ...event,
      ...(event.detail ? { detail: event.detail.slice(0, MAX_DETAIL_CHARS) } : {}),
    });
  }
}

/** Bounds, so a run row stays small whatever a start does. */
export const MAX_TIMELINE_EVENTS = 60;
const MAX_DETAIL_CHARS = 2000;
