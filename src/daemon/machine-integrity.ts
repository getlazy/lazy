/**
 * Does this project's machine damage data by itself? Two automatic checks, so
 * "did smolvm 1.29 fix the corruption?" is answered without anyone running
 * diagnostics (docs/machine-integrity-checks.md):
 *
 *  1. The MEMORY CANARY (src/docker/memory-canary.ts): stores to freshly
 *     allocated memory, read back, no Docker and no disk involved. Hourly from
 *     the guest watchdog's tick, and once right after a layer-extraction
 *     failure, before the self-repair removes anything (its result rides in
 *     that failure's evidence).
 *  2. The BLOB AUDIT (src/docker/blob-audit.ts): right after an image build
 *     job succeeds, every content-store blob it committed is re-hashed; once
 *     the machine has then sat idle, again. Wrong at once = damaged on the way
 *     down; right at once and wrong later = damaged on disk.
 *
 * Only on the managed microVM backend (`guestDockerdSupervised`): there the
 * daemon runs in the guest, as root, next to the dockerd it audits. Elsewhere
 * nothing runs.
 *
 * NEVER UNDER MEMORY PRESSURE. The canary needs ~32 MiB and a few CPU-seconds,
 * but a build or a launch is exactly when the machine has neither to spare
 * (dockerd was OOM-killed by builds before). A scheduled canary is skipped —
 * and retried on the next minute's tick — while an image build runs, while a
 * task launch is in flight, or while the guest's MemAvailable is under
 * CANARY_MIN_AVAILABLE_BYTES. The post-failure canary ignores only the launch
 * gate (the failing launch is the one in flight, and it is not running).
 *
 * WHAT IS SURFACED. A damaging result is an `alert` system message (source
 * `machine-docker`), one per kind of finding: a repeat while it is open bumps
 * its count and refreshes its body, so an hourly failing canary is one alert,
 * not 24 a day. A clean result files nothing; it is the quiet "last checked"
 * line on the Machine page and in god mode's Doctor. Every result — clean or
 * not — is written to the daemon log, which is the evidence trail.
 *
 * State is in memory, deliberately: it describes THIS boot of this machine,
 * and the alerts that matter are persisted as system messages.
 */

import { readFile } from 'fs/promises';
import { logger } from '../utils/logger';
import { spawn } from '../utils/spawn';
import type { SystemMessage, SystemMessageInput } from '../types';
import { GUEST_DOCKERD_MESSAGE_SOURCE, guestDockerdSupervised } from './guest-dockerd';
import { runMemoryCanary, describeCanaryResult, type CanaryResult } from '../docker/memory-canary';
import {
  auditMeaning, blobsCommittedSince, classifyAudit, contentBlobDir, describeAudit, hashBlobs,
  type AuditBlob, type AuditVerdict, type BlobCheck,
} from '../docker/blob-audit';

/** How often the scheduled canary runs. */
export const CANARY_INTERVAL_MS = 3600_000;
/** Below this much available memory, no canary starts. */
export const CANARY_MIN_AVAILABLE_BYTES = 512 * 1024 * 1024;
/**
 * How long the machine must sit with no build and no launch before the second
 * audit pass. Longer than smolvm's idle-reclaim delay (~10 minutes), so an
 * idle-time reclaim has had its chance to happen.
 */
export const AUDIT_IDLE_MS = 15 * 60_000;

export interface CanaryRecord {
  at: string;
  trigger: 'scheduled' | 'extraction-failure';
  outcome: 'clean' | 'corrupt' | 'incomplete' | 'skipped';
  /** The result in words (or why it was skipped). */
  summary: string;
}

export interface AuditRecord {
  at: string;
  phase: 'after-build' | 'after-idle';
  build: string;
  verdict: AuditVerdict | 'not-run';
  checked: number;
  summary: string;
}

export interface MachineIntegrityView {
  /** The latest canary that RAN; null before the first. */
  canary: CanaryRecord | null;
  /** The latest skip, when newer than the latest run (why it has not run). */
  canarySkipped: CanaryRecord | null;
  /** The latest audit pass; null before the first. */
  audit: AuditRecord | null;
  /** A build's blobs waiting for the after-idle pass. */
  auditPending: { build: string; blobs: number } | null;
  /** True while a damaging result is the latest of its check. */
  damaged: boolean;
  /** The quiet "last checked" line. */
  lastChecked: string;
  /**
   * The OPEN integrity alerts from the store (newest first), so a damaging
   * result outlives the in-memory state across daemon restarts. Filled in by
   * {@link withOpenIntegrityAlerts}; empty from {@link machineIntegrityView}.
   */
  openAlerts: Array<{ title: string; body: string; createdAt: string }>;
}

