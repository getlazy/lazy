/**
 * INVARIANT: a `withDaemon: true` context is immune to a stray `LAZY_TEST` in
 * the `bun test` process's environment.
 *
 * `process.env` is shared by every test FILE in one `bun test` run, and many
 * suites set `LAZY_TEST=1` on it — `enableInProcessTestMode()` used to do it
 * process-wide and permanently, and a couple of dozen suites still assign it
 * directly in a `beforeEach` without restoring. A daemon-backed context that
 * merely *omitted* the variable inherited whatever was left behind: its CLI
 * children then took the in-process RPC bypass instead of talking to the test
 * daemon, opened storage directly, and deadlocked against the daemon holding
 * `.storage-lock`.
 *
 * The observed shape was six `lazy accept` tests failing inside `createTask`
 * with "Failed to acquire storage lock after 50 attempts" — nothing pointing at
 * the suite that actually set the flag, and every file green when run alone.
 * `setupTestLazy` now pins `LAZY_TEST: ''` for daemon-backed children rather
 * than leaving it to inheritance.
 *
 * This suite poisons `process.env` itself, inside the test, so the guarantee is
 * verified deterministically instead of depending on which file bun happens to
 * schedule first (its order is not the command-line order).
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput } from '../helpers/assertions';

describe('test-mode isolation for daemon-backed suites', () => {
  let ctx: TestContext;
  let priorLazyTest: string | undefined;
  let priorIsDaemon: string | undefined;

  beforeEach(async () => {
    // Snapshot before anything can touch it — this suite deliberately poisons
    // process.env and must not become a leak source itself.
    priorLazyTest = process.env.LAZY_TEST;
    priorIsDaemon = process.env.LAZY_IS_DAEMON;
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    if (priorLazyTest === undefined) delete process.env.LAZY_TEST;
    else process.env.LAZY_TEST = priorLazyTest;
    if (priorIsDaemon === undefined) delete process.env.LAZY_IS_DAEMON;
    else process.env.LAZY_IS_DAEMON = priorIsDaemon;
    await ctx.cleanup();
  });

  test('CLI children still reach the daemon when the parent process has LAZY_TEST=1', async () => {
    // Exactly what a leaking daemonless suite leaves behind.
    process.env.LAZY_TEST = '1';

    // Under the leak this throws "Failed to acquire storage lock after 50
    // attempts": the child bypassed the daemon and tried to open the store the
    // running daemon already holds.
    const created = await ctx.lazy(['create', '--goal', 'poisoned-env-task']);
    expectSuccess(created);

    // And the task is really there afterwards — the create didn't just avoid
    // the lock by doing nothing.
    const list = await ctx.lazy(['list']);
    expectSuccess(list);
    expectOutput(list, 'poisoned-env-task');
  });

  // INVARIANT: a daemon-backed context is also immune to a stray
  // LAZY_IS_DAEMON. `startDaemonServer()` sets it on whatever process calls it,
  // and a dozen e2e suites call that function directly inside `bun test` to
  // drive a real daemon over a unix socket; `stop()` does not unset it. Under
  // the leak, `tryRemoteStorage`/`tryRpc` return null without even looking for a
  // socket ("I am the daemon, never RPC myself"), so every CLI child of a later
  // daemon-backed suite dies with "Daemon is not running" — while
  // `lazy daemon status`, which only reads the pidfile, reports it healthy.
  // Measured: `builder-token-revoke.test.ts mcp.test.ts` together was 24 pass /
  // 45 fail; each file alone 4/0 and 65/0.
  test('CLI children still reach the daemon when the parent process has LAZY_IS_DAEMON=1', async () => {
    // Exactly what an in-process-daemon suite leaves behind.
    process.env.LAZY_IS_DAEMON = '1';

    const created = await ctx.lazy(['create', '--goal', 'daemon-flag-task']);
    // Under the leak this exits 1 with the message below, from requireStorage().
    expect(created.stderr).not.toContain('Daemon is not running');
    expectSuccess(created);

    const list = await ctx.lazy(['list']);
    expectSuccess(list);
    expectOutput(list, 'daemon-flag-task');
  });
});

// Deliberately ONE test. `lazy daemon status` was tried as a second, cheaper
// witness and dropped: it reads the pidfile and reports "running" under the
// leak too, so it passes either way. A regression test that cannot fail is
// worse than no test — it reads as coverage. The storage-lock contention above
// is the discriminating signal, verified by removing the pin and watching this
// suite fail with the incident's own error.
