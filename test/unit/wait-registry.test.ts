/**
 * Daemon wait registry (`src/daemon/wait-registry.ts`) — the bookkeeping that
 * turns an in-flight blocking MCP call into a live marker plus a durable
 * interval.
 *
 * INVARIANT under test throughout: this is observational bookkeeping, so it must
 * clear on SETTLE (not on response delivery) and must never be able to break the
 * call it observes.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { FileStorage } from '../../src/storage/file-storage';
import type { Storage } from '../../src/storage/interface';
import {
  beginWait,
  endWait,
  activeWaitsFor,
  clearAllWaits,
  trackWait,
  BLOCKING_WAIT_TOOLS,
} from '../../src/daemon/wait-registry';
import { protocolDir, readActiveWaits } from '../../src/protocol';

let lazyRoot: string;
let basePath: string;
let protoBase: string;
let storage: Storage;
let prevProtoBase: string | undefined;

const TASK = 'task-aaaaaaaa';

beforeEach(async () => {
  lazyRoot = await mkdtemp(join(tmpdir(), 'lazy-waitreg-root-'));
  basePath = await mkdtemp(join(tmpdir(), 'lazy-waitreg-store-'));
  protoBase = await mkdtemp(join(tmpdir(), 'lazy-waitreg-proto-'));
  prevProtoBase = process.env.LAZY_PROTOCOL_BASE;
  process.env.LAZY_PROTOCOL_BASE = protoBase;
  const s = new FileStorage(lazyRoot, { basePath });
  await s.initialize();
  storage = s;
});

afterEach(async () => {
  await clearAllWaits();
  await storage.close();
  if (prevProtoBase === undefined) delete process.env.LAZY_PROTOCOL_BASE;
  else process.env.LAZY_PROTOCOL_BASE = prevProtoBase;
  await rm(lazyRoot, { recursive: true, force: true });
  await rm(basePath, { recursive: true, force: true });
  await rm(protoBase, { recursive: true, force: true });
});

describe('wait registry', () => {
  // Only tools whose whole duration is "blocked on another task" count. A
  // non-blocking tool call must not paint the caller as waiting.
  test('blocking tools are exactly the ones that park the caller', () => {
    expect([...BLOCKING_WAIT_TOOLS].sort()).toEqual(['lazy_ask', 'lazy_wait']);
    expect(BLOCKING_WAIT_TOOLS.has('lazy_show')).toBe(false);
  });

  test('begin writes a live marker readers can see', async () => {
    const id = await beginWait({
      storage,
      taskId: TASK,
      tool: 'lazy_wait',
      targets: [{ id: 'task-bbbb', label: 'fix-foo' }],
    });
    expect(id).toBeTruthy();

    const waits = await readActiveWaits(protocolDir(TASK));
    expect(waits).toHaveLength(1);
    expect(waits[0]).toMatchObject({
      id,
      tool: 'lazy_wait',
      targets: ['task-bbbb'],
      labels: ['fix-foo'],
    });
    expect(activeWaitsFor(TASK)).toHaveLength(1);
  });

  test('end clears the marker and closes the durable interval', async () => {
    const id = await beginWait({
      storage,
      taskId: TASK,
      tool: 'lazy_wait',
      targets: [{ id: 'task-bbbb', label: 'fix-foo' }],
    });
    await endWait(storage, TASK, id, 'completed');

    expect(await readActiveWaits(protocolDir(TASK))).toEqual([]);
    expect(activeWaitsFor(TASK)).toEqual([]);

    const intervals = await storage.readWaitIntervals({ taskId: TASK });
    expect(intervals).toHaveLength(1);
    expect(intervals[0]?.ended_at).not.toBeNull();
    expect(intervals[0]?.outcome).toBe('completed');
    expect(intervals[0]?.waited_on).toEqual(['task-bbbb']);
  });

  test('an errored call records outcome=error but still clears', async () => {
    const id = await beginWait({
      storage,
      taskId: TASK,
      tool: 'lazy_ask',
      targets: [{ id: 'task-bbbb', label: 'fix-foo' }],
    });
    await endWait(storage, TASK, id, 'error');
    expect(await readActiveWaits(protocolDir(TASK))).toEqual([]);
    const [interval] = await storage.readWaitIntervals({ taskId: TASK });
    expect(interval?.outcome).toBe('error');
  });

  // Concurrent waits from one session are normal — the marker must show both,
  // and clear only when the LAST one settles.
  test('concurrent waits both show, and the marker clears only on the last', async () => {
    const a = await beginWait({
      storage, taskId: TASK, tool: 'lazy_wait',
      targets: [{ id: 'task-b', label: 'fix-foo' }],
    });
    const b = await beginWait({
      storage, taskId: TASK, tool: 'lazy_wait',
      targets: [{ id: 'task-c', label: 'fix-bar' }],
    });

    expect(await readActiveWaits(protocolDir(TASK))).toHaveLength(2);
    await endWait(storage, TASK, a, 'completed');
    expect(await readActiveWaits(protocolDir(TASK))).toHaveLength(1);
    await endWait(storage, TASK, b, 'completed');
    expect(await readActiveWaits(protocolDir(TASK))).toEqual([]);
  });

  test('end is a no-op for a null or unknown id', async () => {
    await endWait(storage, TASK, null, 'completed');
    await endWait(storage, TASK, 'not-a-wait', 'completed');
    expect(await readActiveWaits(protocolDir(TASK))).toEqual([]);
  });

  // A daemon that stops cleanly must not leave markers behind for readers to
  // disbelieve via the pid check.
  test('clearAllWaits removes every marker this daemon owns', async () => {
    await beginWait({
      storage, taskId: TASK, tool: 'lazy_wait',
      targets: [{ id: 'task-b', label: 'fix-foo' }],
    });
    await clearAllWaits();
    expect(await readActiveWaits(protocolDir(TASK))).toEqual([]);
    expect(activeWaitsFor(TASK)).toEqual([]);
  });

  // INVARIANT: bookkeeping must never break the call it observes. A storage that
  // throws leaves the marker intact and the wait usable.
  test('a failing storage does not break the wait', async () => {
    const broken = {
      getSessionByTaskId: async () => { throw new Error('storage down'); },
      getNextTurnSequence: async () => { throw new Error('storage down'); },
      recordWaitStart: async () => { throw new Error('storage down'); },
      recordWaitEnd: async () => { throw new Error('storage down'); },
    } as unknown as Storage;

    const id = await beginWait({
      storage: broken, taskId: TASK, tool: 'lazy_wait',
      targets: [{ id: 'task-b', label: 'fix-foo' }],
    });
    expect(id).toBeTruthy();
    expect(await readActiveWaits(protocolDir(TASK))).toHaveLength(1);
    await endWait(broken, TASK, id, 'completed');
    expect(await readActiveWaits(protocolDir(TASK))).toEqual([]);
  });

  // INVARIANT (settle, not delivery): the marker exists for exactly the duration
  // of the call and is cleared from the `finally`, so a call whose client
  // disconnected — the daemon finishes it anyway — still clears.
  test('trackWait marks the caller for the duration of the call and clears after', async () => {
    let midCall: number | undefined;
    const result = await trackWait(
      { storage, taskId: TASK, tool: 'lazy_wait', targets: [{ id: 'task-b', label: 'fix-foo' }] },
      async () => {
        midCall = (await readActiveWaits(protocolDir(TASK))).length;
        return 'tool result';
      },
    );

    expect(result).toBe('tool result');
    expect(midCall).toBe(1);
    expect(await readActiveWaits(protocolDir(TASK))).toEqual([]);
    const [interval] = await storage.readWaitIntervals({ taskId: TASK });
    expect(interval?.outcome).toBe('completed');
  });

  test('trackWait clears and records error when the tool throws, and rethrows', async () => {
    await expect(
      trackWait(
        { storage, taskId: TASK, tool: 'lazy_wait', targets: [{ id: 'task-b', label: 'fix-foo' }] },
        async () => { throw new Error('tool blew up'); },
      ),
    ).rejects.toThrow('tool blew up');

    expect(await readActiveWaits(protocolDir(TASK))).toEqual([]);
    const [interval] = await storage.readWaitIntervals({ taskId: TASK });
    expect(interval?.outcome).toBe('error');
    expect(interval?.ended_at).not.toBeNull();
  });

  // A wait that begins and never ends (daemon SIGKILLed) leaves an OPEN durable
  // interval — the documented "died mid-wait" shape.
  test('a wait that never settles stays open in storage', async () => {
    await beginWait({
      storage, taskId: TASK, tool: 'lazy_wait',
      targets: [{ id: 'task-b', label: 'fix-foo' }],
    });
    const [interval] = await storage.readWaitIntervals({ taskId: TASK });
    expect(interval?.ended_at).toBeNull();
    expect(interval?.outcome).toBeNull();
  });
});
