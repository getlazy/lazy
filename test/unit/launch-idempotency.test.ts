import { describe, test, expect } from 'bun:test';
import { withLaunchIdempotency } from '../../src/daemon/launch-idempotency';
import { launchWithIdempotencyKey, LAUNCH_RETRY_DELAYS_MS } from '../../src/daemon/rpc-fallback';
import { DaemonConnectionLostError } from '../../src/daemon/heartbeat';
import { RpcError } from '../../src/daemon/rpc-error';
import type { Storage } from '../../src/storage';

/** Just the Storage methods the idempotency record touches, in memory. */
function fakeStorage(status = 'blocked'): Storage {
  const meta = new Map<string, string>();
  return {
    resolveTask: async (ref: string) => ({ task: { id: `task-${ref}`, status } }),
    getTask: async (id: string) => ({ id, status }),
    getTaskMetadata: async (_id: string, k: string) => meta.get(k) ?? null,
    updateTaskMetadata: async (_id: string, k: string, v: string) => { meta.set(k, v); },
    getSessionByTaskId: async () => null,
    getSessionTurns: async () => [],
  } as unknown as Storage;
}

describe('withLaunchIdempotency', () => {
  test('two callers using the same key never share a record', async () => {
    // INVARIANT: records are scoped per caller — a member who guesses or reuses
    // another member's key cannot claim it and get that member's launch refused.
    const storage = fakeStorage();
    let runs = 0;
    const launch = async () => ({ n: ++runs });
    await withLaunchIdempotency(storage, 'unblockTask', { taskId: 'a', message: 'mine', actor: { role: 'human', email: 'eve@x' }, idempotencyKey: 'k' }, launch);
    const ivan = await withLaunchIdempotency(storage, 'unblockTask', { taskId: 'a', message: 'other', actor: { role: 'human', email: 'ivan@x' }, idempotencyKey: 'k' }, launch);
    expect(ivan).toEqual({ n: 2 });
  });

  test('a busy refusal is never final, even if turns landed meanwhile', async () => {
    // INVARIANT: a launch refused because the task was working wrote nothing of its
    // own, so the same key may try again once the task is free.
    const storage = fakeStorage('working');
    const params = { taskId: 'b', actor: 'human', idempotencyKey: 'k2' };
    await expect(withLaunchIdempotency(storage, 'resumeTask', params, async () => { throw new RpcError(409, 'still working'); })).rejects.toThrow('still working');
    let ran = false;
    await withLaunchIdempotency(storage, 'resumeTask', params, async () => { ran = true; return {}; });
    expect(ran).toBe(true);
  });
});

describe('withLaunchIdempotency with failuresAreFinal', () => {
  test('a failure is replayed, never re-run', async () => {
    // INVARIANT: reviewAsk writes its question before it can fail, so a repeat of a
    // failed attempt replays the failure instead of posting the question again.
    const storage = fakeStorage();
    const params = { taskId: 'c', content: 'q', actor: 'human', idempotencyKey: 'k3' };
    let runs = 0;
    const failing = async () => { runs++; throw new RpcError(500, 'ask dispatch failed'); };
    await expect(withLaunchIdempotency(storage, 'reviewAsk', params, failing, { failuresAreFinal: true })).rejects.toThrow('ask dispatch failed');
    await expect(withLaunchIdempotency(storage, 'reviewAsk', params, failing, { failuresAreFinal: true })).rejects.toThrow('ask dispatch failed');
    expect(runs).toBe(1);
  });
});

describe('launchWithIdempotencyKey (CLI re-send)', () => {
  test('re-sends a dropped launch with the same key, bounded, and never re-sends a refusal', async () => {
    // INVARIANT: only a lost connection is re-sent, always under the SAME key.
    const original = LAUNCH_RETRY_DELAYS_MS.slice();
    LAUNCH_RETRY_DELAYS_MS.splice(0, LAUNCH_RETRY_DELAYS_MS.length, 0, 0);
    try {
      const keys: string[] = [];
      const ok = await launchWithIdempotencyKey(undefined, async (k) => {
        keys.push(k);
        if (keys.length === 1) throw new DaemonConnectionLostError('unblockTask');
        return 'done';
      });
      expect(ok).toBe('done');
      expect(keys).toHaveLength(2);
      expect(keys[0]).toBe(keys[1]);

      let calls = 0;
      await expect(launchWithIdempotencyKey('fixed', async () => { calls++; throw new DaemonConnectionLostError('x'); })).rejects.toThrow();
      expect(calls).toBe(3);

      calls = 0;
      await expect(launchWithIdempotencyKey('fixed', async () => { calls++; throw new Error('refused'); })).rejects.toThrow('refused');
      expect(calls).toBe(1);
    } finally {
      LAUNCH_RETRY_DELAYS_MS.splice(0, LAUNCH_RETRY_DELAYS_MS.length, ...original);
    }
  });
});
