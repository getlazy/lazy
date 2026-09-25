/**
 * INVARIANT: the log tail a crash turn shows is bounded AND made of whole
 * lines. It was `slice(-10).join('\n').substring(0, 500)`: five supervisor
 * lines, cut mid-character, which the fifth Mac run of the fleet demo surfaced
 * as a crash turn whose "Logs:" ended in half a timestamp — indistinguishable,
 * to the human, from the container's own log being truncated. When the budget
 * is exceeded the oldest lines go, and the cut is marked.
 */

import { describe, test, expect } from 'bun:test';
import { crashLogTail, CRASH_LOG_TAIL_CHARS, CRASH_LOG_TAIL_LINES } from '../../src/utils/reconcile';

const line = (i: number) => `2026-09-21T12:27:0${i % 10}.418Z [INFO ] : [supervisor] line ${i} ${'x'.repeat(60)}`;

describe('crashLogTail', () => {
  test('keeps the last lines whole when they fit', () => {
    const logs = Array.from({ length: 6 }, (_, i) => line(i)).join('\n');
    expect(crashLogTail(logs)).toBe(logs);
  });

  test('never cuts inside a line: the oldest lines go first, and the cut is marked', () => {
    const logs = Array.from({ length: 40 }, (_, i) => line(i) + 'y'.repeat(200)).join('\n');
    const tail = crashLogTail(logs);
    const shown = tail.split('\n');
    expect(shown[0]).toMatch(/^…\[\d+ earlier lines? not shown\]$/);
    expect(shown.length - 1).toBeLessThanOrEqual(CRASH_LOG_TAIL_LINES);
    expect(tail.length - shown[0]!.length - 1).toBeLessThanOrEqual(CRASH_LOG_TAIL_CHARS);
    // Every shown line is a complete original line.
    for (const l of shown.slice(1)) expect(logs.split('\n')).toContain(l);
    expect(shown[shown.length - 1]).toBe(line(39) + 'y'.repeat(200));
  });

  test('a single enormous line is cut, and says so', () => {
    const tail = crashLogTail('z'.repeat(5000));
    expect(tail.length).toBeLessThan(5000);
    expect(tail).toContain(`…[line cut at ${CRASH_LOG_TAIL_CHARS} chars]`);
  });

  test('the five-line shape that reached the fifth Mac run is now shown whole', () => {
    const real = [
      '2026-09-21T12:27:01.418Z [INFO ] : [supervisor] Starting. Protocol dir: /root/.lazy/protocol/c2d7ef3e-e68a-4d4e-850c-8f1d94c0c859',
      '2026-09-21T12:27:01.418Z [INFO ] : [supervisor] Worktree: /lazy/projects/lazy-demo-shop-2/repo/.lazy/worktrees/demo-describe',
      '2026-09-21T12:27:01.418Z [INFO ] : [supervisor] Runner: docker',
      '2026-09-21T12:27:01.418Z [INFO ] : [supervisor] Running in one-shot mode (will exit after one command)',
      '2026-09-21T12:27:01.420Z [INFO ] : [supervisor] Found git ✓',
      '2026-09-21T12:27:01.421Z [INFO ] : [supervisor] Found claude ✓',
    ].join('\n');
    expect(crashLogTail(real)).toBe(real);
  });
});