// --- gate --------------------------------------------------------------------

export interface PressureSignals {
  buildRunning: boolean;
  launchInFlight: boolean;
  /** /proc/meminfo's MemAvailable in bytes; null when unreadable. */
  memAvailableBytes: number | null;
}

/** Why a canary must not run now, or null when it may. */
export function canarySkipReason(s: PressureSignals, opts: { ignoreLaunches?: boolean } = {}): string | null {
  if (s.buildRunning) return 'an image build is running';
  if (s.launchInFlight && !opts.ignoreLaunches) return 'a task launch is in flight';
  if (s.memAvailableBytes !== null && s.memAvailableBytes < CANARY_MIN_AVAILABLE_BYTES) {
    return `only ${Math.round(s.memAvailableBytes / 1048576)} MiB of memory is available (it runs with at least ${CANARY_MIN_AVAILABLE_BYTES / 1048576} MiB free)`;
  }
  return null;
}

export function parseMemAvailable(meminfo: string): number | null {
  const m = /^MemAvailable:\s+(\d+)\s*kB/m.exec(meminfo);
  return m ? Number(m[1]) * 1024 : null;
}

async function readPressure(): Promise<PressureSignals> {
  const { listImageBuildJobs } = await import('./image-build-job');
  const { anyLaunchInFlight } = await import('../runner/launch-in-flight');
  const { runningContainerBuilds } = await import('../capture/build-observer');
  let memAvailableBytes: number | null = null;
  try {
    memAvailableBytes = parseMemAvailable(await readFile('/proc/meminfo', 'utf8'));
  } catch (err) {
    logger.debug(`machine integrity: /proc/meminfo not readable (${(err as Error).message}); the memory gate is not applied`);
  }
  return {
    // Jobs AND bare builds: a launch's inline default-image build, and the boot
    // path's concurrent one, run outside any job.
    buildRunning: runningContainerBuilds() > 0 || listImageBuildJobs().some((j) => j.outcome === 'running'),
    launchInFlight: anyLaunchInFlight(),
    memAvailableBytes,
  };
}

// --- state -------------------------------------------------------------------

let canary: CanaryRecord | null = null;
let canarySkipped: CanaryRecord | null = null;
let canaryLastRanAt: number | null = null;
let canaryInFlight: Promise<CanaryRecord> | null = null;
let audit: AuditRecord | null = null;
let pending: { builds: string[]; finishedAt: number; entries: Map<string, { blob: AuditBlob; atCommit: BlobCheck }>; leftOut: number } | null = null;
let lastBusyAt = 0;

export function machineIntegrityView(): MachineIntegrityView {
  const view = {
    canary,
    canarySkipped,
    audit,
    auditPending: pending ? { build: pending.builds.join(', '), blobs: pending.entries.size } : null,
    damaged: canary?.outcome === 'corrupt' || (audit !== null && (audit.verdict === 'damaged-on-write' || audit.verdict === 'damaged-after-write')),
  };
  return { ...view, lastChecked: lastCheckedLine(view), openAlerts: [] };
}

/** The open integrity alerts among `messages`, newest first. */
export function openIntegrityAlerts<M extends Pick<SystemMessage, 'source' | 'title' | 'body' | 'created_at'>>(messages: M[]): M[] {
  const titles = new Set<string>(Object.values(INTEGRITY_TITLES));
  return messages
    .filter((m) => m.source === GUEST_DOCKERD_MESSAGE_SOURCE && titles.has(m.title))
    .sort((a, b) => b.created_at - a.created_at);
}

/**
 * The view plus the store's open alerts: `damaged` holds while any is open,
 * whatever this boot's checks last said.
 */
export function withOpenIntegrityAlerts(view: MachineIntegrityView, messages: Pick<SystemMessage, 'source' | 'title' | 'body' | 'created_at'>[]): MachineIntegrityView {
  const open = openIntegrityAlerts(messages).slice(0, 5);
  return {
    ...view,
    damaged: view.damaged || open.length > 0,
    openAlerts: open.map((m) => ({ title: m.title, body: m.body.length > 4000 ? `${m.body.slice(0, 4000)}\n… (cut)` : m.body, createdAt: new Date(m.created_at).toISOString() })),
  };
}

