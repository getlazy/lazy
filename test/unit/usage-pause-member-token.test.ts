/**
 * A Lazy Teams member's TOKEN does not, by itself, let a launch use the
 * one-shot usage-pause override.
 *
 * The Teams CLI proxy relays a bound clone's `lazy start` / `unblock` / … on
 * the member's own user token, whatever shell ran the CLI — a builder's or a
 * script's included. So the daemon reads `usagePauseOverrideEligible` from the
 * body for a user-kind caller exactly as for any other, and never pins it: the
 * CLI sends it only from a person's own terminal, Teams' browser launches send
 * it themselves (src/daemon/usage-pause.ts, `overrideEligible`).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { initDaemonStorage, getOrCreateStorage, closeAllStorage, handleRpc } from '../../src/daemon/rpc-handlers';
import { RpcError } from '../../src/daemon/rpc-error';
import {
  getUsagePauseOverride,
  resetUsagePauseStateForTest,
  setUsagePauseOverride,
  turnSpendCredential,
} from '../../src/daemon/usage-pause';
import { resetUsageReadingsForTest } from '../../src/daemon/usage-readings';
import { daemonUsageLimits } from '../../src/proxy/usage-limits';
import { loadConfig } from '../../src/config/loader';
import { enableInProcessTestMode } from '../helpers/in-process-test-mode';
import { pinConfig } from '../helpers/pin-config';

enableInProcessTestMode();

const MEMBER = { kind: 'user', email: 'ada@example.com', name: 'Ada' } as const;

describe('a member-token launch and the usage-pause override', () => {
  let root: string;
  let taskId: string;
  let unpinConfig: () => void;
  const savedToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;

  beforeEach(async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat-test-member-token';
    resetUsageReadingsForTest();
    resetUsagePauseStateForTest();
    root = await mkdtemp(join(tmpdir(), 'lazy-usage-pause-member-'));
    await writeFile(
      join(root, 'lazy.toml'),
      `[storage]\nbackend = "external"\nexternal_path = "${join(root, 'store')}"\n\n[usage_pause]\nthreshold_percent = 95\n`,
    );
    unpinConfig = pinConfig(root);
    initDaemonStorage(root);
    const storage = await getOrCreateStorage();
    const created = await storage.createTask('Paused start');
    await storage.updateTaskPrompt(created.id, 'Do the work');
    const task = (await storage.getTask(created.id))!;
    taskId = task.id;
    // The credential this task's turn spends, 97% into its 5-hour window.
    const spend = await turnSpendCredential(root, await loadConfig(root), task);
    expect(spend).not.toBeNull();
    const now = Date.now();
    daemonUsageLimits.observeReading({
      credential: spend!.credential, ts: now, upstream: 'https://api.anthropic.com', backend: 'proxy',
      status: 200, taskId: null, model: null,
      headers: {
        'anthropic-ratelimit-unified-5h-utilization': '0.97',
        'anthropic-ratelimit-unified-5h-reset': String(Math.floor(now / 1000) + 3600),
      },
    });
    setUsagePauseOverride(0);
  });

  afterEach(async () => {
    await closeAllStorage();
    unpinConfig();
    resetUsageReadingsForTest();
    resetUsagePauseStateForTest();
    if (savedToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = savedToken;
    await rm(root, { recursive: true, force: true });
  });

  async function start(params: Record<string, unknown>): Promise<unknown> {
    try {
      await handleRpc('startTask', root, { taskId, actor: 'human', ...params }, undefined, MEMBER);
    } catch (err) {
      return err;
    }
    return null;
  }

  // INVARIANT: a member's token is a person, not a person at a terminal. The
  // Teams CLI proxy relays a bound clone's launch on it whatever shell ran the
  // CLI, so without the body's `usagePauseOverrideEligible` the launch neither
  // takes nor names the override — a builder or script in a bound clone spent
  // a person's override and was told the command while the daemon pinned it.
  test('without the flag, a member-token start is refused, and the override is neither used nor named', async () => {
    const err = await start({});
    expect(err).toBeInstanceOf(RpcError);
    expect((err as RpcError).status).toBe(429);
    expect((err as RpcError).message).toContain('paused');
    expect((err as RpcError).message).not.toContain('usage_pause_threshold');
    expect(getUsagePauseOverride()).toBe(0);
  });

  test('with the flag (Teams\' own browser launch), the pause does not stop it', async () => {
    const err = await start({ usagePauseOverrideEligible: true });
    // It may fail later for want of a worktree — but never on the pause, and
    // never before it (a failure there would make this pass for nothing).
    expect(err instanceof RpcError && err.status === 429).toBe(false);
    expect(err instanceof Error ? err.message : '').not.toContain('has no prompt');
  });
});
