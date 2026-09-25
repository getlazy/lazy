/**
 * The in-memory container-start registry — the thing that makes "one start in
 * flight, shared" true.
 *
 * Watch, Shell, Pair and Chat all bring the container up themselves now, so two
 * panels opened in the same second, or a double-clicked button, must attach to
 * ONE launch rather than racing two `docker run`s at the same task. That is a
 * property of this registry, so it is tested here with a stub action port rather
 * than through the web routes, where a real start's timing is not controllable.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import {
  beginContainerStart,
  getContainerStart,
  containerStartJson,
  resetContainerStarts,
  startContainerHtml,
  NO_CONTAINER_CONTROLS,
} from '../../src/server/container-start';
import type { TaskActions } from '../../src/server/task-actions';

/** A TaskActions with only `ensureContainer` real — the one method used here. */
function stubActions(
  impl: (taskId: string, onProgress?: (detail: string) => void) => Promise<{
    containerName: string;
    alreadyRunning: boolean;
  }>,
): { actions: TaskActions; calls: () => number } {
  let calls = 0;
  const actions = {
    ensureContainer: (taskId: string, onProgress?: (detail: string) => void) => {
      calls++;
      return impl(taskId, onProgress);
    },
  } as unknown as TaskActions;
  return { actions, calls: () => calls };
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('beginContainerStart', () => {
  beforeEach(() => resetContainerStarts());

  // INVARIANT: one start in flight per task, shared. Every panel that wants the
  // container calls this; a second launch for the same task is a bug, not a
  // retry — two `docker run`s at one task is exactly what it must not produce.
  test('a second call while a start is in flight joins it instead of launching again', async () => {
    const gate = deferred<{ containerName: string; alreadyRunning: boolean }>();
    const { actions, calls } = stubActions(() => gate.promise);

    const first = beginContainerStart('task-1', actions);
    const second = beginContainerStart('task-1', actions);

    expect(second).toBe(first);
    expect(second.startedAt).toBe(first.startedAt);
    expect(calls()).toBe(1);

    gate.resolve({ containerName: 'lazy-task-1', alreadyRunning: false });
    await gate.promise;
    await Promise.resolve();
  });

  test('two different tasks each get their own start', () => {
    const { actions, calls } = stubActions(() => new Promise(() => {}));
    const a = beginContainerStart('task-1', actions);
    const b = beginContainerStart('task-2', actions);
    expect(b).not.toBe(a);
    expect(calls()).toBe(2);
  });

  test('progress narration replaces the detail line — a status, not a log', async () => {
    const gate = deferred<{ containerName: string; alreadyRunning: boolean }>();
    let emit: ((detail: string) => void) | undefined;
    const { actions } = stubActions((_id, onProgress) => {
      emit = onProgress;
      return gate.promise;
    });

    const state = beginContainerStart('task-1', actions);
    expect(state.detail).toBe('Starting the container…');
    emit?.('Resolving image…');
    expect(state.detail).toBe('Resolving image…');
    emit?.('  Building image  ');
    expect(state.detail).toBe('Building image');
    // A blank line from the build's output must not wipe the last real line.
    emit?.('   ');
    expect(state.detail).toBe('Building image');

    gate.resolve({ containerName: 'lazy-task-1', alreadyRunning: false });
    await gate.promise;
  });

  test('a finished start settles to done, naming the container', async () => {
    const { actions } = stubActions(async () => ({ containerName: 'lazy-task-1', alreadyRunning: false }));
    const state = beginContainerStart('task-1', actions);
    await Promise.resolve();
    await Promise.resolve();
    expect(state.phase).toBe('done');
    expect(state.detail).toContain('lazy-task-1');
    expect(getContainerStart('task-1')?.phase).toBe('done');
  });

  test('an already-running container settles to done too, and says so', async () => {
    const { actions } = stubActions(async () => ({ containerName: 'lazy-task-1', alreadyRunning: true }));
    const state = beginContainerStart('task-1', actions);
    await Promise.resolve();
    await Promise.resolve();
    expect(state.phase).toBe('done');
    expect(state.detail).toBe('The container was already running.');
  });

  test('a failed start keeps the daemon message verbatim — it is written for a human', async () => {
    const { actions } = stubActions(async () => {
      throw new Error('Docker is not running. Start Docker Desktop and try again.');
    });
    const state = beginContainerStart('task-1', actions);
    await Promise.resolve();
    await Promise.resolve();
    expect(state.phase).toBe('failed');
    expect(state.error).toBe('Docker is not running. Start Docker Desktop and try again.');
  });

  // A settled start is not in flight, so the next panel that asks may launch:
  // otherwise a failure would wedge the task until the TTL expired.
  test('after a failure the next call launches again', async () => {
    const { actions, calls } = stubActions(async () => {
      throw new Error('nope');
    });
    beginContainerStart('task-1', actions);
    await Promise.resolve();
    await Promise.resolve();
    beginContainerStart('task-1', actions);
    expect(calls()).toBe(2);
  });
});

describe('containerStartJson', () => {
  beforeEach(() => resetContainerStarts());

  // The polling shape a panel reads. `idle` is the one phase with no HTML
  // equivalent: nothing recorded, which for a client already waiting means the
  // start finished and its record aged out.
  test('no recorded start is idle', () => {
    expect(containerStartJson(null)).toEqual({ phase: 'idle', detail: '' });
  });

  test('an in-flight start carries its phase, detail and start time', () => {
    const { actions } = stubActions(() => new Promise(() => {}));
    const json = containerStartJson(beginContainerStart('task-1', actions));
    expect(json.phase).toBe('starting');
    expect(json.detail).toBe('Starting the container…');
    expect(typeof json.startedAt).toBe('number');
    expect(json.error).toBeUndefined();
  });

  test('a failure carries the error text', async () => {
    const { actions } = stubActions(async () => {
      throw new Error('no docker');
    });
    beginContainerStart('task-1', actions);
    await Promise.resolve();
    await Promise.resolve();
    expect(containerStartJson(getContainerStart('task-1'))).toMatchObject({
      phase: 'failed',
      error: 'no docker',
    });
  });
});

describe('startContainerHtml', () => {
  beforeEach(() => resetContainerStarts());

  // INVARIANT: the button is a REMEDY, not the normal route. Panels start the
  // container themselves; this renders only where a page has actually
  // established the container is down and offered `canStart`.
  test('nothing is rendered when the page cannot honestly offer a start', () => {
    expect(startContainerHtml('task-1', NO_CONTAINER_CONTROLS)).toBe('');
  });

  test('an in-flight start replaces the button with its own progress line', () => {
    const { actions } = stubActions(() => new Promise(() => {}));
    const start = beginContainerStart('task-1', actions);
    const html = startContainerHtml('task-1', { canStart: true, start });
    expect(html).toContain('Starting the container');
    expect(html).not.toContain('<button');
    expect(html).toContain('http-equiv="refresh"');
    expect(startContainerHtml('task-1', { canStart: true, start }, { refresh: false })).not.toContain(
      'http-equiv="refresh"',
    );
  });

  test('a failed start shows the button again, with the failure beside it', async () => {
    const { actions } = stubActions(async () => {
      throw new Error('Docker is not running.');
    });
    beginContainerStart('task-1', actions);
    await Promise.resolve();
    await Promise.resolve();
    const html = startContainerHtml('task-1', { canStart: true, start: getContainerStart('task-1') });
    expect(html).toContain('/tasks/task-1/container/start');
    expect(html).toContain('Docker is not running.');
  });
});
