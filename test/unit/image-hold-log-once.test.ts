import { describe, test, expect, afterEach } from 'bun:test';
import { shouldLogImageHold, resetImageHoldLogForTests, runnerImageHold } from '../../src/daemon/runner-image-choice';
import { resetRunnerImageForTests } from '../../src/daemon/runner-image';

const task = { id: 't1' } as any;

describe('held auto-resume logging', () => {
  afterEach(() => { resetImageHoldLogForTests(); resetRunnerImageForTests(); });

  // INVARIANT: a held task is announced once per state change, not every tick. The reconciler offers a held task again every 5 s, which flooded the daemon log on a project whose image cannot build.
  test('logs once, again on a reason change, and per path', () => {
    expect(shouldLogImageHold('a', task, 'building')).toBe(true);
    expect(shouldLogImageHold('a', task, 'building')).toBe(false);
    expect(shouldLogImageHold('b', task, 'building')).toBe(true);
    expect(shouldLogImageHold('a', task, 'failed')).toBe(true);
  });

  // INVARIANT: a release forgets the hold, so a later hold is announced afresh.
  test('a release re-arms the log', async () => {
    expect(shouldLogImageHold('a', task, 'building')).toBe(true);
    expect(await runnerImageHold({ ...task, metadata: {} })).toBeNull();
    expect(shouldLogImageHold('a', task, 'building')).toBe(true);
  });
});

import { refreshBackoffMs, describeRunnerImage } from '../../src/daemon/runner-image';

describe('failed image refresh backoff', () => {
  // INVARIANT: a failing background rebuild backs off exponentially, capped. Each attempt is a full build that can OOM the guest dockerd.
  test('doubles from one minute and caps at an hour', () => {
    expect(refreshBackoffMs(1)).toBe(60_000);
    expect(refreshBackoffMs(2)).toBe(120_000);
    expect(refreshBackoffMs(20)).toBe(3_600_000);
  });

  test('the next retry time is shown with the image state', () => {
    const s = { state: 'ready' as const, imageName: 'x:1', dockerfile: 'D', defaultImage: 'd:1', readyAt: 'r', refreshRetryAt: '2026-10-12T15:00:00.000Z' };
    expect(describeRunnerImage(s)).toContain('2026-10-12T15:00:00.000Z');
  });
});
