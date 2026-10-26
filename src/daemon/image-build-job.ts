/**
 * One run of the daemon's own image work — the project image's boot build (or
 * a Rebuild), or an adoption's export + verify + build — as something a
 * project admin can WATCH and STOP.
 *
 * A job holds:
 *   - a bounded LOG: every line docker printed plus lazy's own narration, each
 *     with a sequence number, so a reader streams it with "everything after
 *     seq N" (`read`, `waitForLines`);
 *   - its STEPS, with per-step timing: lazy's own (an adoption's export and
 *     verify) and docker's, parsed from BuildKit's plain progress
 *     (`#5 [2/7] RUN …`, `#5 DONE 12.3s`, `#6 CACHED`, `#7 ERROR …`) or the
 *     classic builder's `Step 2/7 : RUN …`;
 *   - its OUTCOME, and for a failure the failing step and that step's output;
 *   - an AbortController: Cancel aborts it, which kills the docker client of
 *     every build started inside the job (src/capture/build-observer.ts), and
 *     an in-flight `git archive` export. BuildKit stops the build itself when
 *     its client goes away; layers already built stay in its cache.
 *
 * Live tails are bounded in memory. The daemon archives complete redacted logs
 * through Storage for the newest 20 builds, retaining older summaries. Teams
 * copies that archive into its database independently of page visits.
 *
 * Nothing here decides what an admin may see: every answer leaves the daemon
 * through `redactAnswer` (./observability-redaction.ts). Lines are also scrubbed
 * as they arrive, so memory holds as few secrets as possible.
 */
import type { StoredImageBuild } from '../storage/image-build';
import type { Storage } from '../storage/interface';
import { randomBytes } from 'crypto';
import { runWithBuildObserver, type BuildObserver } from '../capture/build-observer';
import { redactSecretValues } from '../utils/redact';
import { logger } from '../utils/logger';
import { redactDeep, type Redactor } from './observability-redaction';

export type ImageBuildJobKind = 'project' | 'adoption';
export type ImageBuildOutcome = 'running' | 'succeeded' | 'failed' | 'cancelled';
export type BuildStepStatus = 'pending' | 'running' | 'done' | 'cached' | 'failed' | 'cancelled';

export interface BuildStep {
  /** Stable within the job: `export`, `verify`, or `docker:<image>:#<vertex>` / `docker:<image>:step<n>`. */
  id: string;
  /** `lazy` for lazy's own steps (export, verify), `docker` for a Dockerfile step. */
  kind: 'lazy' | 'docker';
  label: string;
  /** The image a docker step belongs to — lazy's base image may be built first. */
  image: string | null;
  status: BuildStepStatus;
  startedAt: string | null;
  finishedAt: string | null;
  /** BuildKit's own timing when it printed one (`DONE 12.3s`), else wall clock. */
  durationMs: number | null;
}

export interface BuildLogLine {
  seq: number;
  at: string;
  /** `lazy` narration or `docker` output. */
  source: 'lazy' | 'docker';
  /** The image whose build printed it (docker lines). */
  image: string | null;
  text: string;
}

export interface BuildFailure {
  /** The step that failed, when one can be named. */
  stepId: string | null;
  stepLabel: string | null;
  /** That step's own output (last lines), or the error's own detail. */
  output: string;
  /** The whole error as lazy reports it. */
  error: string;
}

/** Bounds per job — oldest lines are dropped first, and `firstSeq` says so. */
const MAX_LINES = 5000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_LINE_CHARS = 4000;
/** Lines of the failing step quoted in `failure.output`. */
const FAILURE_OUTPUT_LINES = 40;
/** Finished jobs kept for reading, per daemon. */
const MAX_JOBS = 10;

interface Segment {
  /** Per stage (`''` for an unnamed one), the largest `m` of `[n/m]` seen. */
  stageTotals: Map<string, number>;
  /** BuildKit vertex → step index. */
  vertices: Map<string, number>;
  /** The classic builder's running step index. */
  classicRunning: number | null;
  /** First log seq of the current attempt — a retried build starts a new one. */
  startSeq: number;
  /** 1 for the first attempt; a retry's step ids carry `@<attempt>`. */
  attempt: number;
}

