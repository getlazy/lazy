import { describe, test, expect } from 'bun:test';
import { filterRunLog } from '../../src/daemon/builder-run-report';

describe('filterRunLog', () => {
  // INVARIANT: a run report carries every daemon log line about the run —
  // those naming its run id AND those naming any builder id the run has been
  // on (learned from the trail's mapping line), including a dead container's
  // evidence and its continuation lines — plus the launch warmup, and nothing
  // about other runs. The engineer found "nothing in the logs" because lines
  // were keyed by ids nobody searched for.
  test('keeps the run, its builders, their containers and the warmup; drops other runs', () => {
    const log = [
      '2026-09-28T10:00:00.000Z [INFO ] : Launch warmup: ready after 90000ms',
      '2026-09-28T10:01:00.000Z [INFO ] : builder start [run not yet created, builder aaaa1111]: started for m@x (+0ms)',
      '2026-09-28T10:01:00.100Z [INFO ] : builder start [run RUN-1, builder aaaa1111]: run RUN-1 is builder aaaa1111 (container lazy-builder-aaaa1111) (+100ms)',
      '2026-09-28T10:01:02.000Z [INFO ] : builder start [run RUN-2, builder bbbb2222]: docker run took 900ms',
      '2026-09-28T10:05:00.000Z [WARN ] : Builder container lazy-builder-aaaa1111 exited on its own: exit 1',
      'Its output:',
      'Error: boom',
      '2026-09-28T10:06:00.000Z [INFO ] : builder start [run RUN-1, builder cccc3333]: resuming stopped builder session RUN-1',
    ].join('\n');
    const lines = filterRunLog(log, 'RUN-1', 'cccc3333');
    expect(lines.some((l) => l.includes('Launch warmup'))).toBe(true);
    expect(lines.some((l) => l.includes('run not yet created, builder aaaa1111'))).toBe(true);
    expect(lines.some((l) => l.includes('exited on its own') && l.includes('Error: boom'))).toBe(true);
    expect(lines.some((l) => l.includes('cccc3333'))).toBe(true);
    expect(lines.some((l) => l.includes('RUN-2'))).toBe(false);
  });
});
