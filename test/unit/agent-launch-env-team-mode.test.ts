/**
 * Unit tests: the in-container relaunch refresh (handleGetAgentLaunchEnv →
 * handleGetAuthEnv) in TEAM MODE.
 *
 * INVARIANT: a refreshed launch environment carries the SAME credential shape
 * the turn's launch did (getLaunchAuthEnvVars), because the turn's principal —
 * not the daemon — pays for it: the owner's session placeholder on the primary
 * Anthropic profile, a grant for any other profile. It never reads the
 * daemon's own credential or the project's store for a team-mode turn, which
 * would refuse a refresh the launch allowed (neither holds the member's key)
 * or hand the container a placeholder for a credential nobody consented to.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { writeFile } from 'fs/promises';
import { join } from 'path';
import { handleGetAgentLaunchEnv, initDaemonStorage, getOrCreateStorage, closeAllStorage } from '../../src/daemon/rpc-handlers';
import { mintMcpToken, clearMcpTokenCache } from '../../src/daemon/mcp-tokens';
import { setDaemonContext, setDaemonProxyPort, clearDaemonContext } from '../../src/daemon/context';
import { clearUserCredentialCache, putUserCredential } from '../../src/daemon/user-credentials';
import { bindTurnCredential, clearSessionCredentialCache, isSessionPlaceholderToken } from '../../src/daemon/session-credentials';
import { lookupCredentialGrant } from '../../src/proxy/credential-broker';
import { getLaunchAuthEnvVars } from '../../src/capture/claude';
import { ANTHROPIC_DEFAULT_TARGET } from '../../src/utils/role-target';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { pinConfig } from '../helpers/pin-config';
import { makeDaemonBaseDir, pinDaemonBaseDir, removeDaemonBaseDir } from '../helpers/daemon-base-dir';

const ALICE = 'alice@example.com';
const CREDENTIAL_KEYS = ['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'];

describe('handleGetAgentLaunchEnv in team mode', () => {
  let ctx: TestContext;
  let restoreConfig: (() => void) | undefined;
  let daemonBaseDir: string;
  let restoreDaemonBaseDir: (() => void) | undefined;
  const savedEnv = { ...process.env };

  async function taskOn(agent: string): Promise<{ id: string; token: string }> {
    const storage = await getOrCreateStorage();
    const task = await storage.createTask(`on ${agent}`, undefined, undefined, `on-${agent}`, 'task', agent);
    await bindTurnCredential(ctx.root, { taskId: task.id, sessionId: 's', ownerUserId: ALICE, kind: 'oauth' });
    const token = await mintMcpToken(ctx.root, { kind: 'task', taskId: task.id }, `lazy-${task.id.substring(0, 8)}`);
    return { id: task.id, token };
  }

  const credentialOf = (env: Array<{ key: string; value: string }>) =>
    env.filter((v) => CREDENTIAL_KEYS.includes(v.key) && v.value);

  beforeEach(async () => {
    // The daemon holds NO credential of its own, and the project store none
    // for the gateway: a team-mode turn needs neither.
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    daemonBaseDir = await makeDaemonBaseDir();
    restoreDaemonBaseDir = pinDaemonBaseDir(daemonBaseDir);
    clearMcpTokenCache();
    clearUserCredentialCache();
    clearSessionCredentialCache();

    ctx = await setupTestLazy();
    const configPath = join(ctx.root, 'lazy.toml');
    await writeFile(configPath, `${await Bun.file(configPath).text()}\n` +
      '[agents.claude-gw]\nharness = "claude-code"\nmodel = "claude-sonnet-4-6"\n' +
      'endpoint = "https://gw.example.com"\ncredential = "gw-claude"\n');
    restoreConfig = pinConfig(ctx.root);

    await putUserCredential(ctx.root, { userId: ALICE, kind: 'oauth', token: 'alice-claude-secret' });
    initDaemonStorage(ctx.root);
    setDaemonContext({ webPort: 43012, token: 'shared' });
    setDaemonProxyPort(45772);
  });

  afterEach(async () => {
    clearDaemonContext();
    await closeAllStorage();
    if (restoreConfig) restoreConfig();
    if (restoreDaemonBaseDir) restoreDaemonBaseDir();
    if (daemonBaseDir) await removeDaemonBaseDir(daemonBaseDir);
    await ctx.cleanup();
    clearUserCredentialCache();
    clearSessionCredentialCache();
    process.env = { ...savedEnv };
  });

  test('the primary Claude profile refreshes onto the owner\'s session placeholder', async () => {
    const { token } = await taskOn('claude-code');
    const body = await handleGetAgentLaunchEnv(ctx.root, token);
    const creds = credentialOf(body.authEnvVars);
    expect(creds.length).toBeGreaterThan(0);
    for (const c of creds) expect(isSessionPlaceholderToken(c.value)).toBe(true);
    expect(JSON.stringify(body)).not.toContain('alice-claude-secret');
  });

  // INVARIANT: a codex or cursor turn in team mode carries NO session
  // placeholder. That placeholder resolves to the owner's CLAUDE credential,
  // and nothing in such a turn uses it (the merge phase runs the task's own
  // harness, src/supervisor/merge.ts) — holding it would let a codex or cursor
  // agent spend the member's Anthropic account.
  test('a codex turn\'s launch and refresh carry no session placeholder', async () => {
    const { token } = await taskOn('codex');
    const body = await handleGetAgentLaunchEnv(ctx.root, token);
    for (const v of body.authEnvVars) expect(isSessionPlaceholderToken(v.value)).toBe(false);

    const session = [{ key: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'lazy-sess-owner-placeholder' }];
    for (const harness of ['codex', 'cursor']) {
      const launched = await getLaunchAuthEnvVars(
        { role: 'agent', taskId: 't', label: 'c', profile: harness },
        { ...ANTHROPIC_DEFAULT_TARGET, profile: harness, harness, credential: harness === 'codex' ? 'openai' : 'cursor' },
        undefined, 'container', session,
      );
      expect(launched.some((v) => isSessionPlaceholderToken(v.value)), harness).toBe(false);
    }
  });

  test('a profile with its own endpoint refreshes onto a grant the proxy resolves per member', async () => {
    const { id, token } = await taskOn('claude-gw');
    const body = await handleGetAgentLaunchEnv(ctx.root, token);
    const creds = credentialOf(body.authEnvVars);
    expect(creds.length).toBeGreaterThan(0);
    for (const c of creds) {
      expect(isSessionPlaceholderToken(c.value)).toBe(false);
      const grant = await lookupCredentialGrant(ctx.root, c.value);
      expect(grant).toMatchObject({ role: 'agent', taskId: id, taskUuid: id, profile: 'claude-gw' });
    }
  });
});
