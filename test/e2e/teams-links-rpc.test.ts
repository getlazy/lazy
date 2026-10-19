/**
 * `setTeamsLinks` over the wire: Teams hands the daemon URL templates for PR/MR
 * descriptions. In-process daemon on its TCP port, the surface Rails uses.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { startDaemonServer, type RunningDaemon } from '../../src/daemon/server';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { pinConfig } from '../helpers/pin-config';
import { makeDaemonBaseDir, pinDaemonBaseDir, removeDaemonBaseDir } from '../helpers/daemon-base-dir';
import { isolateInProcessDaemonEnv } from '../helpers/in-process-daemon';
import { readProjectSettingsFile } from '../helpers/storage';

const TOKEN = 'test-token-teams-links';
const TASK = 'https://teams.example/t/{task}';
const SERVICE = 'https://teams.example/t/{task}/services/{service}';

isolateInProcessDaemonEnv();

describe('setTeamsLinks RPC', () => {
  let ctx: TestContext;
  let daemon: RunningDaemon | undefined;
  let restoreConfig: (() => void) | undefined;
  let daemonBaseDir: string;
  let restoreDaemonBaseDir: (() => void) | undefined;

  beforeEach(async () => {
    process.env.LAZY_TEST = '1';
    ctx = await setupTestLazy();
    restoreConfig = pinConfig(ctx.root);
    daemonBaseDir = await makeDaemonBaseDir();
    restoreDaemonBaseDir = pinDaemonBaseDir(daemonBaseDir);
    daemon = await startDaemonServer({ token: TOKEN, projectRoot: ctx.root });
  });

  afterEach(async () => {
    if (daemon) await daemon.stop();
    daemon = undefined;
    restoreConfig?.();
    await ctx.cleanup();
    restoreDaemonBaseDir?.();
    await removeDaemonBaseDir(daemonBaseDir);
  });

  async function rpc(command: string, params: Record<string, unknown> = {}) {
    const resp = await fetch(`http://127.0.0.1:${daemon!.webPort}/rpc/${command}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, 'X-Lazy-Project': ctx.root },
      body: JSON.stringify(params),
    });
    return { status: resp.status, body: await resp.json() };
  }

  const stored = () => (readProjectSettingsFile(ctx.root) as any)?.teamsLinks;

  // INVARIANT: an empty push clears the record, so removing APP_HOST takes the
  // links off new descriptions.
  test('stores templates and an empty push clears them', async () => {
    expect((await rpc('setTeamsLinks', { taskUrlTemplate: TASK, serviceUrlTemplate: SERVICE })).status).toBe(200);
    expect(stored()).toEqual({ taskUrlTemplate: TASK, serviceUrlTemplate: SERVICE });
    expect((await rpc('setTeamsLinks', {})).status).toBe(200);
    expect(stored()).toBeUndefined();
  });

  // INVARIANT: a template that cannot produce a link is refused at the boundary.
  test('refuses templates missing a placeholder or not http(s)', async () => {
    expect((await rpc('setTeamsLinks', { taskUrlTemplate: 'https://teams.example/t' })).status).toBe(400);
    expect((await rpc('setTeamsLinks', { taskUrlTemplate: TASK, serviceUrlTemplate: 'https://x/{task}' })).status).toBe(400);
    expect((await rpc('setTeamsLinks', { taskUrlTemplate: 'javascript:alert({task})' })).status).toBe(400);
    expect(stored()).toBeUndefined();
  });

  // INVARIANT: the settings form and the services-command writers keep the
  // links; losing them would silently strip every later description.
  test('other settings writers carry the links forward', async () => {
    await rpc('setTeamsLinks', { taskUrlTemplate: TASK, serviceUrlTemplate: SERVICE });
    expect((await rpc('setProjectSettings', { defaultModel: 'claude-haiku-4-5-20251001' })).status).toBe(200);
    expect(stored()?.taskUrlTemplate).toBe(TASK);
    expect((await rpc('serve.setStartServicesCmd', { command: 'bin/dev' })).status).toBe(200);
    expect((await rpc('serve.setStopServicesCmd', { command: 'bin/stop' })).status).toBe(200);
    expect(stored()?.serviceUrlTemplate).toBe(SERVICE);
  });
});
