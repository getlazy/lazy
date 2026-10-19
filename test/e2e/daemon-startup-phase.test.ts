/**
 * A daemon says what it is doing while it starts, and how long each step took.
 *
 * A Teams project start waits on the daemon's task proxy. On a large adopted
 * store the proxy used to come up only after startup migrations had walked the
 * whole store, and the start failed on a fixed deadline with nothing saying
 * why. `/daemon/status` now carries `startup`, and each awaited startup step
 * logs its duration.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import { getDaemonDir } from '../../src/daemon/paths';

describe('daemon startup phase', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: a started daemon reports `startup.complete` on /daemon/status and
  // logs how long each startup step took. A caller waiting on the proxy decides
  // "still making progress" from `startup`, and the timings are how a slow start
  // is diagnosed after the fact.
  test('reports startup progress and logs per-step timings', async () => {
    const urlResult = await ctx.lazy(['daemon', 'dashboard-url']);
    expectSuccess(urlResult);
    const port = urlResult.stdout.match(/:(\d+)/)?.[1];
    expect(port).toBeDefined();

    const response = await fetch(`http://127.0.0.1:${port}/daemon/status`, { signal: AbortSignal.timeout(8_000) });
    expect(response.ok).toBe(true);
    const payload = await response.json() as { startup?: { complete: boolean; phase: string | null; elapsedMs: number } };
    expect(payload.startup?.complete).toBe(true);
    expect(payload.startup?.phase).toBeNull();
    expect(typeof payload.startup?.elapsedMs).toBe('number');

    const dir = getDaemonDir(ctx.root);
    let logs = '';
    for (const name of await readdir(dir)) {
      if (name.endsWith('.log')) logs += await readFile(join(dir, name), 'utf-8');
    }
    expect(logs).toMatch(/Startup: migrating stored attribution across the store took \d+ms/);
    expect(logs).toMatch(/Startup: complete in \d+ms/);
  }, 30_000);
});
