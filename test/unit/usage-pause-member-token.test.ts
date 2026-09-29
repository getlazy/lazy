/**
 * The per-task usage-pause allowance ("let this task's next turn through"),
 * reached the way every surface reaches it — the daemon's RPC.
 *
 * Engineer decision 2026-09-26: the way past a pause is PER TASK, and a person
 * or the builder may take it, on every surface; a task agent never. A Lazy
 * Teams member's TOKEN is a person, so a member's launch may carry it
 * (`usagePausePastOnce`); the daemon-wide one-shot override no longer lets a
 * task's launch through at all (src/daemon/usage-pause.ts).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { initDaemonStorage, getOrCreateStorage, closeAllStorage, handleRpc } from '../../src/daemon/rpc-handlers';
import { RpcError } from '../../src/daemon/rpc-error';
import {
  getUsagePauseOverride,
  taskUsagePauseAllowance,
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

describe('the per-task usage-pause allowance', () => {
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

  async function rpc(command: string, params: Record<string, unknown>, caller?: typeof MEMBER): Promise<unknown> {
    try {
      await handleRpc(command, root, params, undefined, caller);
    } catch (err) {
      return err;
    }
    return null;
  }
  const start = (params: Record<string, unknown>) => rpc('startTask', { taskId, actor: 'human', ...params }, MEMBER);
  const isPauseRefusal = (err: unknown) => err instanceof RpcError && err.status === 429;

  // INVARIANT: the daemon-wide one-shot override never lets a TASK's launch
  // through — a value any launch could spend was spent by a stray launch on
  // another task. It stays pending for a launch beside any task.
  test('a paused start is refused, the daemon-wide override is left unused, and the refusal names the task\'s way through', async () => {
    const err = await start({});
    expect(isPauseRefusal(err)).toBe(true);
    expect((err as RpcError).message).toContain('--past-usage-pause');
    expect(getUsagePauseOverride()).toBe(0);
  });

  // INVARIANT: a launch that carries the allowance goes past the pause, and
  // leaves nothing pending behind it whether it used it or not.
  test('a member\'s start carrying usagePausePastOnce is not stopped by the pause', async () => {
    const err = await start({ usagePausePastOnce: true });
    // It may fail later for want of a worktree — but never on the pause, and
    // never before it (a failure there would make this pass for nothing).
    expect(isPauseRefusal(err)).toBe(false);
    expect(err instanceof Error ? err.message : '').not.toContain('has no prompt');
    expect(taskUsagePauseAllowance(taskId)).toBeNull();
  });

  // INVARIANT: a person or the builder may set it; a task agent never — an
  // agent that could lift the pause on the work it drives makes the pause a
  // suggestion. Refused before anything is launched.
  test('the builder may set it; a task agent is refused', async () => {
    const agentErr = await rpc('usagePause', { action: 'allowTask', taskId, actor: 'agent' });
    expect((agentErr as RpcError).status).toBe(403);
    expect(taskUsagePauseAllowance(taskId)).toBeNull();
    const agentLaunch = await rpc('startTask', { taskId, actor: 'agent', usagePausePastOnce: true });
    expect((agentLaunch as RpcError).status).toBe(403);

    expect(await rpc('usagePause', { action: 'allowTask', taskId, actor: 'builder' })).toBeNull();
    expect(taskUsagePauseAllowance(taskId)?.setBy).toBe('builder');
    const state = await handleRpc('usagePause', root, { taskId }) as { task?: { verdict: unknown; allowed?: boolean }; allowed?: unknown[] };
    expect(state.task?.verdict).toBeNull();
    expect(state.task?.allowed).toBe(true);
    expect(state.allowed).toHaveLength(1);
    expect(await rpc('usagePause', { action: 'clearTask', taskId, actor: 'builder' })).toBeNull();
    expect(taskUsagePauseAllowance(taskId)).toBeNull();
  });

  // INVARIANT: an allowance lets through only ITS task, once.
  test('an allowance for another task does not let this one through; its own is used up by the launch', async () => {
    const storage = await getOrCreateStorage();
    const other = await storage.createTask('Another');
    await rpc('usagePause', { action: 'allowTask', taskId: other.id, actor: 'human' });
    expect(isPauseRefusal(await start({}))).toBe(true);
    expect(taskUsagePauseAllowance(other.id)).not.toBeNull();

    expect(await rpc('usagePause', { action: 'allowTask', taskId, actor: 'human' })).toBeNull();
    // Past the pause now. The launch then fails for want of a runner here —
    // after the gate's peek, before its take — so the allowance is not spent on
    // a launch a later pre-flight refused: it stays for the one that runs.
    expect(isPauseRefusal(await start({}))).toBe(false);
    expect(taskUsagePauseAllowance(taskId)).not.toBeNull();
  });

  // INVARIANT: the BUILDER's launch (what lazy_start / lazy_unblock /
  // lazy_resume send with past_usage_pause) gets past the pause; the same
  // launch on a task agent's channel is refused before anything is set.
  test('a builder-channel launch carrying it passes the pause; an agent-channel one is refused', async () => {
    const builder = await rpc('startTask', { taskId, actor: 'builder', usagePausePastOnce: true });
    expect(isPauseRefusal(builder)).toBe(false);
    expect(builder instanceof RpcError && builder.status === 403).toBe(false);
    expect(taskUsagePauseAllowance(taskId)).toBeNull();
  });

  // INVARIANT: a launch carrying the flag never takes back an allowance set
  // before it — the button's or `--task`'s — even when that launch then fails.
  test('a carried flag leaves a pending allowance in place', async () => {
    expect(await rpc('usagePause', { action: 'allowTask', taskId, actor: 'human' })).toBeNull();
    const before = taskUsagePauseAllowance(taskId);
    // Fails for want of a runner here, after the gate's peek and before its take.
    expect(isPauseRefusal(await start({ usagePausePastOnce: true }))).toBe(false);
    expect(taskUsagePauseAllowance(taskId)).toEqual(before);
  });
});