/** The quiet "last checked" line. */
export function lastCheckedLine(view: Pick<MachineIntegrityView, 'canary' | 'canarySkipped' | 'audit' | 'auditPending'>): string {
  const memory = view.canary
    ? `Memory last checked ${view.canary.at}: ${view.canary.outcome}.`
    : `Memory not checked yet${view.canarySkipped ? ` (${view.canarySkipped.summary.replace(/^Memory check not run: /, '').replace(/\.$/, '')})` : ''}.`;
  const data = view.audit
    ? `Image data last checked ${view.audit.at} (${view.audit.phase === 'after-build' ? 'after a build' : 'after the machine sat idle'}): ${view.audit.verdict}${view.auditPending ? '; checked again once the machine has been idle' : ''}.`
    : 'Image data not checked yet (it is checked after each image build).';
  return `${memory} ${data}`;
}

/** Tests only. */
export function resetMachineIntegrityForTests(): void {
  canary = null; canarySkipped = null; canaryLastRanAt = null; canaryInFlight = null;
  audit = null; pending = null; lastBusyAt = 0; auditChain = Promise.resolve();
  reporter = null; deps = defaultDeps;
}

// --- reporting ---------------------------------------------------------------

export type IntegrityFinding =
  | { kind: 'canary'; text: string }
  | { kind: 'audit'; verdict: Exclude<AuditVerdict, 'intact'>; text: string };

type Reporter = (input: SystemMessageInput) => Promise<void> | void;
let reporter: Reporter | null = null;

/** The daemon registers where alerts go (system messages). */
export function setMachineIntegrityReporter(fn: Reporter | null): void {
  reporter = fn;
}

/** Titles are FIXED per kind of finding: repeats collapse on source+kind+title. */
export const INTEGRITY_TITLES = {
  canary: "The memory check found lost writes in this project's machine",
  'damaged-on-write': "Docker image data was damaged as it was stored in this project's machine",
  'damaged-after-write': "Docker image data changed on disk after it was stored in this project's machine",
} as const;

const CANARY_MEANING =
  'The machine wrote a pattern to freshly allocated memory and read back something else. Nothing on disk and nothing in Docker ' +
  'was involved, so this is the machine\'s memory itself — the fault that damages Docker image layers. ' +
  'Images built or pulled on this machine may be damaged; lazy rebuilds a damaged image by itself when a launch hits one.';

/** The alert a damaging finding files. */
export function integrityAlert(finding: IntegrityFinding): SystemMessageInput {
  if (finding.kind === 'canary') {
    return { source: GUEST_DOCKERD_MESSAGE_SOURCE, kind: 'alert', title: INTEGRITY_TITLES.canary, body: `${CANARY_MEANING}\n\n${finding.text}` };
  }
  return {
    source: GUEST_DOCKERD_MESSAGE_SOURCE, kind: 'alert', title: INTEGRITY_TITLES[finding.verdict],
    body: `${auditMeaning(finding.verdict)} lazy rebuilds a damaged image by itself when a launch hits one.\n\n${finding.text}`,
  };
}

/**
 * File an alert, collapsing repeats: while one of the same kind is open, a new
 * finding bumps its count and replaces its body with the latest evidence (the
 * daemon log keeps every occurrence).
 */
export async function fileIntegrityAlert(
  storage: { createSystemMessage(input: SystemMessageInput, options?: { collapseRepeats?: boolean; refreshBody?: boolean }): Promise<SystemMessage> },
  input: SystemMessageInput,
): Promise<SystemMessage> {
  return storage.createSystemMessage(input, { collapseRepeats: true, refreshBody: true });
}

