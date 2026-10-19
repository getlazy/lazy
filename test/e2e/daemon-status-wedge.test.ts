/**
 * `/daemon/status` answers even when something under it never does.
 *
 * A Teams project daemon was found whose timers still fired — the reconcile and
 * sync loops logged "previous tick still running" — while `/daemon/status`
 * never answered: every one of the three waited on a dependency that did not
 * settle. The status route and every loop tick read lazy.toml, so a config read
 * that never returns is the shape reproduced here: the file is swapped for a
 * FIFO with no writer, on which `readFile` blocks for ever.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { readFile, rename, rm, writeFile } from 'fs/promises';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import { spawn } from 'bun';

describe('/daemon/status under a wedged dependency', () => {
  let ctx: TestContext;
  let configPath: string;
  let savedConfig: string | null = null;

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
    configPath = join(ctx.root, 'lazy.toml');
  });

  afterEach(async () => {
    if (savedConfig !== null) {
      // Opening the FIFO for writing releases every reader still blocked on it,
      // so the daemon can shut down; then the real file goes back.
      await writeFile(configPath, '').catch(() => {});
      await rm(configPath, { force: true });
      await writeFile(configPath, savedConfig);
      savedConfig = null;
    }
    await ctx.cleanup();
  });

  async function statusPort(): Promise<string> {
    const result = await ctx.lazy(['daemon', 'dashboard-url']);
    expectSuccess(result);
    const port = result.stdout.match(/:(\d+)/)?.[1];
    expect(port).toBeDefined();
    return port!;
  }

  // INVARIANT: /daemon/status answers within a few seconds whatever a step under
  // it is waiting on, and names the step it gave up on. It is the liveness probe:
  // a probe that hangs makes a wedged daemon indistinguishable from a dead one,
  // and that silence is what left a Teams project unrecoverable without a human.
  test('a config read that never returns is reported, not waited on', async () => {
    const port = await statusPort();

    savedConfig = await readFile(configPath, 'utf-8');
    await rename(configPath, `${configPath}.saved`);
    const mk = spawn(['mkfifo', configPath]);
    expect(await mk.exited).toBe(0);
    await rm(`${configPath}.saved`);

    const started = Date.now();
    const response = await fetch(`http://127.0.0.1:${port}/daemon/status`, { signal: AbortSignal.timeout(8_000) });
    const elapsed = Date.now() - started;
    expect(response.ok).toBe(true);
    const payload = await response.json() as { status: string; wedged?: { steps: string[] } };

    expect(payload.status).toBe('running');
    expect(payload.wedged?.steps).toContain('config');
    expect(elapsed).toBeLessThan(5_000);

    // Asked again, the wedged step is not queued a second time behind the
    // first: the answer is just as fast.
    const again = Date.now();
    const second = await fetch(`http://127.0.0.1:${port}/daemon/status`, { signal: AbortSignal.timeout(8_000) });
    expect(second.ok).toBe(true);
    expect(Date.now() - again).toBeLessThan(5_000);
  }, 30_000);
});
