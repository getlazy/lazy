import { describe, test, expect } from 'bun:test';
import { TaskMutex } from '../../src/utils/task-mutex';

describe('TaskMutex', () => {
  test('operations on the same key are serialized', async () => {
    const mutex = new TaskMutex();
    const order: string[] = [];

    // INVARIANT: Concurrent async operations on the same key must not interleave.
    // Without serialization, op1 and op2 would both start immediately and their
    // internal steps could interleave at await points.
    const op1 = mutex.withLock('key1', async () => {
      order.push('op1-start');
      await new Promise((r) => setTimeout(r, 50));
      order.push('op1-end');
    });

    const op2 = mutex.withLock('key1', async () => {
      order.push('op2-start');
      await new Promise((r) => setTimeout(r, 10));
      order.push('op2-end');
    });

    await Promise.all([op1, op2]);

    // op1 must complete entirely before op2 starts
    expect(order).toEqual(['op1-start', 'op1-end', 'op2-start', 'op2-end']);
  });

  test('operations on different keys run concurrently', async () => {
    const mutex = new TaskMutex();
    const order: string[] = [];

    const op1 = mutex.withLock('key1', async () => {
      order.push('key1-start');
      await new Promise((r) => setTimeout(r, 50));
      order.push('key1-end');
    });

    const op2 = mutex.withLock('key2', async () => {
      order.push('key2-start');
      await new Promise((r) => setTimeout(r, 10));
      order.push('key2-end');
    });

    await Promise.all([op1, op2]);

    // Both should start before either finishes (key2 finishes first since it's shorter)
    expect(order).toEqual(['key1-start', 'key2-start', 'key2-end', 'key1-end']);
  });

  test('lock is released even if fn throws', async () => {
    const mutex = new TaskMutex();

    // INVARIANT: A throwing operation must not permanently hold the lock.
    await expect(
      mutex.withLock('key1', async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    // Should be able to acquire again
    let ran = false;
    await mutex.withLock('key1', async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  test('return value is propagated', async () => {
    const mutex = new TaskMutex();

    const result = await mutex.withLock('key1', async () => {
      return 42;
    });
    expect(result).toBe(42);
  });

  test('three operations on the same key are serialized in FIFO order', async () => {
    const mutex = new TaskMutex();
    const order: number[] = [];

    const ops = [1, 2, 3].map((i) =>
      mutex.withLock('key1', async () => {
        order.push(i);
        await new Promise((r) => setTimeout(r, 10));
      })
    );

    await Promise.all(ops);
    expect(order).toEqual([1, 2, 3]);
  });
});
