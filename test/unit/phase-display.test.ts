/**
 * The CLI half of accept observability: daemon phase events → terminal output.
 *
 * Asserted on the non-TTY (append-only) rendering, which is what pipes, CI logs
 * and e2e assertions see. The TTY rendering differs only in rewriting one line
 * in place; both are driven by the same events.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createPhaseDisplay } from '../../src/cli/phase-display';
import { ACCEPT_PHASES, acceptPhasePlan } from '../../src/daemon/progress';

let lines: string[];
const realLog = console.log;

beforeEach(() => {
  lines = [];
  console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
});

afterEach(() => {
  console.log = realLog;
});

const output = () => lines.join('\n');

describe('createPhaseDisplay (non-TTY)', () => {
  test('the plan is printed up front, numbered, before any phase runs', () => {
    const display = createPhaseDisplay({ tty: false });
    display.onProgress({
      kind: 'plan', operation: 'accept', target: 'ab12cd34',
      phases: acceptPhasePlan(false),
    });
    display.close();

    expect(output()).toContain('accept ab12cd34 — 12 phases');
    expect(output()).toContain(' 1. Branch-protection gate');
    expect(output()).toContain('12. Clean up worktree and children');
  });

  // Optional phases are announced too — a listed phase that is later explicitly
  // skipped is far clearer than one that silently never appears.
  test('optional phases are marked in the announced plan', () => {
    const display = createPhaseDisplay({ tty: false });
    display.onProgress({ kind: 'plan', operation: 'accept', phases: acceptPhasePlan(true) });
    display.close();
    expect(output()).toContain('Acceptance gate (if needed)');
  });

  test('each phase prints a start line and a settle line with its position', () => {
    const display = createPhaseDisplay({ tty: false });
    display.onProgress({ kind: 'plan', operation: 'accept', phases: [ACCEPT_PHASES.merge] });
    display.onProgress({
      kind: 'phase', id: 'merge', label: 'Merge', state: 'start', index: 1, total: 1,
    });
    display.onProgress({
      kind: 'phase', id: 'merge', label: 'Merge', state: 'done', index: 1, total: 1,
      elapsedMs: 2_500, detail: 'merge committed',
    });
    display.close();

    expect(output()).toContain('[1/1] Merge…');
    expect(output()).toContain('[1/1] Merge (2.5s)');
    expect(output()).toContain('merge committed');
  });

  // A start detail says what the phase is ABOUT to do, so it belongs before the
  // ellipsis: `Merge… — a → b` reads as if the arrow were already a result.
  test('a start detail is rendered inside the line, before the ellipsis', () => {
    const display = createPhaseDisplay({ tty: false });
    display.onProgress({
      kind: 'phase', id: 'merge', label: 'Merge', state: 'start', index: 7, total: 9,
      detail: 'lazy/ab12cd34 → main',
    });
    display.close();
    expect(output()).toContain('[7/9] Merge (lazy/ab12cd34 → main)…');
  });

  test('a skipped phase says so, with the reason', () => {
    const display = createPhaseDisplay({ tty: false });
    display.onProgress({
      kind: 'phase', id: 'push-parent', label: 'Push parent branch', state: 'skipped',
      index: 6, total: 10, detail: 'local merge — nothing to push yet',
    });
    display.close();
    expect(output()).toContain('[6/10] Push parent branch');
    expect(output()).toContain('skipped');
    expect(output()).toContain('local merge — nothing to push yet');
  });

  test('a failed phase is marked, so the last thing on screen is where it died', () => {
    const display = createPhaseDisplay({ tty: false });
    display.onProgress({
      kind: 'phase', id: 'merge', label: 'Merge', state: 'failed',
      index: 8, total: 10, elapsedMs: 900, detail: 'merge conflict',
    });
    display.close();
    expect(output()).toContain('[8/10] Merge');
    expect(output()).toContain('merge conflict');
  });

  // A note ('progress') is the interior of a long phase — an image build's
  // docker lines. It must render as a continuation and must NOT settle the
  // phase: the phase's own done/failed line still comes afterwards.
  test('notes print under the running phase without closing it', () => {
    const display = createPhaseDisplay({ tty: false });
    const phase = { kind: 'phase' as const, id: 'launch', label: 'Launch agent', index: 3, total: 4 };
    display.onProgress({ ...phase, state: 'start' });
    display.onProgress({ ...phase, state: 'progress', detail: 'building lazy-agent:0.22.0', elapsedMs: 1_200 });
    display.onProgress({ ...phase, state: 'progress', detail: '#5 exporting layers', elapsedMs: 4_000 });
    display.onProgress({ ...phase, state: 'done', elapsedMs: 9_000, detail: 'lazy-task-abc' });
    display.close();

    expect(output()).toContain('building lazy-agent:0.22.0');
    expect(output()).toContain('#5 exporting layers');
    expect(output()).toContain('(4.0s)');
    expect(output()).toContain('[3/4] Launch agent (9.0s)');
  });

  // REGRESSION: `lazy ask` prints the agent's ANSWER on stdout — a payload
  // someone may pipe. A checklist mixed into it corrupts the answer, so ask
  // renders to stderr.
  test('stream: stderr keeps stdout free of narration', () => {
    const errors: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.join(' ')); };
    try {
      const display = createPhaseDisplay({ tty: false, stream: 'stderr' });
      display.onProgress({
        kind: 'phase', id: 'launch', label: 'Launch agent', state: 'start', index: 2, total: 3,
      });
      display.close();
    } finally {
      console.error = realError;
    }

    expect(errors.join('\n')).toContain('[2/3] Launch agent…');
    expect(lines).toEqual([]);
  });

  // The append-only rendering has no cursor to rewrite, so a long phase would
  // print its start line and then nothing — exactly the silence this display
  // exists to prevent. The daemon's 5s liveness ticks fill that gap.
  describe('heartbeats during a quiet phase', () => {
    /** A display on a clock the test drives, so a 30s silence costs no wall time. */
    function withClock() {
      let clock = 1_000_000;
      const display = createPhaseDisplay({ tty: false, now: () => clock });
      return { display, advance: (ms: number) => { clock += ms; } };
    }

    const startLaunch = (display: ReturnType<typeof withClock>['display']) =>
      display.onProgress({
        kind: 'phase', id: 'launch', label: 'Launch agent', state: 'start', index: 4, total: 4,
      });

    test('a phase that has gone quiet gets a liveness line naming it', () => {
      const { display, advance } = withClock();
      startLaunch(display);
      advance(30_000);
      display.onHeartbeat(30_000, 'Launch agent');
      display.close();

      expect(output()).toContain('[4/4] Launch agent');
      expect(output()).toContain('still running');
      expect(output()).toContain('(30.0s)');
    });

    // A tick that arrives while the screen is still fresh must add nothing —
    // otherwise a fast operation ends up noisier than the silence it replaced.
    test('a fast phase prints no heartbeat line at all', () => {
      const { display, advance } = withClock();
      startLaunch(display);
      advance(500);
      display.onHeartbeat(500, 'Launch agent');
      display.onProgress({
        kind: 'phase', id: 'launch', label: 'Launch agent', state: 'done',
        index: 4, total: 4, elapsedMs: 600,
      });
      display.close();

      expect(output()).not.toContain('still running');
    });

    // Any output resets the quiet clock: a build streaming notes is not silent,
    // and a heartbeat between two notes would just interleave noise.
    test('a note resets the silence, so the next tick is quiet again', () => {
      const { display, advance } = withClock();
      startLaunch(display);
      advance(30_000);
      display.onProgress({
        kind: 'phase', id: 'launch', label: 'Launch agent', state: 'progress',
        index: 4, total: 4, detail: '#5 exporting layers', elapsedMs: 30_000,
      });
      advance(1_000);
      display.onHeartbeat(31_000, 'Launch agent');
      display.close();

      expect(output()).toContain('#5 exporting layers');
      expect(output()).not.toContain('still running');
    });

    // Between phases there is nothing to be alive ON. A stray line there would
    // claim a phase is running after the daemon said it finished.
    test('a tick with no phase open prints nothing', () => {
      const { display, advance } = withClock();
      startLaunch(display);
      display.onProgress({
        kind: 'phase', id: 'launch', label: 'Launch agent', state: 'done',
        index: 4, total: 4, elapsedMs: 1_000,
      });
      advance(30_000);
      display.onHeartbeat(31_000);
      display.close();

      expect(output()).not.toContain('still running');
    });
  });

  // An unplanned prelude (pre-flight runs before the plan is known) must render
  // without a bogus `[0/0]` position.
  test('an unplanned phase renders without a position prefix', () => {
    const display = createPhaseDisplay({ tty: false });
    display.onProgress({
      kind: 'phase', id: 'preflight', label: 'Pre-flight validation', state: 'start',
      index: 0, total: 0,
    });
    display.close();
    expect(output()).toContain('Pre-flight validation…');
    expect(output()).not.toContain('[0/');
  });
});
