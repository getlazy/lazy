/**
 * Phase progress — the narration layer behind `lazy accept`'s live output.
 *
 * These tests pin the contract three surfaces depend on: the CLI display, the
 * MCP progress relay, and the heartbeat envelope's phase annotation.
 */

import { describe, test, expect } from 'bun:test';
import {
  PhaseReporter,
  describeProgress,
  formatDuration,
  acceptPhasePlan,
  acceptReentryPhasePlan,
  ACCEPT_PHASES,
  type ProgressEvent,
} from '../../src/daemon/progress';

/** A reporter with a controllable clock and a captured event log. */
function harness() {
  const events: ProgressEvent[] = [];
  let clock = 1_000;
  const reporter = new PhaseReporter(e => events.push(e), 'accept', () => clock);
  return {
    events,
    reporter,
    advance(ms: number) { clock += ms; },
  };
}

describe('formatDuration', () => {
  test('sub-second, seconds, and minutes render distinctly', () => {
    expect(formatDuration(120)).toBe('120ms');
    expect(formatDuration(1500)).toBe('1.5s');
    expect(formatDuration(65_000)).toBe('1m05s');
  });
});

describe('PhaseReporter', () => {
  test('announce emits the plan, and phases carry their [n/m] position', () => {
    const h = harness();
    h.reporter.announce([ACCEPT_PHASES.merge, ACCEPT_PHASES.cleanup], 'ab12cd34');
    h.reporter.begin(ACCEPT_PHASES.cleanup);

    expect(h.events[0]).toEqual({
      kind: 'plan',
      operation: 'accept',
      target: 'ab12cd34',
      phases: [ACCEPT_PHASES.merge, ACCEPT_PHASES.cleanup],
    });
    expect(h.events[1]).toMatchObject({ kind: 'phase', id: 'cleanup', index: 2, total: 2, state: 'start' });
  });

  test('end stamps the elapsed time from the reporter clock', () => {
    const h = harness();
    h.reporter.announce([ACCEPT_PHASES.merge]);
    h.reporter.begin(ACCEPT_PHASES.merge);
    h.advance(2_500);
    h.reporter.end('merge committed');

    expect(h.events.at(-1)).toMatchObject({
      state: 'done', elapsedMs: 2_500, detail: 'merge committed',
    });
  });

  // INVARIANT: a phase left open when the next one starts is auto-closed as
  // done. Forgetting an explicit end() must not leave a phase that looks like
  // it never finished — the display would sit on a stale label forever.
  test('begin auto-closes a still-open phase', () => {
    const h = harness();
    h.reporter.announce([ACCEPT_PHASES.description, ACCEPT_PHASES.merge]);
    h.reporter.begin(ACCEPT_PHASES.description);
    h.advance(10);
    h.reporter.begin(ACCEPT_PHASES.merge);

    const states = h.events.filter(e => e.kind === 'phase').map(e => `${e.id}:${e.state}`);
    expect(states).toEqual(['description:start', 'description:done', 'merge:start']);
  });

  // A phase that runs BEFORE the plan is known (pre-flight decides which plan
  // applies) still narrates, with index 0 so nothing renders a bogus position.
  test('an unplanned phase reports with index 0', () => {
    const h = harness();
    h.reporter.begin(ACCEPT_PHASES.preflight);
    expect(h.events[0]).toMatchObject({ id: 'preflight', index: 0, total: 0 });
    expect(describeProgress(h.events[0])).toBe('Pre-flight validation…');
  });

  test('skip records a planned phase that did not run, with the reason', () => {
    const h = harness();
    h.reporter.announce(acceptPhasePlan(false));
    h.reporter.skip(ACCEPT_PHASES.pushParent, 'local merge — nothing to push yet');

    expect(h.events.at(-1)).toMatchObject({
      id: 'push-parent', state: 'skipped', detail: 'local merge — nothing to push yet',
    });
  });

  test('skip on the phase currently open settles it instead of duplicating', () => {
    const h = harness();
    h.reporter.announce(acceptPhasePlan(true));
    h.reporter.begin(ACCEPT_PHASES.preAccept);
    h.advance(5);
    h.reporter.skip(ACCEPT_PHASES.preAccept, 'no agent session to resume');

    const preAccept = h.events.filter(e => e.kind === 'phase' && e.id === 'pre-accept');
    expect(preAccept.map(e => (e as { state: string }).state)).toEqual(['start', 'skipped']);
  });

  test('fail closes the running phase as failed', () => {
    const h = harness();
    h.reporter.announce([ACCEPT_PHASES.merge]);
    h.reporter.begin(ACCEPT_PHASES.merge);
    h.reporter.fail('merge conflict');
    expect(h.events.at(-1)).toMatchObject({ state: 'failed', detail: 'merge conflict' });
  });

  // INVARIANT: narration must never break the operation it narrates. A progress
  // write fails when the client hung up mid-accept; losing the narration of a
  // merge is acceptable, failing the merge is not.
  test('an emitter that throws cannot break the operation', () => {
    const reporter = new PhaseReporter(() => { throw new Error('client gone'); }, 'accept');
    expect(() => {
      reporter.announce([ACCEPT_PHASES.merge]);
      reporter.begin(ACCEPT_PHASES.merge);
      reporter.end();
    }).not.toThrow();
  });

  test('with no emitter the reporter is inert and reports itself inactive', () => {
    const reporter = new PhaseReporter(undefined, 'accept');
    expect(reporter.inactive).toBe(true);
    expect(() => reporter.begin(ACCEPT_PHASES.merge)).not.toThrow();
  });

  test('currentLabel tracks the open phase for heartbeat annotation', () => {
    const h = harness();
    expect(h.reporter.currentLabel()).toBeUndefined();
    h.reporter.begin(ACCEPT_PHASES.merge);
    expect(h.reporter.currentLabel()).toBe('Merge');
    h.reporter.end();
    expect(h.reporter.currentLabel()).toBeUndefined();
  });
});

