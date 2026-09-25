/**
 * The CLIENT half of judging a one-shot COMMAND once under [usage_pause]
 * (src/oneshot/index.ts): `admitOneshotCommand` asks the daemon once, and every
 * one-shot call made inside its `run` carries the allowance the daemon returned
 * — including calls made in parallel, as `lazy report`'s map phase makes them.
 * The daemon half (the allowance skipping the per-call gate, the override taken
 * once) is test/unit/usage-pause-beside-launches.test.ts.
 *
 * The daemon transport is the external boundary here, so it is the only thing
 * replaced: a recording `tryRpc`.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { resolve } from 'path';
import { mockModule, restoreMockedModules } from '../helpers/mock-module';

const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
const clientPath = resolve(import.meta.dir, '../../src/daemon/client.ts');
const realClient = await import(clientPath);

await mockModule(clientPath, () => ({
  ...realClient,
  isDaemonRpcBypassed: () => false,
  tryRpc: async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params });
    if (method === 'usagePause') return { oneshotAllowance: 'allowance-1' };
    return { result: 'ok', session_id: 's', usage: { input_tokens: 0, output_tokens: 0 } };
  },
}));

const { admitOneshotCommand, runOneshot } = await import('../../src/oneshot/index');

describe('one-shot command admission', () => {
  beforeAll(() => { calls.length = 0; });
  afterAll(() => restoreMockedModules());

  // INVARIANT: a command of many one-shot calls is judged ONCE. Judged per
  // call, a one-shot override let the first call through and the next was
  // refused mid-command; so the command asks once, and every call inside it —
  // parallel ones included — presents the same allowance.
  test('one admission, and every call inside the command carries its allowance', async () => {
    const req = { prompt: 'p', effort: 'medium' as const, repoAccess: 'read-only' as const };
    const command = await admitOneshotCommand();
    await command.run(async () => {
      await Promise.all([runOneshot(req, '/tmp'), runOneshot(req, '/tmp'), runOneshot(req, '/tmp')]);
      await runOneshot(req, '/tmp');
    });

    expect(calls.filter((c) => c.method === 'usagePause')).toEqual([
      { method: 'usagePause', params: { action: 'admitOneshot' } },
    ]);
    const oneshots = calls.filter((c) => c.method === 'runOneshot');
    expect(oneshots).toHaveLength(4);
    for (const c of oneshots) expect(c.params.usagePauseAllowance).toBe('allowance-1');

    // Outside the command, a call carries nothing and is judged on its own.
    calls.length = 0;
    await runOneshot(req, '/tmp');
    expect(calls[0]?.params.usagePauseAllowance).toBeUndefined();
  });

  // The channel asking is sent, so the daemon never gives an agent's command a
  // person's override.
  test('the asking channel travels with the admission', async () => {
    calls.length = 0;
    await admitOneshotCommand({ actor: 'agent' });
    expect(calls[0]).toEqual({ method: 'usagePause', params: { action: 'admitOneshot', actor: 'agent' } });
  });
});
