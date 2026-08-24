/**
 * JIT credential injection, observed at the launch boundary.
 *
 * INVARIANT: a launched agent process never holds the human's real credential.
 * The daemon mints a per-task placeholder, puts THAT in the agent's
 * environment, and the proxy swaps in the real value on the way upstream — so
 * a container's env, its argv, and anything a prompt-injected agent can read or
 * exfiltrate carry a value that is worthless anywhere but this machine's proxy.
 *
 * This is an assert-the-ABSENCE suite (same shape as
 * test/unit/pair-no-host-home-writes.test.ts): the thing that must not happen
 * has no other test that would fail if it started happening again. Only the
 * fake-binary seam can see this — it is the one seam where a real supervisor
 * really launches a real agent process, so the env it was handed is observable.
 *
 * See public-docs/proxy-jit-credentials.md.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { expectSuccess } from '../helpers/assertions';
import { successScenario } from '../helpers/fake-claude';

/** The credential the test daemon itself holds (test/helpers/setup.ts). */
const DAEMON_CREDENTIAL = 'sk-test-fake-key-for-testing';

describe('agent launches hold a placeholder, not the real credential', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ fakeClaude: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('the agent process is launched with a placeholder credential', async () => {
    const taskId = await createTask(ctx, 'Placeholder credential', 'Do the work');
    await ctx.setClaudeScenario(successScenario({ sessionId: 'fake-sess-cred' }));

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    // Turn invocations only: `--version` probes exit before recording a turn,
    // but they are recorded too, and they carry the same env.
    const invocations = await ctx.claudeInvocations();
    expect(invocations.length).toBeGreaterThan(0);

    const launched = invocations.filter(i => i.env?.ANTHROPIC_API_KEY !== undefined);
    expect(launched.length).toBeGreaterThan(0);

    for (const inv of launched) {
      // THE assertion: the daemon's own credential is not in the agent's env.
      expect(inv.env.ANTHROPIC_API_KEY).not.toBe(DAEMON_CREDENTIAL);
      // What it holds instead is a lazy placeholder, shaped like the real thing
      // so the client accepts it, and redeemable only at lazy's proxy.
      expect(inv.env.ANTHROPIC_API_KEY).toContain('-lazy-');
      // And it is pointed at the proxy, which is the only place that value works.
      expect(inv.env.ANTHROPIC_BASE_URL).toBeDefined();
    }

    // Belt and braces: the real value appears nowhere in the recorded launch —
    // not in the env, not in the argv.
    expect(JSON.stringify(invocations)).not.toContain(DAEMON_CREDENTIAL);
  }, 90_000);
});