const STEP_HEADER = /^#(\d+) \[([^\]]+)\]\s*(.*)$/;
const STEP_INDEX = /^(?:(\S+) )?(\d+)\/(\d+)$/;
const STEP_DONE = /^#(\d+) DONE(?: (\d+(?:\.\d+)?)s)?\s*$/;
const STEP_CACHED = /^#(\d+) CACHED\s*$/;
const STEP_ERROR = /^#(\d+) ERROR\b/;
const STEP_CANCELED = /^#(\d+) CANCELED\b/;
const CLASSIC_STEP = /^Step (\d+)\/(\d+) : (.*)$/;

let jobCounter = 0;
const jobs: ImageBuildJob[] = [];

export class ImageBuildJob {
  readonly id: string;
  metadata: { trigger?: string; commit?: string; dockerfile?: string; image?: string; requestedBy?: string; imageProduced?: boolean } = {};
  private archive: (() => Promise<Storage | null>) | null = null;
  private writes: Promise<void> = Promise.resolve();
  private archiveError: unknown = null;
  private pendingLines: BuildLogLine[] = [];
  private writing = false;

  /** Every line is archived before the bounded live tail discards it. */
  enableArchive(projectRoot: string, openArchive?: () => Promise<{ storage: Storage | null; redactor: Redactor }>): void {
    this.archive = async () => {
      const { storage, redactor } = await (openArchive ? openArchive() : Promise.all([
        import('./rpc-handlers').then(m => m.getDaemonProjectRoot() === projectRoot ? m.getOrCreateStorage() : null),
        import('./observability-redaction').then(m => m.daemonRedactor(projectRoot)),
      ]).then(([storage, redactor]) => ({ storage, redactor })));
      if (!redactor.complete) throw new Error('Secret redactor is unavailable; refusing to archive unredacted image logs.');
      this.redactor = redactor;
      return storage;
    };
    this.persist();
  }

  private persist(line?: BuildLogLine): void {
    if (!this.archive) return;
    if (line) this.pendingLines.push(line);
    if (this.archiveError) return;
    if (this.writing) return;
    this.writing = true;
    const archive = this.archive;
    this.writes = this.writes.then(async () => {
      const storage = await archive();
      if (!storage) { this.pendingLines = []; return; }
      do {
        const batch = this.pendingLines.slice();
        const view = this.view();
        if (batch.length) {
          await storage.appendImageBuildLog(this.id, batch.map(l => JSON.stringify({ ...l, text: this.redactor!.redact(l.text) })).join('\n') + '\n');
          this.pendingLines.splice(0, batch.length);
        }
        await storage.saveImageBuild({ id: this.id, build: redactDeep(view, this.redactor!), logsRetained: true });
        if (view.outcome !== 'running') {
          await settleInterruptedImageBuilds(storage);
          await storage.pruneImageBuildLogs(20);
        }
      } while (this.pendingLines.length);
    }).catch(error => {
      this.archiveError = error;
      logger.error('Could not archive image build ' + this.id + ': ' + String(error));
    }).finally(() => {
      this.writing = false;
      if (!this.archiveError && this.pendingLines.length) this.persist();
    });
  }

  async flushArchive(): Promise<void> {
    await this.writes;
    // A read/collector retries a failed archive once; incoming lines remain queued.
    // Reopen the redactor too: an unavailable secret registry must not poison a job.
    this.retryArchive();
    let pending: Promise<void>;
    do { pending = this.writes; await pending; } while (pending !== this.writes);
    if (this.archiveError) throw new Error('Image build archive failed: ' + String(this.archiveError));
  }

  archiveFailure(): string | null {
    return this.archiveError ? 'Image build archive failed: ' + String(this.archiveError) : null;
  }

  retryArchive(): void {
    if (!this.archiveError || this.writing) return;
    this.archiveError = null;
    this.persist();
  }

  readonly startedAt = new Date().toISOString();
  finishedAt: string | null = null;
  outcome: ImageBuildOutcome = 'running';
  failure: BuildFailure | null = null;
  readonly controller = new AbortController();
  readonly steps: BuildStep[] = [];
  private lines: BuildLogLine[] = [];
  private bytes = 0;
  private nextSeq = 1;
  private readonly segments = new Map<string, Segment>();
  private readonly waiters = new Set<() => void>();
  /** The daemon's full redactor once it has loaded; env-only scrubbing until then (and when it is incomplete). */
  redactor: Redactor | null = null;

