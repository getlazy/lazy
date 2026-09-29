/**
 * `usagePause` get with `ownerEmail`: judge a task as that MEMBER's launch
 * would, in team mode.
 *
 * Lazy Teams renders a member's task page on the project's control token, so
 * the request has no turn owner and the task would be judged on the SERVICE
 * credential — while the member's own Start spends theirs. Without this, a
 * member whose credential is paused saw no pause on the page and was refused
 * on Start.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { initDaemonStorage, getOrCreateStorage, closeAllStorage, handleRpc } from '../../src/daemon/rpc-handlers';
import { resetUsagePauseStateForTest } from '../../src/daemon/usage-pause';
import { resetUsageReadingsForTest } from '../../src/daemon/usage-readings';
import { clearUserCredentialCache, putUserCredential } from '../../src/daemon/user-credentials';
import { daemonUsageLimits } from '../../src/proxy/usage-limits';
import { enableInProcessTestMode } from '../helpers/in-process-test-mode';
import { pinConfig } from '../helpers/pin-config';

enableInProcessTestMode();

const MEMBER = 'ada@example.com';

describe('usagePause get with ownerEmail', () => {
  let root: string;
  let taskId: string;
  let unpinConfig: () => void;

  beforeEach(async () => {
    resetUsageReadingsForTest();
    resetUsagePauseStateForTest();
    clearUserCredentialCache();
    root = await mkdtemp(join(tmpdir(), 'lazy-usage-pause-owner-'));
    await writeFile(
      join(root, 'lazy.toml'),
      `[storage]\nbackend = "external"\nexternal_path = "${join(root, 'store')}"\n\n[usage_pause]\nthreshold_percent = 95\n`,
    );
    unpinConfig = pinConfig(root);
    initDaemonStorage(root);
    // A member credential on file is what makes this team mode.
    await putUserCredential(root, { userId: MEMBER, kind: 'oauth', token: 'ada-claude-secret' });
    const storage = await getOrCreateStorage();
    taskId = (await storage.createTask('Paused for Ada')).id;
    const now = Date.now();
    daemonUsageLimits.observeReading({
      credential: `user:${MEMBER}`, ts: now, upstream: 'https://api.anthropic.com', backend: 'proxy',
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
    clearUserCredentialCache();
    await rm(root, { recursive: true, force: true });
  });

  // INVARIANT: a control caller asking on a member's behalf is judged on that
  // member's credential in team mode; without `ownerEmail` the answer is the
  // daemon's own launch (the service credential), unchanged.
  test('judges the task on the named member\'s credential', async () => {
    const control = { kind: 'control' } as const;
    const asService = await handleRpc('usagePause', root, { taskId }, undefined, control) as {
      task: { credential: string | null; verdict: unknown };
    };
    expect(asService.task.credential).toBe('user:__service__');
    expect(asService.task.verdict).toBeNull();

    const asMember = await handleRpc('usagePause', root, { taskId, ownerEmail: MEMBER }, undefined, control) as {
      task: { credential: string | null; verdict: { credential: string; usedPercent: number } | null };
    };
    expect(asMember.task.credential).toBe(`user:${MEMBER}`);
    expect(asMember.task.verdict?.credential).toBe(`user:${MEMBER}`);
    expect(asMember.task.verdict?.usedPercent).toBe(97);
  });
});
