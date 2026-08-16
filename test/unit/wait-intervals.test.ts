/**
 * Wait-interval persistence (`src/storage/wait-intervals.ts`).
 *
 * These tests pin the crash-readability contract that the event-structured
 * (start line + end line) layout exists for: an interval whose end never landed
 * must still read back, marked open, rather than vanishing.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, readFile, appendFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  appendWaitStartJsonl,
  appendWaitEndJsonl,
  readWaitIntervalsJsonl,
} from '../../src/storage/wait-intervals';
import type { WaitIntervalStart } from '../../src/storage/wait-intervals';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lazy-wait-intervals-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function start(overrides: Partial<WaitIntervalStart> = {}): WaitIntervalStart {
  return {
    id: 'w1',
    task_id: 'task-1',
    session_id: 'sess-1',
    turn_sequence: 3,
    tool: 'lazy_wait',
    waited_on: ['task-2'],
    waited_on_labels: ['fix-foo'],
    started_at: '2026-08-04T10:00:00.000Z',
    ...overrides,
  };
}

describe('wait intervals JSONL', () => {
  test('missing file reads as no intervals', async () => {
    expect(await readWaitIntervalsJsonl(dir)).toEqual([]);
  });

  test('start + end fold into one closed interval', async () => {
    await appendWaitStartJsonl(dir, start());
    await appendWaitEndJsonl(dir, 'w1', '2026-08-04T10:05:00.000Z', 'completed');

    const intervals = await readWaitIntervalsJsonl(dir);
    expect(intervals).toEqual([
      {
        ...start(),
        ended_at: '2026-08-04T10:05:00.000Z',
        outcome: 'completed',
      },
    ]);
  });

  // INVARIANT: a turn that died mid-wait must be READABLE as such. This is the
  // whole reason the file stores events instead of rewriting rows in place — a
  // consumer subtracting waited time has to be able to see the open interval.
  test('a start with no end reads back open (ended_at: null)', async () => {
    await appendWaitStartJsonl(dir, start());
    const [interval] = await readWaitIntervalsJsonl(dir);
    expect(interval?.ended_at).toBeNull();
    expect(interval?.outcome).toBeNull();
  });

  test('outcome records how the call settled', async () => {
    await appendWaitStartJsonl(dir, start({ id: 'a' }));
    await appendWaitEndJsonl(dir, 'a', '2026-08-04T10:01:00.000Z', 'error');
    const [interval] = await readWaitIntervalsJsonl(dir);
    expect(interval?.outcome).toBe('error');
  });

  // An end whose start was pruned away must not materialize a phantom interval
  // with no beginning — a zero-start row would corrupt any duration sum.
  test('an end with no start is dropped', async () => {
    await appendWaitEndJsonl(dir, 'ghost', '2026-08-04T10:01:00.000Z', 'completed');
    expect(await readWaitIntervalsJsonl(dir)).toEqual([]);
  });

  // A crash mid-append leaves a torn final line. Partial accounting data must
  // never break the readout of everything that landed cleanly.
  test('a torn line is skipped, earlier records still read', async () => {
    await appendWaitStartJsonl(dir, start());
    await appendFile(join(dir, 'waits', 'intervals.jsonl'), '{"kind":"end","id":"w1"', 'utf-8');
    const intervals = await readWaitIntervalsJsonl(dir);
    expect(intervals).toHaveLength(1);
    expect(intervals[0]?.ended_at).toBeNull();
  });

  test('intervals come back in start order', async () => {
    await appendWaitStartJsonl(dir, start({ id: 'a', started_at: '2026-08-04T10:00:00.000Z' }));
    await appendWaitStartJsonl(dir, start({ id: 'b', started_at: '2026-08-04T10:01:00.000Z' }));
    await appendWaitEndJsonl(dir, 'a', '2026-08-04T10:09:00.000Z', 'completed');
    const ids = (await readWaitIntervalsJsonl(dir)).map(i => i.id);
    expect(ids).toEqual(['a', 'b']);
  });

  test('filters by task and by session', async () => {
    await appendWaitStartJsonl(dir, start({ id: 'a', task_id: 't1', session_id: 's1' }));
    await appendWaitStartJsonl(dir, start({ id: 'b', task_id: 't2', session_id: 's2' }));

    expect((await readWaitIntervalsJsonl(dir, { taskId: 't2' })).map(i => i.id)).toEqual(['b']);
    expect((await readWaitIntervalsJsonl(dir, { sessionId: 's1' })).map(i => i.id)).toEqual(['a']);
    expect(await readWaitIntervalsJsonl(dir, { taskId: 'nope' })).toEqual([]);
  });

  test('a wait with no session records null attribution', async () => {
    await appendWaitStartJsonl(dir, start({ session_id: null, turn_sequence: null }));
    const [interval] = await readWaitIntervalsJsonl(dir);
    expect(interval?.session_id).toBeNull();
    expect(interval?.turn_sequence).toBeNull();
  });

  // Pruning drops WHOLE intervals oldest-first: dropping only an interval's end
  // line would leave a dangling record that folds into a phantom.
  test('pruning drops whole intervals, oldest first', async () => {
    const bounds = { triggerBytes: 1200, targetBytes: 600 };
    for (let i = 0; i < 12; i++) {
      const id = `w${i}`;
      await appendWaitStartJsonl(dir, start({ id, task_id: `t${i}` }), bounds);
      await appendWaitEndJsonl(dir, id, '2026-08-04T10:05:00.000Z', 'completed', bounds);
    }

    const intervals = await readWaitIntervalsJsonl(dir);
    expect(intervals.length).toBeGreaterThan(0);
    expect(intervals.length).toBeLessThan(12);
    // Whatever survived kept both of its lines — no half intervals.
    for (const interval of intervals) {
      expect(interval.ended_at).not.toBeNull();
    }
    // The survivors are the newest ones.
    const last = intervals[intervals.length - 1];
    expect(last?.id).toBe('w11');

    const raw = await readFile(join(dir, 'waits', 'intervals.jsonl'), 'utf-8');
    expect(raw.endsWith('\n')).toBe(true);
  });

  test('read surfaces a real error rather than swallowing it', async () => {
    // A directory where the JSONL should be is "found but broken", not "missing".
    await mkdir(join(dir, 'waits', 'intervals.jsonl'), { recursive: true });
    await expect(readWaitIntervalsJsonl(dir)).rejects.toThrow(/Failed to read wait intervals/);
  });
});