describe('describeProgress', () => {
  test('renders each phase state as one line', () => {
    const base = { kind: 'phase' as const, id: 'merge', label: 'Merge', index: 8, total: 10 };
    expect(describeProgress({ ...base, state: 'start' })).toBe('[8/10] Merge…');
    expect(describeProgress({ ...base, state: 'done', elapsedMs: 1500, detail: 'ok' }))
      .toBe('[8/10] Merge — done (1.5s) — ok');
    expect(describeProgress({ ...base, state: 'skipped', detail: 'not needed' }))
      .toBe('[8/10] Merge — skipped — not needed');
    expect(describeProgress({ ...base, state: 'failed', elapsedMs: 500 }))
      .toBe('[8/10] Merge — FAILED (500ms)');
  });

  test('renders the plan as an operation summary', () => {
    expect(describeProgress({
      kind: 'plan', operation: 'accept', target: 'ab12cd34',
      phases: [ACCEPT_PHASES.merge, ACCEPT_PHASES.cleanup],
    })).toBe('accept ab12cd34: 2 phases');
  });
});

describe('accept phase plans', () => {
  // INVARIANT: pre-flight is deliberately NOT in the plan — it runs first and
  // is what decides WHICH plan applies, so it is narrated as an unplanned
  // prelude and the plan is announced once it is actually known.
  test('the fresh plan excludes pre-flight and includes pre-accept only when enabled', () => {
    const ids = (enabled: boolean) => acceptPhasePlan(enabled).map(p => p.id);
    expect(ids(false)).not.toContain('preflight');
    expect(ids(false)).not.toContain('pre-accept');
    expect(ids(true)).toContain('pre-accept');
  });

  test('the fresh plan is in execution order and ends with cleanup', () => {
    expect(acceptPhasePlan(true).map(p => p.id)).toEqual([
      'edge-gate', 'pre-accept', 'protection', 'remote-ref', 'merge-gates',
      'push-parent', 'description', 'merge', 'finalize', 'cleanup',
    ]);
  });

  test('the re-entry plan re-runs nothing local', () => {
    expect(acceptReentryPhasePlan().map(p => p.id)).toEqual(['remote-state', 'finalize', 'cleanup']);
  });
});
