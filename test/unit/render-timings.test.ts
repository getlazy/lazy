import { describe, test, expect } from 'bun:test';
import {
  RenderTimings,
  SERVER_TIMING_HEADER,
  TIMING_LOG_PREFIX,
  unmeasured,
} from '../../src/server/render-timings';

/**
 * The measurement helper behind the daemon's page instrumentation.
 *
 * Two things are load-bearing and tested here rather than through a page:
 * phases NEST (so a header reads as a tree — `render.changes` is inside
 * `render` — and a phase's own time is never attributed to its sibling), and
 * the header is VALID `Server-Timing` (it now ships on every page render, so a
 * malformed one would be a permanent defect in every response).
 */
describe('RenderTimings phases', () => {
  test('a phase opened inside another is keyed by its ancestors', async () => {
    const timings = new RenderTimings('/review/:id');
    await timings.measure('render', async () => {
      await timings.measure('changes', async () => {
        timings.measureSync('rows', () => 1);
      });
    });

    expect(timings.phases().map((p) => p.name)).toEqual([
      'render.changes.rows',
      'render.changes',
      'render',
    ]);
  });

  test('a nested phase never outlasts the parent that contains it', async () => {
    const timings = new RenderTimings('/review/:id');
    await timings.measure('parent', async () => {
      await timings.measure('child', () => Bun.sleep(15));
      await Bun.sleep(15);
    });

    const byName = new Map(timings.phases().map((p) => [p.name, p.ms]));
    const parent = byName.get('parent') ?? 0;
    const child = byName.get('parent.child') ?? 0;
    expect(child).toBeGreaterThan(0);
    expect(parent).toBeGreaterThanOrEqual(child);
  });

  // The bug this guards: if `end()` did not truncate the stack back to its own
  // parent, the phase AFTER a nested one would inherit the nested prefix and be
  // reported as `storage.turns.serve` — time attributed to the wrong subtree.
  test('a sibling opened after a nested phase closes is not prefixed by it', () => {
    const timings = new RenderTimings('/tasks/:id');
    const storage = timings.begin('storage');
    timings.measureSync('turns', () => 1);
    storage.end();
    timings.measureSync('serve', () => 1);

    expect(timings.phases().map((p) => p.name)).toEqual(['storage.turns', 'storage', 'serve']);
  });

  test('the same phase entered twice accumulates instead of overwriting', async () => {
    const timings = new RenderTimings('/review/:id');
    await timings.measure('diff_parse', () => Bun.sleep(10));
    await timings.measure('diff_parse', () => Bun.sleep(10));

    const parses = timings.phases().filter((p) => p.name === 'diff_parse');
    expect(parses).toHaveLength(1);
    // Two 10ms sleeps summed: comfortably over one of them, which is what
    // distinguishes accumulation from last-write-wins.
    expect(parses[0].ms).toBeGreaterThan(15);
  });

  test('end() is idempotent, so a double close records one duration', () => {
    const timings = new RenderTimings('/tasks');
    const phase = timings.begin('render');
    phase.end();
    const afterFirst = timings.phases()[0].ms;
    phase.end();
    expect(timings.phases()).toHaveLength(1);
    expect(timings.phases()[0].ms).toBe(afterFirst);
  });

  test('a phase whose work throws is still closed and still measured', async () => {
    const timings = new RenderTimings('/review/:id');
    await expect(
      timings.measure('diff', async () => {
        throw new Error('no worktree');
      }),
    ).rejects.toThrow('no worktree');
    // Closed, so the next phase is a sibling rather than a child of the failure.
    timings.measureSync('render', () => 1);

    expect(timings.phases().map((p) => p.name)).toEqual(['diff', 'render']);
  });

  test('finish() freezes the total so the header and the log line agree', async () => {
    const timings = new RenderTimings('/tasks');
    await Bun.sleep(10);
    timings.finish();
    const frozen = /total;dur=([\d.]+)/.exec(timings.header())?.[1];
    await Bun.sleep(20);

    expect(frozen).toBeDefined();
    expect(/total;dur=([\d.]+)/.exec(timings.header())?.[1]).toBe(frozen);
    expect(timings.logLine()).toContain(`total=${frozen}ms`);
  });
});

describe('RenderTimings Server-Timing header', () => {
  test('leads with total, then phases as durations and counts as descriptions', () => {
    const timings = new RenderTimings('/review/:id');
    timings.measureSync('diff', () => 1);
    timings.count('diff_files', 1843);
    timings.count('diff_bytes', 12_400_000);
    timings.finish();

    const metrics = timings.header().split(', ');
    expect(metrics[0]).toMatch(/^total;dur=\d+\.\d$/);
    expect(metrics[1]).toMatch(/^diff;dur=\d+\.\d$/);
    // Counts are NOT durations: 1843 files published as `dur` would draw a
    // 1.8-second bar in dev tools for work that took no time at all.
    expect(metrics.slice(2)).toEqual(['diff_files;desc="1843"', 'diff_bytes;desc="12400000"']);
  });

  test('every metric name is a valid Server-Timing token', () => {
    const timings = new RenderTimings('/review/:id');
    timings.measureSync('render changes', () => 1);
    timings.count('diff;bytes', 10);
    timings.finish();

    for (const metric of timings.header().split(', ')) {
      const [name] = metric.split(';');
      expect(name).toMatch(/^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/);
    }
    expect(timings.header()).toContain('render_changes;dur=');
    expect(timings.header()).toContain('diff_bytes;desc="10"');
  });

  test('a count recorded twice reports the last value, once', () => {
    const timings = new RenderTimings('/review/:id');
    timings.count('diff_files', 3);
    timings.count('diff_files', 1843);
    timings.finish();

    const metrics = timings.header().split(', ').filter((m) => m.startsWith('diff_files;'));
    expect(metrics).toEqual(['diff_files;desc="1843"']);
  });

  test('the header name is the one browsers read', () => {
    expect(SERVER_TIMING_HEADER).toBe('Server-Timing');
  });
});

describe('RenderTimings log line', () => {
  test('carries the route and the same numbers the header does', () => {
    const timings = new RenderTimings('/review/:id');
    timings.measureSync('diff', () => 1);
    timings.measureSync('render', () => timings.measureSync('changes', () => 1));
    timings.count('diff_files', 1843);
    timings.finish();

    const line = timings.logLine();
    expect(line.startsWith(`${TIMING_LOG_PREFIX} route=/review/:id`)).toBe(true);
    expect(line).toContain('total=');
    expect(line).toContain('diff=');
    expect(line).toContain('render.changes=');
    expect(line).toContain('diff_files=1843');
    // One line — a multi-line log entry is not greppable as one record.
    expect(line).not.toContain('\n');
  });
});

describe('unmeasured()', () => {
  // The HTML renderers take their timings as an optional argument so ~40
  // existing unit tests can keep calling them positionally. This is what they
  // get instead of a null check at every block.
  test('accepts every call a measured render makes and reads back as usual', async () => {
    const timings = unmeasured();
    const phase = timings.begin('render');
    expect(timings.measureSync('changes', () => 'html')).toBe('html');
    expect(await timings.measure('diff', async () => 7)).toBe(7);
    phase.end();
    timings.count('diff_files', 2);
    timings.finish();

    expect(timings.header()).toContain('render.changes;dur=');
    expect(timings.logLine()).toContain('route=unmeasured');
  });
});
