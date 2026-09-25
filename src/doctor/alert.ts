/**
 * Inbox alert for a doctor run that found ERROR-level checks.
 *
 * People who never run `lazy doctor` still need to see what it found — the
 * dashboard inbox is the surface they already look at. One open doctor
 * alert at a time; a still-open message is reused so re-running doctor
 * does not stack alerts.
 *
 * Source is `doctor` (the producing surface), never caller-supplied.
 */

import type { Storage } from '../storage/interface';
import type { SystemMessage } from '../types';
import type { DoctorCheckResult, DoctorReport } from './types';

/** Title prefix every doctor alert shares — the dedup key's first half. */
export const DOCTOR_ALERT_TITLE = 'lazy doctor found issues';

/** Producing surface recorded on the message. */
export const DOCTOR_ALERT_SOURCE = 'doctor';

/** Error-level checks, in sweep order. */
export function errorChecks(report: DoctorReport): DoctorCheckResult[] {
  return report.checks.filter(check => check.status === 'error');
}

/**
 * Canonical body for the inbox alert.
 *
 * One heading plus one subsection per failed check: the title, the detail the
 * sweep already computed, and the remedy flag when there is one. Stable across
 * runs of the same failures so the dedup compare is a straight string match.
 */
export function doctorAlertBody(errors: DoctorCheckResult[]): string {
  const lines = [
    '`lazy doctor` found the following errors. People who never run doctor see this in the inbox so the findings are not invisible.',
    '',
  ];
  for (const check of errors) {
    lines.push(`### ${check.title}`);
    if (check.detail) lines.push(check.detail);
    if (check.remedy) lines.push(check.remedy);
    else if (check.remedyFlag) {
      lines.push(`Remedy: \`lazy doctor --${check.remedyFlag}\``);
    }
    if (check.docs) lines.push(`Documentation: ${check.docs}`);
    lines.push('');
  }
  lines.push('Run `lazy doctor` for the full report.');
  return lines.join('\n').trimEnd() + '\n';
}

/**
 * True when `message` is a still-open doctor findings alert.
 *
 * Dedup is title + source + kind + not dismissed, not the body. Check
 * details drift across runs (disk bytes, PIDs, timing) and matching the
 * body would stack an alert every time someone re-ran doctor — the failure
 * this function exists to prevent. A dismissed copy must not suppress a
 * later run, or a human who cleared the inbox would never hear about the
 * same failure coming back.
 */
export function isDuplicateDoctorAlert(message: SystemMessage): boolean {
  return (
    message.kind === 'alert' &&
    message.source === DOCTOR_ALERT_SOURCE &&
    message.title === DOCTOR_ALERT_TITLE &&
    message.dismissed_at === undefined
  );
}

/**
 * File one inbox alert for the failed checks, or reuse the open duplicate.
 *
 * Returns the existing or newly created message, or null when there is nothing
 * to file (no errors). Never throws for "nothing to say"; storage errors
 * propagate so a failed write is visible.
 */
export async function maybePostDoctorAlert(
  storage: Storage,
  report: DoctorReport,
): Promise<SystemMessage | null> {
  const errors = errorChecks(report);
  if (errors.length === 0) return null;

  const body = doctorAlertBody(errors);
  const open = await storage.listSystemMessages();
  const duplicate = open.find(message => isDuplicateDoctorAlert(message));
  if (duplicate) return duplicate;

  return storage.createSystemMessage({
    source: DOCTOR_ALERT_SOURCE,
    kind: 'alert',
    title: DOCTOR_ALERT_TITLE,
    body,
  });
}