  constructor(readonly kind: ImageBuildJobKind, readonly title: string) {
    this.id = `${kind}-${++jobCounter}-${randomBytes(12).toString('hex')}`;
  }

  get signal(): AbortSignal { return this.controller.signal; }
  get cancelled(): boolean { return this.controller.signal.aborted; }

  // --- the log ---------------------------------------------------------------

  /** Append a line of lazy's own narration. */
  note(text: string): void {
    this.append('lazy', null, text);
  }

  /**
   * Append an image-build narration line (`ensureImage`'s `notify`), minus
   * the echoes of docker's own progress (`building <image>: <line>`) — the
   * observer already logged those lines as docker's.
   */
  narrate(detail: string): void {
    if (/^building \S+: /.test(detail)) return;
    this.note(detail);
  }

  private append(source: 'lazy' | 'docker', image: string | null, raw: string): void {
    // Only a COMPLETE redactor is applied at ingest. An incomplete one withholds
    // every line, and doing that here would destroy the log for good — even
    // after the secret store is readable again. Reads are where withholding
    // belongs: every answer goes through redactAnswer, which fails closed.
    const scrubbed = this.redactor?.complete ? this.redactor.redact(raw) : redactSecretValues(raw);
    const text = scrubbed.length > MAX_LINE_CHARS ? `${scrubbed.slice(0, MAX_LINE_CHARS)}… [line truncated]` : scrubbed;
    const line = { seq: this.nextSeq++, at: new Date().toISOString(), source, image, text };
    this.lines.push(line);
    this.persist({ ...line, text: scrubbed });
    this.bytes += text.length;
    while (this.lines.length > MAX_LINES || this.bytes > MAX_BYTES) {
      const dropped = this.lines.shift()!;
      this.bytes -= dropped.text.length;
    }
    this.wake();
  }

  private wake(): void {
    for (const w of [...this.waiters]) w();
    this.waiters.clear();
  }

  /** Lines after `after` (a seq; 0 for the start), at most `limit`. */
  read(after: number, limit: number): { lines: BuildLogLine[]; firstSeq: number; lastSeq: number; truncatedBefore: boolean } {
    const firstSeq = this.lines[0]?.seq ?? this.nextSeq;
    const out = this.lines.filter((l) => l.seq > after).slice(0, Math.max(0, limit));
    return { lines: out, firstSeq, lastSeq: this.nextSeq - 1, truncatedBefore: after + 1 < firstSeq };
  }

  /**
   * Resolve once there is a line after `after`, the job has finished, or
   * `ms` passed — a long-poll for the streaming reader.
   */
  async waitForLines(after: number, ms: number): Promise<void> {
    if (this.nextSeq - 1 > after || this.outcome !== 'running' || ms <= 0) return;
    await new Promise<void>((resolve) => {
      const done = () => { clearTimeout(timer); this.waiters.delete(done); resolve(); };
      const timer = setTimeout(done, ms);
      this.waiters.add(done);
    });
  }

  // --- steps -----------------------------------------------------------------

  /** Declare a lazy step up front, so the total counts it before it runs. */
  planStep(id: string, label: string): void {
    if (this.steps.some((s) => s.id === id)) return;
    this.steps.push({ id, kind: 'lazy', label, image: null, status: 'pending', startedAt: null, finishedAt: null, durationMs: null });
  }

  beginStep(id: string, label: string): void {
    let step = this.steps.find((s) => s.id === id);
    if (!step) {
      step = { id, kind: 'lazy', label, image: null, status: 'pending', startedAt: null, finishedAt: null, durationMs: null };
      this.steps.push(step);
    }
    step.label = label;
    step.status = 'running';
    step.startedAt = new Date().toISOString();
    this.note(`${label}…`);
  }

