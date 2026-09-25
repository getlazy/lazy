/**
 * Daemon RPC for the doctor report.
 *
 * `doctor.run` executes the same sweep `lazy doctor` uses, against the
 * daemon's long-lived Storage handle. `doctor.report` returns the last
 * result. The snapshot is HOUSEKEEPING (this machine's last run), so it
 * lives next to the pidfile rather than in Storage — the same carve-out
 * as the upgrade-notice version marker.
 *
 * The sweep is async in-process, not a Worker: a Worker cannot share this
 * Storage handle, and opening a second FileStorage would fight the lock
 * the daemon holds for life. Isolated blocking probes (statfs) already
 * run off-thread inside the module.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { getDaemonDir } from './paths';
import { getOrCreateStorage } from './rpc-handlers';
import { RpcError } from './rpc-error';
import { requireNonBlankString } from './rpc-params';
import type { ProgressEmitter } from './progress';
import { resumeTask } from './task-lifecycle';
import { collectDaemonHealth } from './daemon-health';
import { maybePostDoctorAlert, runDoctorReport, type DoctorReport, type StoredDoctorReport } from '../doctor';
import {
  applyRemedy,
  isDoctorRemedyFlag,
  previewRemedy,
  type DoctorRemedyFlag,
  type DoctorRemedyPreview,
  type DoctorRemedyProgressEvent,
  type DoctorRemedyResult,
} from '../doctor/remedies';

const LAST_REPORT_FILE = 'doctor-last-report.json';

function lastReportPath(projectRoot: string): string {
  return join(getDaemonDir(projectRoot), LAST_REPORT_FILE);
}

async function persistLastReport(projectRoot: string, report: DoctorReport): Promise<void> {
  const stored: StoredDoctorReport = { report, storedAt: new Date().toISOString() };
  const dir = getDaemonDir(projectRoot);
  await mkdir(dir, { recursive: true });
  await writeFile(lastReportPath(projectRoot), JSON.stringify(stored), 'utf-8');
}

async function readLastReport(projectRoot: string): Promise<StoredDoctorReport | null> {
  try {
    const raw = await readFile(lastReportPath(projectRoot), 'utf-8');
    const parsed = JSON.parse(raw) as StoredDoctorReport;
    if (!parsed || typeof parsed !== 'object' || !parsed.report) return null;
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(
      `failed to read last doctor report at ${lastReportPath(projectRoot)}: ` +
      (err instanceof Error ? err.message : String(err)),
    );
  }
}

/**
 * Run the sweep, persist the snapshot, file an inbox alert on errors.
 *
 * `alert: false` skips the inbox alert. Lazy Teams passes it: its members read
 * the project inbox, the alert is written for someone who can run
 * `lazy doctor`, and Teams surfaces findings itself in product language.
 */
export async function handleDoctorRun(
  projectRoot: string,
  params: Record<string, unknown> = {},
): Promise<DoctorReport> {
  if (params.alert !== undefined && typeof params.alert !== 'boolean') {
    throw new RpcError(400, `doctor.run 'alert' must be a boolean, got ${typeof params.alert}`);
  }
  const storage = await getOrCreateStorage();
  const { report } = await runDoctorReport({
    root: projectRoot,
    storage,
    // In-process: the daemon must not RPC itself for its own health.
    daemonHealth: () => collectDaemonHealth(projectRoot),
  });
  await persistLastReport(projectRoot, report);
  if (params.alert !== false) await maybePostDoctorAlert(storage, report);
  return report;
}

/** Last `doctor.run` result for this project on this machine, or null. */
export async function handleDoctorReport(projectRoot: string): Promise<StoredDoctorReport | null> {
  return readLastReport(projectRoot);
}

function parseRemedyFlag(params: Record<string, unknown>): DoctorRemedyFlag {
  const flag = requireNonBlankString(params, 'flag');
  if (!isDoctorRemedyFlag(flag)) {
    throw new RpcError(400, `Unknown doctor remedy flag '${flag}'`);
  }
  return flag;
}

/** Dry-run list for one flag. Does not act. */
export async function handleDoctorPreviewRemedy(
  projectRoot: string,
  params: Record<string, unknown>,
): Promise<DoctorRemedyPreview> {
  const flag = parseRemedyFlag(params);
  const storage = await getOrCreateStorage();
  return previewRemedy(flag, { root: projectRoot, storage });
}

/** Act on one flag. The caller has already confirmed. */
export async function handleDoctorApplyRemedy(
  projectRoot: string,
  params: Record<string, unknown>,
  progress?: ProgressEmitter,
): Promise<DoctorRemedyResult> {
  const flag = parseRemedyFlag(params);
  const storage = await getOrCreateStorage();
  const onProgress = (event: DoctorRemedyProgressEvent): void => {
    if (!progress) return;
    progress({
      kind: 'phase',
      id: event.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'step',
      label: event.label,
      state: event.state === 'error' ? 'failed' : event.state === 'ok' ? 'done' : event.state,
      index: 0,
      total: 1,
      detail: event.detail,
    });
  };
  return applyRemedy(flag, {
    root: projectRoot,
    storage,
    onProgress,
    resumeTask: async (taskId) => {
      const result = await resumeTask(projectRoot, { taskId });
      return { warnings: result.warnings };
    },
  });
}
