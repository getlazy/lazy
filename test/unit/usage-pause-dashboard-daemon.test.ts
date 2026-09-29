/**
 * The dashboard's usage-pause port, against the daemon's real per-task
 * allowance rule: the task page's view, allow / clear as the human channel,
 * the launch boxes' one-launch allowance, and the banner's paused-task list.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { initDaemonStorage, getOrCreateStorage, closeAllStorage } from '../../src/daemon/rpc-handlers';
import { createTaskEditActions } from '../../src/daemon/task-edit-service';
import {
  describeUsagePauseState,
  resetUsagePauseStateForTest,
  taskUsagePauseAllowance,
  turnSpendCredential,
} from '../../src/daemon/usage-pause';
import { resetUsageReadingsForTest } from '../../src/daemon/usage-readings';
import { daemonUsageLimits } from '../../src/proxy/usage-limits';
import { loadConfig } from '../../src/config/loader';
import { enableInProcessTestMode } from '../helpers/in-process-test-mode';
import { pinConfig } from '../helpers/pin-config';

enableInProcessTestMode();

describe('dashboard usage-pause port', () => {
  let root: string;
  let taskId: string;
  let unpinConfig: () => void;
  const savedToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;

  beforeEach(async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat-test-dashboard-token';
    resetUsageReadingsForTest();
    resetUsagePauseStateForTest();
    root = await mkdtemp(join(tmpdir(), 'lazy-usage-pause-dashboard-'));
    await writeFile(
      join(root, 'lazy.toml'),
      `[storage]\nbackend = "external"\nexternal_path = "${join(root, 'store')}"\n\n[usage_pause]\nthreshold_percent = 95\n`,
    );
    unpinConfig = pinConfig(root);
    initDaemonStorage(root);
    const storage = await getOrCreateStorage();
    const created = await storage.createTask('Paused task');
    await storage.updateTaskPrompt(created.id, 'Do the work');
    const task = (await storage.getTask(created.id))!;
    taskId = task.id;
    const spend = await turnSpendCredential(root, await loadConfig(root), task);
    const now = Date.now();
    daemonUsageLimits.observeReading({
      credential: spend!.credential, ts: now, upstream: 'https://api.anthropic.com', backend: 'proxy',
      status: 200, taskId: null, model: null,
      headers: {
        'anthropic-ratelimit-unified-5h-utilization': '0.97',
        'anthropic-ratelimit-unified-5h-reset': String(Math.floor(now / 1000) + 3600),
      },
    });
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

  // INVARIANT: the dashboard sets and clears the allowance through the
  // daemon's rule as the HUMAN channel; the page never decides a pause itself.
  test('task view, allow and clear go through the real rule', async () => {
    const actions = createTaskEditActions(root);
    const before = await actions.usagePauseForTask(taskId);
    expect(before.reason).toContain('97');
    expect(before.liftable).toBe(true);
    expect(before.allowed).toBeNull();

    await actions.allowPastUsagePause(taskId);
    expect(taskUsagePauseAllowance(taskId)?.setBy).toBe('human');
    const allowed = await actions.usagePauseForTask(taskId);
    expect(allowed.reason).toBeNull();
    expect(allowed.allowed?.setBy).toBe('human');

    await actions.clearUsagePauseAllowance(taskId);
    expect(taskUsagePauseAllowance(taskId)).toBeNull();
  });

  // INVARIANT: the Start/Resume box is good for THIS launch only — nothing is
  // left pending once the launch returns, whatever it did.
  test('a launch with the box leaves no allowance behind', async () => {
    const actions = createTaskEditActions(root);
    await actions.startTask(taskId, undefined, { pastUsagePause: true }).catch(() => undefined);
    expect(taskUsagePauseAllowance(taskId)).toBeNull();
    await actions.resumeTask(taskId, undefined, { pastUsagePause: true }).catch(() => undefined);
    expect(taskUsagePauseAllowance(taskId)).toBeNull();
  });

  // A backlog task is never listed: only a person launches it, from a Start
  // dialog that already offers the way through, and judging the whole backlog
  // on every home-page render scaled with it.
  test('the banner state lists a paused resting task, and not once it is let through', async () => {
    const storage = await getOrCreateStorage();
    expect((await describeUsagePauseState(root, storage, undefined, undefined, undefined, { pausedTasks: true }))
      .pausedTasks).toEqual([]);
    await storage.updateTaskStatus(taskId, 'blocked');
    const state = await describeUsagePauseState(root, storage, undefined, undefined, undefined, { pausedTasks: true });
    expect(state.pausedTasks?.map((p) => p.taskId)).toEqual([taskId]);
    await createTaskEditActions(root).allowPastUsagePause(taskId);
    const after = await describeUsagePauseState(root, storage, undefined, undefined, undefined, { pausedTasks: true });
    expect(after.pausedTasks).toEqual([]);
    // Opt-in only: other surfaces do not pay for judging every task.
    expect((await describeUsagePauseState(root, storage)).pausedTasks).toBeUndefined();
  });
});
