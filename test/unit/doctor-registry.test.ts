import { describe, expect, test } from 'bun:test';
import {
  buildReport,
  checkIdFromLabel,
  runChecks,
  statusOf,
  toStructuredCheck,
  type CheckResult,
  type DoctorCheck,
} from '../../src/doctor';

/**
 * The registry/runner contract: named checks, async run, throw → error
 * result, JSON-able report. The production sweep has extra gating but
 * produces the same DoctorReport shape via toStructuredCheck / buildReport.
 */

describe('doctor registry', () => {
  test('statusOf maps ok / warning / error', () => {
    expect(statusOf({ ok: true, label: 'fine' })).toBe('ok');
    expect(statusOf({ ok: true, label: 'fine', warning: 'heads-up' })).toBe('warning');
    expect(statusOf({ ok: false, label: 'broken', detail: 'nope' })).toBe('error');
  });

  test('checkIdFromLabel slugs a title', () => {
    expect(checkIdFromLabel('No missing task runs')).toBe('no-missing-task-runs');
    expect(checkIdFromLabel('  !!!  ')).toBe('check');
  });

  test('toStructuredCheck strips ANSI and prefers failure detail', () => {
    const result: CheckResult = {
      ok: false,
      label: 'Docker running',
      detail: '\u001b[36mdocker start\u001b[0m then retry',
      docs: 'troubleshooting-daemon',
      remedyFlag: 'clean-docker-images',
    };
    const structured = toStructuredCheck(result, { id: 'docker-running', title: 'Docker running' });
    expect(structured.status).toBe('error');
    expect(structured.detail).toBe('docker start then retry');
    expect(structured.detail).not.toContain('\u001b');
    expect(structured.remedyFlag).toBe('clean-docker-images');
    expect(structured.remedy).toBe('lazy doctor --clean-docker-images');
    if (structured.docs) expect(structured.docs).toContain('troubleshooting');
  });

  test('runChecks runs named checks in order and skips null', async () => {
    const seen: string[] = [];
    const checks: DoctorCheck<{ n: number }>[] = [
      {
        id: 'one',
        title: 'First',
        run: async (ctx) => {
          seen.push(`one:${ctx.n}`);
          return { ok: true, label: 'First' };
        },
      },
      {
        id: 'gated',
        title: 'Gated',
        run: async () => null,
      },
      {
        id: 'two',
        title: 'Second',
        run: async () => ({ ok: true, label: 'Second', warning: 'soft' }),
      },
    ];

    const report = await runChecks(checks, { n: 7 }, { root: '/tmp/proj' });
    expect(seen).toEqual(['one:7']);
    expect(report.root).toBe('/tmp/proj');
    expect(report.checks.map(c => c.id)).toEqual(['one', 'two']);
    expect(report.checks[1]!.status).toBe('warning');
    expect(report.errorCount).toBe(0);
    expect(report.warningCount).toBe(1);
    // JSON-able: no functions, no circular refs.
    expect(() => JSON.stringify(report)).not.toThrow();
  });

  // INVARIANT: one broken check cannot cancel the rest of the sweep. A throw
  // becomes an error-status result naming that check, and later checks still run.
  test('a thrown check becomes an error and the rest still run', async () => {
    const checks: DoctorCheck<Record<string, never>>[] = [
      {
        id: 'boom',
        title: 'Explodes',
        run: async () => {
          throw new Error('probe hung');
        },
      },
      {
        id: 'after',
        title: 'After',
        run: async () => ({ ok: true, label: 'After' }),
      },
    ];

    const report = await runChecks(checks, {});
    expect(report.checks).toHaveLength(2);
    expect(report.checks[0]).toMatchObject({
      id: 'boom',
      title: 'Explodes',
      status: 'error',
      detail: 'probe hung',
    });
    expect(report.checks[1]!.id).toBe('after');
    expect(report.errorCount).toBe(1);
  });

  test('buildReport counts statuses', () => {
    const report = buildReport({
      root: null,
      checks: [
        { id: 'a', title: 'A', status: 'ok' },
        { id: 'b', title: 'B', status: 'warning' },
        { id: 'c', title: 'C', status: 'error' },
        { id: 'd', title: 'D', status: 'error' },
      ],
    });
    expect(report.errorCount).toBe(2);
    expect(report.warningCount).toBe(1);
    expect(report.missingRuns).toEqual([]);
  });
});