async function report(finding: IntegrityFinding): Promise<void> {
  if (!reporter) return;
  try {
    await reporter(integrityAlert(finding));
  } catch (err) {
    logger.error(`Could not file the machine integrity alert: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// --- seams -------------------------------------------------------------------

interface Deps {
  supervised: () => boolean;
  pressure: () => Promise<PressureSignals>;
  canary: () => Promise<CanaryResult>;
  dataRoot: () => Promise<string | null>;
  now: () => number;
}

async function dockerDataRoot(): Promise<string | null> {
  const proc = spawn(['docker', 'info', '--format', '{{.DockerRootDir}}'], { stdout: 'pipe', stderr: 'pipe', timeout: 15_000 });
  const [out, , code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return code === 0 && out.trim() ? out.trim() : null;
}

const defaultDeps: Deps = {
  supervised: () => guestDockerdSupervised(),
  pressure: readPressure,
  canary: () => runMemoryCanary(),
  dataRoot: dockerDataRoot,
  now: () => Date.now(),
};
let deps: Deps = defaultDeps;

/** Tests only: replace the probes. */
export function setMachineIntegrityDepsForTests(d: Partial<Deps>): void {
  deps = { ...defaultDeps, ...d };
}

// --- canary ------------------------------------------------------------------

/**
 * Run the canary now unless the gate says no. Single-flight. Returns what was
 * recorded; a corrupt result is also alerted.
 */
export function runIntegrityCanary(trigger: CanaryRecord['trigger']): Promise<CanaryRecord> {
  if (canaryInFlight) return canaryInFlight;
  canaryInFlight = (async () => {
    const at = new Date(deps.now()).toISOString();
    const why = canarySkipReason(await deps.pressure(), { ignoreLaunches: trigger === 'extraction-failure' });
    if (why) {
      const record: CanaryRecord = { at, trigger, outcome: 'skipped', summary: `Memory check not run: ${why}.` };
      canarySkipped = record;
      // A scheduled skip recurs every minute while the machine is busy: debug, not info.
      if (trigger === 'scheduled') logger.debug(`machine integrity: ${record.summary}`);
      else logger.info(`machine integrity: ${record.summary}`);
      return record;
    }
    const result = await deps.canary();
    canaryLastRanAt = deps.now();
    const record: CanaryRecord = { at, trigger, outcome: result.verdict, summary: describeCanaryResult(result) };
    canary = record;
    canarySkipped = null;
    const text = `${record.summary}\n(${trigger === 'scheduled' ? 'the hourly check' : 'run right after a layer-extraction failure'}, ${at})`;
    if (result.verdict === 'corrupt') {
      logger.error(`machine integrity: ${text}`);
      await report({ kind: 'canary', text });
    } else {
      logger.info(`machine integrity: ${text}`);
    }
    return record;
  })().finally(() => { canaryInFlight = null; });
  return canaryInFlight;
}

/** The canary run for a layer-extraction failure's evidence, as text. Off the microVM, says so. */
export async function canaryEvidenceForExtractionFailure(): Promise<string> {
  if (!deps.supervised()) return 'Memory check: not run (it runs only on a Lazy Teams project machine).';
  return (await runIntegrityCanary('extraction-failure')).summary;
}

// --- audit -------------------------------------------------------------------

/**
 * Audits run ONE AT A TIME, in order, through this chain: two builds finishing
 * together (the project image and lazy's default image) or a build finishing
 * during a long after-idle re-hash are queued, never dropped.
 */
let auditChain: Promise<unknown> = Promise.resolve();
function serialAudit<T>(fn: () => Promise<T>): Promise<T> {
  const next = auditChain.then(fn, fn);
  auditChain = next.catch(() => undefined);
  return next;
}

/** First pass: right after a successful image build. */
export function auditAfterBuild(build: string, startedAt: number): Promise<AuditRecord | null> {
  if (!deps.supervised()) return Promise.resolve(null);
  return serialAudit(async () => {
    try {
      const at = new Date(deps.now()).toISOString();
      const root = await deps.dataRoot();
      if (!root) {
        audit = { at, phase: 'after-build', build, verdict: 'not-run', checked: 0, summary: 'Image data check not run: Docker\'s data-root could not be read.' };
        logger.warn(`machine integrity: ${audit.summary}`);
        return audit;
      }
      const { blobs, leftOut } = await blobsCommittedSince(contentBlobDir(root), startedAt);
      const atCommit = await hashBlobs(blobs);
      const c = classifyAudit(atCommit);
      audit = { at, phase: 'after-build', build, verdict: c.verdict, checked: c.checked, summary: describeAudit(c, 'after-build', leftOut) };
      lastBusyAt = deps.now();
      if (blobs.length > 0) addPending(build, blobs, atCommit, leftOut);
      await recordAudit(audit, c.verdict);
      return audit;
    } catch (err) {
      logger.error(`machine integrity: the image data check after ${build} failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  });
}

/**
 * Merge a build's blobs into the pending after-idle set. A blob an earlier
 * build already queued keeps its FIRST at-commit result: that is the one
 * taken right after it was written.
 */