  endStep(id: string, status: 'done' | 'failed' | 'cancelled', durationMs?: number): void {
    const step = this.steps.find((s) => s.id === id);
    if (!step || (step.status !== 'running' && step.status !== 'pending')) return;
    this.finishStep(step, status, durationMs);
    if (step.kind === 'lazy') this.note(`${step.label}: ${status}${step.durationMs !== null ? ` (${formatMs(step.durationMs)})` : ''}`);
  }

  private finishStep(step: BuildStep, status: BuildStepStatus, durationMs?: number): void {
    const now = Date.now();
    step.status = status;
    step.finishedAt = new Date(now).toISOString();
    if (durationMs !== undefined) step.durationMs = durationMs;
    else if (step.startedAt) step.durationMs = now - Date.parse(step.startedAt);
    else step.durationMs = null;
  }

  // --- docker output ---------------------------------------------------------

  private segment(image: string): Segment {
    let seg = this.segments.get(image);
    if (!seg) {
      seg = { stageTotals: new Map(), vertices: new Map(), classicRunning: null, startSeq: this.nextSeq, attempt: 1 };
      this.segments.set(image, seg);
    }
    return seg;
  }

  /** The observer every docker build inside this job reports to. */
  observer(): BuildObserver {
    return {
      signal: this.signal,
      // No line of its own: ensureImage's narration already says what is
      // being built and from where.
      // A second start for the same image is lazy's one retry after a lost
      // connection: a fresh segment, whose steps get their own ids (the first
      // attempt's steps and lines stay, already settled by its onBuildEnd).
      onBuildStart: (image) => {
        const previous = this.segments.get(image);
        if (!previous) { this.segment(image); return; }
        this.segments.set(image, { stageTotals: previous.stageTotals, vertices: new Map(), classicRunning: null, startSeq: this.nextSeq, attempt: previous.attempt + 1 });
      },
      onLine: (image, line) => {
        this.append('docker', image, line);
        this.parseDockerLine(image, line);
      },
      onBuildEnd: (image, outcome) => {
        const seg = this.segments.get(image);
        if (!seg) return;
        const mine = this.steps.filter((s) => s.image === image);
        const running = mine.filter((s) => s.status === 'running');
        // A failed build whose output named no failing step (the classic
        // builder never does): the step it was on when it stopped is the one.
        // A lost connection blames no step: its running steps were cut short.
        const blamed = outcome === 'failed' && !mine.some((s) => s.status === 'failed') ? running.at(-1) : undefined;
        for (const step of running) {
          this.finishStep(step, outcome === 'succeeded' ? 'done' : step === blamed ? 'failed' : 'cancelled');
        }
        seg.classicRunning = null;
      },
    };
  }

  private parseDockerLine(image: string, raw: string): void {
    const line = raw.trimEnd();
    const seg = this.segment(image);
    const vertexStep = (vertex: string) => {
      const idx = seg.vertices.get(vertex);
      return idx === undefined ? null : this.steps[idx];
    };

    const header = STEP_HEADER.exec(line);
    if (header) {
      const [, vertex, bracket, rest] = header;
      const index = STEP_INDEX.exec(bracket.trim());
      if (!index || seg.vertices.has(vertex)) return;
      const stage = index[1] ?? '';
      const total = Number(index[3]);
      seg.stageTotals.set(stage, Math.max(seg.stageTotals.get(stage) ?? 0, total));
      seg.vertices.set(vertex, this.steps.length);
      this.steps.push({
        id: `docker:${image}:#${vertex}${seg.attempt > 1 ? `@${seg.attempt}` : ''}`, kind: 'docker', label: `[${bracket.trim()}] ${rest}`.trim(), image,
        status: 'running', startedAt: new Date().toISOString(), finishedAt: null, durationMs: null,
      });
      return;
    }
    let m: RegExpExecArray | null;
    if ((m = STEP_DONE.exec(line))) {
      const step = vertexStep(m[1]);
      if (step && step.status === 'running') this.finishStep(step, 'done', m[2] ? Math.round(Number(m[2]) * 1000) : undefined);
      return;
    }
    if ((m = STEP_CACHED.exec(line))) {
      const step = vertexStep(m[1]);
      if (step && step.status === 'running') this.finishStep(step, 'cached', 0);
      return;
    }
    if ((m = STEP_ERROR.exec(line))) {
      const step = vertexStep(m[1]);
      if (step && step.status === 'running') this.finishStep(step, 'failed');
      return;
    }
    if ((m = STEP_CANCELED.exec(line))) {
      const step = vertexStep(m[1]);
      if (step && step.status === 'running') this.finishStep(step, 'cancelled');
      return;
    }
    if ((m = CLASSIC_STEP.exec(line))) {
      if (seg.classicRunning !== null) this.finishStep(this.steps[seg.classicRunning], 'done');
      seg.stageTotals.set('', Math.max(seg.stageTotals.get('') ?? 0, Number(m[2])));
      seg.classicRunning = this.steps.length;
      this.steps.push({
        id: `docker:${image}:step${m[1]}${seg.attempt > 1 ? `@${seg.attempt}` : ''}`, kind: 'docker', label: `[${m[1]}/${m[2]}] ${m[3]}`, image,
        status: 'running', startedAt: new Date().toISOString(), finishedAt: null, durationMs: null,
      });
    }
  }

