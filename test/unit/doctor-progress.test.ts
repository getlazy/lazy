import { expect, test } from 'bun:test';
import { runDoctorReport } from '../../src/doctor';
import type { ProgressEvent } from '../../src/daemon/progress';

test('doctor emits an ordered plan, phase transitions and explicit project skips', async () => {
  const events: ProgressEvent[] = [];
  const { report } = await runDoctorReport({ root: null, onProgress: event => events.push(event) });
  const plan = events[0];
  expect(plan.kind).toBe('plan');
  if (plan.kind !== 'plan') throw new Error('Missing plan');
  expect(plan.operation).toBe('doctor');
  expect(plan.phases).toHaveLength(8);
  for (const phase of plan.phases) {
    const terminal = events.filter(event => event.kind === 'phase' && event.id === phase.id
      && ['done', 'skipped', 'failed'].includes(event.state));
    expect(terminal).toHaveLength(1);
  }
  expect(events.filter(event => event.kind === 'phase' && event.state === 'skipped')).toHaveLength(4);
  expect(report.checks.length).toBeGreaterThan(0);
});

test('a disconnected progress observer cannot abort doctor', async () => {
  const { report } = await runDoctorReport({ root: null, onProgress: () => { throw new Error('Disconnected'); } });
  expect(report.checks.length).toBeGreaterThan(0);
});