function addPending(build: string, blobs: AuditBlob[], atCommit: BlobCheck[], leftOut: number): void {
  const p: NonNullable<typeof pending> = pending ?? { builds: [], finishedAt: 0, entries: new Map(), leftOut: 0 };
  if (!p.builds.includes(build)) p.builds.push(build);
  p.finishedAt = deps.now();
  p.leftOut += leftOut;
  blobs.forEach((blob, i) => {
    if (!p.entries.has(blob.digest)) p.entries.set(blob.digest, { blob, atCommit: atCommit[i] });
  });
  pending = p;
}

async function recordAudit(record: AuditRecord, verdict: AuditVerdict, alreadyAlerted = false): Promise<void> {
  const text = `${record.summary}\n(build: ${record.build}, ${record.at})`;
  if (verdict === 'intact') {
    logger.info(`machine integrity: ${text}`);
    return;
  }
  logger.error(`machine integrity: ${text}`);
  if (!alreadyAlerted) await report({ kind: 'audit', verdict, text });
}

/** Second pass, once the machine has been idle long enough. */
export function auditAfterIdle(): Promise<AuditRecord | null> {
  return serialAudit(async () => {
    if (!pending) return null;
    const p = pending;
    pending = null;
    const entries = [...p.entries.values()];
    const atCommit = entries.map((e) => e.atCommit);
    const later = await hashBlobs(entries.map((e) => e.blob));
    const c = classifyAudit(atCommit, later);
    audit = { at: new Date(deps.now()).toISOString(), phase: 'after-idle', build: p.builds.join(', '), verdict: c.verdict, checked: c.checked, summary: describeAudit(c, 'after-idle', p.leftOut) };
    // Still the same on-write damage the first pass already alerted: log it, do not re-alert.
    await recordAudit(audit, c.verdict, c.verdict === 'damaged-on-write');
    return audit;
  });
}

// --- the watchdog's tick -----------------------------------------------------

/**
 * Called from the guest watchdog every minute: run the hourly canary when it
 * is due and the gate allows, and the after-idle audit once the machine has
 * been quiet for AUDIT_IDLE_MS.
 */
export async function machineIntegrityTick(): Promise<void> {
  if (!deps.supervised()) return;
  const now = deps.now();
  const pressure = await deps.pressure();
  const busy = pressure.buildRunning || pressure.launchInFlight;
  if (busy) lastBusyAt = now;
  if (pending && !busy && now - Math.max(lastBusyAt, pending.finishedAt) >= AUDIT_IDLE_MS) await auditAfterIdle();
  if (canaryLastRanAt === null || now - canaryLastRanAt >= CANARY_INTERVAL_MS) await runIntegrityCanary('scheduled');
}

/** The container-build listener (src/capture/build-observer.ts): audit after EVERY successful build, job or not. */
export function onImageBuildSucceeded(image: string, startedAt: number): void {
  void auditAfterBuild(image, startedAt);
}

// --- doctor ------------------------------------------------------------------

export interface IntegrityDoctorResult { ok: boolean; label: string; problem?: string; detail?: string; remedy?: string }

const DOCTOR_DETAIL_MAX = 4000;
export const INTEGRITY_DOCTOR_LABEL = 'Machine memory and image data checks';

/**
 * God mode's Doctor line: an open integrity alert is a failure (with its
 * evidence); otherwise the quiet "last checked" line.
 */
export function machineIntegrityDoctorResult(
  messages: Pick<SystemMessage, 'source' | 'title' | 'body' | 'created_at'>[],
  view: MachineIntegrityView,
  supervised: boolean,
): IntegrityDoctorResult {
  const open = openIntegrityAlerts(messages);
  const label = INTEGRITY_DOCTOR_LABEL;
  if (open.length > 0) {
    const latest = open[0];
    const body = latest.body.length > DOCTOR_DETAIL_MAX ? `${latest.body.slice(0, DOCTOR_DETAIL_MAX)}\n… (cut; the full text is in the system message)` : latest.body;
    return {
      ok: false, label, problem: latest.title,
      detail: `${open.length} open alert(s); the newest, ${new Date(latest.created_at).toISOString()}:\n\n${body}`,
      remedy: 'Nothing to run: lazy rebuilds a damaged image by itself when a launch hits one. Send this evidence, with the machine\'s smolvm version, to the Lazy Teams maintainers, then dismiss the alert.',
    };
  }
  if (!supervised) return { ok: true, label: `${label} (only on a Lazy Teams project machine)` };
  return { ok: true, label: `${label} — ${view.lastChecked}` };
}
