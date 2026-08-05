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

    expect(output()).toContain('accept ab12cd34 — 9 phases');
    expect(output()).toContain(' 1. Branch-protection gate');
    expect(output()).toContain('9. Clean up worktree and children');
  });

  // Optional phases are announced too — a listed phase that is later explicitly
  // skipped is far clearer than one that silently never appears.
  test('optional phases are marked in the announced plan', () => {
    const display = createPhaseDisplay({ tty: false });
    display.onProgress({ kind: 'plan', operation: 'accept', phases: acceptPhasePlan(true) });
    display.close();
    expect(output()).toContain('Pre-accept validation turn (if needed)');
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