  // --- outcome ---------------------------------------------------------------

  /**
   * Settle the job. A failure names its step: the docker step that ERRORed (or
   * the lazy step still running when it failed), quoting that step's output.
   */
  finish(outcome: Exclude<ImageBuildOutcome, 'running'>, error?: string): void {
    if (this.outcome !== 'running') return;
    const leftover: BuildStepStatus = outcome === 'succeeded' ? 'done' : outcome === 'cancelled' ? 'cancelled' : 'failed';
    // The LATEST failed step: a retried build's first attempt failed too.
    let failedStep = this.steps.findLast((s) => s.status === 'failed') ?? null;
    for (const step of this.steps) {
      if (step.status === 'running') {
        // A docker step still running when the job failed was cut short by the
        // failure, not the failure itself — unless nothing else is to blame.
        const status = step.kind === 'docker' && leftover === 'failed' && failedStep ? 'cancelled' : leftover;
        this.finishStep(step, status);
        if (status === 'failed' && !failedStep) failedStep = step;
      } else if (step.status === 'pending') {
        step.status = outcome === 'succeeded' ? 'done' : 'cancelled';
      }
    }
    this.outcome = outcome;
    this.finishedAt = new Date().toISOString();
    if (outcome === 'failed') {
      const message = error ?? 'The build failed.';
      this.failure = {
        stepId: failedStep?.id ?? null,
        stepLabel: failedStep?.label ?? null,
        output: (failedStep ? this.stepOutput(failedStep) : null) ?? message,
        error: message,
      };
      this.note(`Failed${failedStep ? ` at ${failedStep.label}` : ''}.`);
    } else {
      this.note(outcome === 'succeeded' ? 'Finished.' : 'Cancelled.');
    }
    this.wake();
  }

  /** A docker step's own output lines (BuildKit's `#<vertex> …`), or null. */
  private stepOutput(step: BuildStep): string | null {
    if (step.kind !== 'docker') return null;
    const vertex = /:#(\d+)(?:@\d+)?$/.exec(step.id)?.[1];
    if (!vertex) return null;
    const prefix = `#${vertex} `;
    const startSeq = step.image ? this.segments.get(step.image)?.startSeq ?? 0 : 0;
    const own = this.lines
      .filter((l) => l.source === 'docker' && l.image === step.image && l.seq >= startSeq && l.text.startsWith(prefix))
      .map((l) => l.text.slice(prefix.length))
      .filter((t) => !/^(\d+(\.\d+)?\s+)?(DONE|CACHED)\b/.test(t));
    return own.length > 0 ? own.slice(-FAILURE_OUTPUT_LINES).join('\n') : null;
  }

  /** Step N of M: N counts finished steps plus the running one; M every step known so far. */
  progress(): { step: number; total: number; label: string | null } {
    const lazySteps = this.steps.filter((s) => s.kind === 'lazy').length;
    let dockerTotal = 0;
    for (const seg of this.segments.values()) for (const t of seg.stageTotals.values()) dockerTotal += t;
    const total = Math.max(lazySteps + dockerTotal, this.steps.length);
    const finished = this.steps.filter((s) => s.status !== 'running' && s.status !== 'pending').length;
    const running = [...this.steps].reverse().find((s) => s.status === 'running') ?? null;
    const step = Math.min(total, finished + (running ? 1 : 0));
    const label = running?.label ?? this.steps.filter((s) => s.status !== 'pending').at(-1)?.label ?? null;
    return { step, total, label };
  }

