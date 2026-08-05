/**
 * `lazy doctor` credential check — WHOSE environment it reports on.
 *
 * INVARIANT: the daemon is the credential owner. Every agent inherits the
 * DAEMON's environment, so the credential check must ask the daemon and must
 * never present the CLI process's own env as the answer. Reading `process.env`
 * was wrong in both directions: a daemon-only-env deployment reported "not
 * authenticated" while everything worked, and a stale token in the user's shell
 * reported healthy auth the daemon did not have.
 *
 * These tests need a REAL daemon (withDaemon: true) — under LAZY_TEST the RPC
 * is bypassed by design and only the degraded path is reachable (that one is
 * covered in doctor.test.ts).
 */

import { describe, test, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectOutput, expectOutputExcludes } from '../helpers/assertions';

describe('lazy doctor — credential source', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    // Pin the daemon's credential to ANTHROPIC_API_KEY: the developer running
    // the suite may well have CLAUDE_CODE_OAUTH_TOKEN exported, which would
    // otherwise win precedence inside the daemon and make the source label
    // machine-dependent.
    ctx = await setupTestLazy({
      withDaemon: true,
      daemonEnv: { CLAUDE_CODE_OAUTH_TOKEN: '' },
    });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('reports authenticated when only the daemon holds a credential', async () => {
    const result = await ctx.lazy(['doctor'], {
      // The user's shell has nothing — the daemon-only-env deployment.
      env: { ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '' },
    });

    expectOutput(result, 'Model credential present (daemon env: ANTHROPIC_API_KEY)');
    // No caveat: the daemon answered, so nothing was read from this shell.
    expectOutputExcludes(result, 'shell env:');
  });

  test('reports what the DAEMON sees, not a different credential in the shell', async () => {
    const result = await ctx.lazy(['doctor'], {
      // A stale OAuth token in the user's shell. It takes precedence over
      // ANTHROPIC_API_KEY locally, so if doctor were reading this process's env
      // it would say "CLAUDE_CODE_OAUTH_TOKEN" — the daemon has no such token.
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-stale-shell-token' },
    });

    expectOutput(result, 'Model credential present (daemon env: ANTHROPIC_API_KEY)');
    expectOutputExcludes(result, 'daemon env: CLAUDE_CODE_OAUTH_TOKEN');
    expectOutputExcludes(result, 'shell env:');
  });
});
