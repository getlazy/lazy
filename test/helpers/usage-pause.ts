/**
 * Set the [usage_pause] one-shot override on a test daemon.
 *
 * NOT through `lazy daemon config set usage_pause_threshold`: that command
 * needs a person at a real terminal (src/cli/commands/daemon-config.ts) —
 * deliberately impossible to drive from a test, because anything a test can
 * drive an agent can drive too. This is the supported substitute: the daemon's
 * own RPC, on the daemon token, as the `human` channel the CLI sends from a
 * terminal. The CLI's refusal paths stay e2e-tested on their own.
 */

import { DaemonClient } from '../../src/daemon/client';
import { getDaemonTcpTarget, readToken } from '../../src/daemon/lifecycle';
import type { TestContext } from './setup';

export async function setUsagePauseOverrideRpc(ctx: TestContext, value: string | number): Promise<void> {
  const target = getDaemonTcpTarget(ctx.root);
  const token = readToken(ctx.root);
  if (!target || !token) throw new Error('setUsagePauseOverrideRpc: the test daemon is not running');
  await DaemonClient.fromTarget(target, token).rpc('usagePause', ctx.root, { action: 'set', value, actor: 'human' });
}

/**
 * Launch as a PERSON AT THEIR OWN TERMINAL would: the `human` channel plus the
 * override eligibility the CLI sends only from a real terminal
 * (src/cli/human-terminal.ts, `usagePauseOverrideEligibility`). A test's CLI has
 * no terminal, so `ctx.lazy(['start', …])` is judged like the builder's shell —
 * it can never take the one-shot override. This is the supported substitute for
 * the person's launch, like `setUsagePauseOverrideRpc` for setting it.
 *
 * A review waits for its report, as `lazy review` does.
 *
 * Returns the CLI's shape — exit code 0 with the result on stdout, or 1 with the
 * daemon's refusal on stderr — so a test's assertions read the same either way.
 */
export async function launchAsPerson(
  ctx: TestContext,
  method: 'startTask' | 'unblockTask' | 'reviewTask' | 'resumeTask',
  params: Record<string, unknown>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const target = getDaemonTcpTarget(ctx.root);
  const token = readToken(ctx.root);
  if (!target || !token) throw new Error('launchAsPerson: the test daemon is not running');
  const client = DaemonClient.fromTarget(target, token);
  try {
    const result = await client.rpc(method, ctx.root, {
      ...params, actor: 'human', usagePauseOverrideEligible: true,
    }) as { taskId?: string; sessionId?: string; turnSequence?: number };
    // `lazy review` waits for the report to land, as its test assertions expect.
    if (method === 'reviewTask' && result.sessionId && typeof result.turnSequence === 'number') {
      await client.rpc('awaitClaimedTurn', ctx.root, {
        taskId: result.taskId, sessionId: result.sessionId, turnSequence: result.turnSequence,
      });
    }
    return { exitCode: 0, stdout: JSON.stringify(result), stderr: '' };
  } catch (err) {
    return { exitCode: 1, stdout: '', stderr: err instanceof Error ? err.message : String(err) };
  }
}
