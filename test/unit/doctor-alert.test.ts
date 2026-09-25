import { describe, expect, test } from 'bun:test';
import {
  DOCTOR_ALERT_SOURCE,
  DOCTOR_ALERT_TITLE,
  doctorAlertBody,
  errorChecks,
  isDuplicateDoctorAlert,
  maybePostDoctorAlert,
  type DoctorReport,
} from '../../src/doctor';
import type { Storage } from '../../src/storage/interface';
import type { SystemMessage } from '../../src/types';

function reportWith(...checks: DoctorReport['checks']): DoctorReport {
  return {
    ranAt: '2026-09-09T00:00:00.000Z',
    root: '/tmp/proj',
    checks,
    contextBudget: null,
    missingRuns: [],
    staleStorageLockPath: null,
    configError: null,
    notes: [],
    errorCount: checks.filter(c => c.status === 'error').length,
    warningCount: checks.filter(c => c.status === 'warning').length,
  };
}

function fakeStorage(seed: SystemMessage[] = []): Storage & {
  created: SystemMessage[];
} {
  const messages = [...seed];
  const created: SystemMessage[] = [];
  return {
    created,
    listSystemMessages: async (options?: { includeDismissed?: boolean }) =>
      options?.includeDismissed ? messages : messages.filter(m => !m.dismissed_at),
    createSystemMessage: async (input) => {
      const message: SystemMessage = {
        id: `msg-${created.length + 1}`,
        created_at: Date.now(),
        ...input,
      };
      messages.push(message);
      created.push(message);
      return message;
    },
  } as Storage & { created: SystemMessage[] };
}

describe('doctor inbox alert', () => {
  const errors = [
    {
      id: 'stranded-merging',
      title: "No tasks stranded in merging",
      status: 'error' as const,
      detail: "1 task(s) in 'merging'. Recover with: lazy unblock",
      remedy: 'lazy unblock <task>',
    },
  ];

  test('errorChecks ignores warnings and oks', () => {
    const report = reportWith(
      { id: 'ok', title: 'Git', status: 'ok' },
      { id: 'warn', title: 'tmux', status: 'warning', detail: 'missing' },
      errors[0]!,
    );
    expect(errorChecks(report)).toEqual([errors[0]]);
  });

  test('doctorAlertBody is stable for the same failures', () => {
    const a = doctorAlertBody(errors);
    const b = doctorAlertBody(errors);
    expect(a).toBe(b);
    expect(a).toContain("No tasks stranded in merging");
    expect(a).toContain('lazy unblock');
    expect(a).toContain('Run `lazy doctor` for the full report.');
  });

  test('isDuplicateDoctorAlert matches any still-open doctor alert, ignoring body drift', () => {
    const body = doctorAlertBody(errors);
    const open: SystemMessage = {
      id: '1',
      created_at: 1,
      source: DOCTOR_ALERT_SOURCE,
      title: DOCTOR_ALERT_TITLE,
      body,
      kind: 'alert',
    };
    expect(isDuplicateDoctorAlert(open)).toBe(true);
    // Detail text changes between runs (disk, pids); that must not stack alerts.
    expect(isDuplicateDoctorAlert({ ...open, body: body + ' extra' })).toBe(true);
    expect(isDuplicateDoctorAlert({ ...open, dismissed_at: 99 })).toBe(false);
    expect(isDuplicateDoctorAlert({ ...open, source: 'daemon' })).toBe(false);
    expect(isDuplicateDoctorAlert({ ...open, kind: 'notice' })).toBe(false);
  });

  // INVARIANT: a CLI (or daemon) doctor run that finds errors files ONE inbox
  // alert. An identical still-open message is reused so re-running does not
  // stack alerts. A dismissed copy must not suppress a later run — the human
  // who cleared the inbox still needs to hear about the same failure coming back.
  test('maybePostDoctorAlert posts once and reuses an identical open alert', async () => {
    const storage = fakeStorage();
    const report = reportWith(errors[0]!);

    const first = await maybePostDoctorAlert(storage, report);
    expect(first).not.toBeNull();
    expect(first!.title).toBe(DOCTOR_ALERT_TITLE);
    expect(first!.source).toBe(DOCTOR_ALERT_SOURCE);
    expect(first!.kind).toBe('alert');
    expect(storage.created).toHaveLength(1);

    const second = await maybePostDoctorAlert(storage, report);
    expect(second!.id).toBe(first!.id);
    expect(storage.created).toHaveLength(1);
  });

  test('maybePostDoctorAlert does nothing when there are no errors', async () => {
    const storage = fakeStorage();
    const report = reportWith({ id: 'ok', title: 'Git', status: 'ok' });
    expect(await maybePostDoctorAlert(storage, report)).toBeNull();
    expect(storage.created).toHaveLength(0);
  });

  test('a dismissed identical alert does not suppress a later post', async () => {
    const body = doctorAlertBody(errors);
    const storage = fakeStorage([
      {
        id: 'old',
        created_at: 1,
        source: DOCTOR_ALERT_SOURCE,
        title: DOCTOR_ALERT_TITLE,
        body,
        kind: 'alert',
        dismissed_at: 50,
      },
    ]);
    const posted = await maybePostDoctorAlert(storage, reportWith(errors[0]!));
    expect(posted!.id).not.toBe('old');
    expect(storage.created).toHaveLength(1);
  });
});
