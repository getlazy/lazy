import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';

/**
 * INVARIANT: a daemon never exists without a model credential — on EVERY path
 * that can bring one up, not just the explicit `lazy daemon start`.
 *
 * A credential-less daemon is worse than no daemon: it comes up, answers RPC,
 * and launches task containers that cannot reach the model API, so tasks spin
 * uselessly instead of failing fast with something the user can act on. That is
 * exactly the state observed live on 2026-07-27 (daemon running, agents dying
 * with "Unable to connect to API"), and these tests are what keep each start
 * path from regressing back into it.
 *
 * The refusal must ALSO surface at the CALLER — a command that auto-started the
 * daemon has to print the gate's actionable message, never proceed silently
 * daemon-less nor leave a half-started daemon behind.
 *
 * These run the real CLI as a subprocess with LAZY_TEST='' (so the production
 * daemon start path actually executes) and HOME pinned to a temp dir (so the
 * developer's real daemon directory is untouched). No daemon ever comes up in
 * this file — every case is a refusal — so it is fast and needs no port.
 */
describe('daemon credential gate — every start path', () => {
  let ctx: TestContext;
  let tmpHome: string;

  beforeEach(async () => {
    ctx = await setupTestLazy();
    tmpHome = await mkdtemp(join(tmpdir(), 'lazy-credgate-'));
  });

  afterEach(async () => {
    await ctx.cleanup();
    await rm(tmpHome, { recursive: true, force: true });
  });

  /** Environment with the daemon start path live and no usable credential. */
  const noCredential = (extra: Record<string, string> = {}) => ({
    HOME: tmpHome,
    LAZY_TEST: '',
    ANTHROPIC_API_KEY: '',
    CLAUDE_CODE_OAUTH_TOKEN: '',
    ...extra,
  });

  /** The gate's message: names the failure and both remedies. */
  function expectGateRefusal(result: { exitCode: number; stderr: string }): void {
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('Daemon refuses to start');
    expect(result.stderr).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(result.stderr).toContain('ANTHROPIC_API_KEY');
  }

  // INVARIANT: AUTO-START is gated too. Any ordinary command auto-starts the
  // daemon before dispatch; without a credential it must fail with the gate's
  // message rather than run daemon-less or spawn a useless daemon.
  test('auto-start from an ordinary command refuses, and the message reaches the caller', async () => {
    const result = await ctx.lazy(['list'], { env: noCredential() });
    expectGateRefusal(result);
  });

  // INVARIANT: the foreground path (which is also what the detached background
  // child runs) enforces the gate in-process.
  test('daemon start --foreground refuses', async () => {
    const result = await ctx.lazy(['daemon', 'start', '--foreground'], {
      env: noCredential(),
    });
    expectGateRefusal(result);
  });

  // INVARIANT: restart pre-flights the gate BEFORE stopping anything. Refusing
  // here (rather than after the stop) is what stops a restart in a
  // credential-less shell from taking down a working daemon with no
  // replacement. The companion test in daemon.test.ts proves a *running* daemon
  // survives this refusal.
  test('daemon restart refuses', async () => {
    const result = await ctx.lazy(['daemon', 'restart'], { env: noCredential() });
    expectGateRefusal(result);
  });

  // INVARIANT: a set-but-BLANK credential counts as absent. This is the shape
  // a failed `export CLAUDE_CODE_OAUTH_TOKEN=$(claude setup-token)` leaves
  // behind, and a presence-only gate waved it through — producing precisely the
  // running-but-useless daemon the gate exists to prevent.
  test('a whitespace-only credential is refused, not accepted', async () => {
    const result = await ctx.lazy(['list'], {
      env: noCredential({ CLAUDE_CODE_OAUTH_TOKEN: '   ' }),
    });
    expectGateRefusal(result);
    expect(result.stderr).toContain('set-but-blank');
  });

  // The gate must not fire when a credential IS present: these paths are on the
  // hot path of every command, so a false refusal would be catastrophic. A fake
  // key is enough — the gate checks presence, never validity (it must not make
  // daemon startup depend on the network; see credential-gate.ts).
  test('a present credential is not refused by the gate', async () => {
    const result = await ctx.lazy(['daemon', 'status'], {
      env: noCredential({ ANTHROPIC_API_KEY: 'sk-ant-fake-for-test' }),
    });
    expect(result.stderr).not.toContain('Daemon refuses to start');
  });
});