  /** What every surface shows about this job (lines are read separately). */
  view() {
    return {
      ...this.metadata,
      id: this.id,
      kind: this.kind,
      title: this.title,
      outcome: this.outcome,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      durationMs: (this.finishedAt ? Date.parse(this.finishedAt) : Date.now()) - Date.parse(this.startedAt),
      progress: this.progress(),
      steps: this.steps.map((s) => ({ ...s })),
      failure: this.failure,
      lastSeq: this.nextSeq - 1,
    };
  }

  /** Run `fn` with every container build inside it reporting to this job. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    return runWithBuildObserver(this.observer(), fn);
  }
}

/**
 * `work`, or a rejection the moment the job is cancelled — so Cancel settles
 * at once even while the build waits on another build's lock (where there is
 * no docker client of ours to kill yet).
 */
export function whileNotCancelled<T>(job: ImageBuildJob, work: Promise<T>): Promise<T> {
  if (job.cancelled) return Promise.reject(new Error('Cancelled'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('Cancelled'));
    job.signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (v) => { job.signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { job.signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

export type ImageBuildJobView = ReturnType<ImageBuildJob['view']>;

function formatMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Start a job and keep it readable (the oldest finished ones are dropped). */
export function startImageBuildJob(kind: ImageBuildJobKind, title: string, projectRoot?: string): ImageBuildJob {
  const job = new ImageBuildJob(kind, title);
  jobs.push(job);
  while (jobs.length > MAX_JOBS) {
    const idx = jobs.findIndex((j) => j.outcome !== 'running');
    if (idx < 0) break;
    jobs.splice(idx, 1);
  }
  if (projectRoot) {
    job.enableArchive(projectRoot);

  }
  return job;
}

/** A job by id, or the newest job (of `kind`, when given). */
export function findImageBuildJob(id?: string, kind?: ImageBuildJobKind): ImageBuildJob | null {
  if (id) return jobs.find((j) => j.id === id) ?? null;
  for (let i = jobs.length - 1; i >= 0; i--) {
    if (!kind || jobs[i].kind === kind) return jobs[i];
  }
  return null;
}

/** Every job still kept, newest first. */
export function listImageBuildJobs(): ImageBuildJob[] {
  return [...jobs].reverse();
}

/** Archive failures remain attached to their build, never hide healthy history. */
export async function readImageBuildHistory(storage: Storage | null, { flush = true } = {}): Promise<StoredImageBuild[]> {
  const live = listImageBuildJobs();
  const previousErrors = new Map(live.map(job => [job.id, job.archiveFailure()]));
  if (flush) await Promise.allSettled(live.map(job => job.flushArchive()));
  else live.forEach(job => job.retryArchive());
  if (storage) {
    await settleInterruptedImageBuilds(storage);
    await storage.pruneImageBuildLogs(20);
  }
  const builds = storage ? await storage.listImageBuilds() : [];
  for (const job of live) {
    const archiveError = job.archiveFailure() ?? (!flush ? previousErrors.get(job.id) : null);
    const index = builds.findIndex(row => row.id === job.id);
    const row = { id: job.id, build: { ...job.view(), ...(archiveError ? { archiveError } : {}) }, logsRetained: index < 0 || builds[index].logsRetained };
    if (index >= 0) builds[index] = row;
    else builds.push(row);
  }
  return builds.sort((a, b) => String(b.build.startedAt).localeCompare(String(a.build.startedAt)));
}

/** No previous daemon generation can still own a live image build. */
async function settleInterruptedImageBuilds(storage: Storage): Promise<StoredImageBuild[]> {
  const builds = await storage.listImageBuilds();
  for (const row of builds) {
    if (row.build.outcome !== 'running' || findImageBuildJob(row.id)) continue;
    row.build = { ...row.build, outcome: 'interrupted' };
    await storage.saveImageBuild(row);
  }
  return builds;
}

/** Tests only. */
export function resetImageBuildJobsForTests(): void {
  jobs.length = 0;
}
