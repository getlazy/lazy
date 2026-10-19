/**
 * Unit tests: builder launch env fetch + handleGetBuilderLaunchEnv.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { fetchBuilderLaunchEnv, launchEnvRefusalText, overlayLaunchEnv } from '../../src/builder/launch-env';
import { handleGetBuilderLaunchEnv } from '../../src/daemon/rpc-handlers';
import { mintMcpToken, clearMcpTokenCache } from '../../src/daemon/mcp-tokens';
import { setDaemonContext, setDaemonProxyPort, clearDaemonContext } from '../../src/daemon/context';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { pinConfig } from '../helpers/pin-config';
import { makeDaemonBaseDir, pinDaemonBaseDir, removeDaemonBaseDir } from '../helpers/daemon-base-dir';

describe('overlayLaunchEnv', () => {
  test('overlays auth env vars onto the base env', () => {
    const out = overlayLaunchEnv(
      { HOME: '/home/user', PATH: '/bin' },
      { authEnvVars: [{ key: 'ANTHROPIC_BASE_URL', value: 'http://127.0.0.1:9999' }] },
    );
    expect(out.HOME).toBe('/home/user');
    expect(out.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:9999');
  });
});

describe('fetchBuilderLaunchEnv', () => {
  test('waits for proxy startup after the daemon begins serving', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'builder-launch-retry-'));
    const configPath = join(directory, 'daemon.json');
    const originalFetch = globalThis.fetch;
    let attempts = 0;
    try {
      await writeFile(configPath, JSON.stringify({ token: 'token', projectRoot: '/project', target: 'http://daemon' }));
      globalThis.fetch = Object.assign(async () => {
        attempts++;
        return attempts === 1
          ? Response.json({ error: 'The daemon proxy is not running, so this builder cannot refresh its launch environment.' }, { status: 503 })
          : Response.json({ authEnvVars: [{ key: 'ANTHROPIC_BASE_URL', value: 'http://proxy' }] });
      }, { preconnect: originalFetch.preconnect });
      expect((await fetchBuilderLaunchEnv(configPath)).authEnvVars[0]?.value).toBe('http://proxy');
      expect(attempts).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('does not retry unauthorized responses', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'builder-launch-failure-'));
    const configPath = join(directory, 'daemon.json');
    const originalFetch = globalThis.fetch;
    let attempts = 0;
    try {
      await writeFile(configPath, JSON.stringify({ token: 'token', projectRoot: '/project', target: 'http://daemon' }));
      globalThis.fetch = Object.assign(async () => {
        attempts++;
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
      }, { preconnect: originalFetch.preconnect });
      await expect(fetchBuilderLaunchEnv(configPath)).rejects.toThrow(/401/);
      expect(attempts).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('handleGetBuilderLaunchEnv', () => {
  let ctx: TestContext;
  let restoreConfig: (() => void) | undefined;
  let daemonBaseDir: string;
  let restoreDaemonBaseDir: (() => void) | undefined;
  let builderToken: string;
  const savedEnv = { ...process.env };

  beforeEach(async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token-for-builder-launch-env';
    daemonBaseDir = await makeDaemonBaseDir();
    restoreDaemonBaseDir = pinDaemonBaseDir(daemonBaseDir);
    clearMcpTokenCache();

    ctx = await setupTestLazy();
    restoreConfig = pinConfig(ctx.root);

    builderToken = await mintMcpToken(ctx.root, { kind: 'builder' }, 'builder-test');
    setDaemonContext({ webPort: 43005, token: 'shared' });
    setDaemonProxyPort(45759);
  });

  afterEach(async () => {
    clearDaemonContext();
    if (restoreConfig) restoreConfig();
    if (restoreDaemonBaseDir) restoreDaemonBaseDir();
    if (daemonBaseDir) await removeDaemonBaseDir(daemonBaseDir);
    await ctx.cleanup();
    process.env = { ...savedEnv };
  });

  test('returns container auth env for a builder MCP token', async () => {
    const body = await handleGetBuilderLaunchEnv(ctx.root, builderToken);
    expect(body.authEnvVars.some(v => v.key === 'ANTHROPIC_BASE_URL')).toBe(true);
    // INVARIANT: the builder talks to lazy's proxy, so Claude Code will not
    // grant a 1M window unless we tell it the proxy is a first-party
    // passthrough. This is the launch path the engineer observed as 200k.
    expect(body.authEnvVars.some(
      v => v.key === '_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL' && v.value === '1',
    )).toBe(true);
    expect(body.proxyBaseUrl).toMatch(/^http:\/\/(127\.0\.0\.1|host\.docker\.internal):\d+/);
    // INVARIANT: the daemon serves the builder's CURRENT model/effort with the launch env, so an in-place relaunch never reuses first-start argv.
    expect(body.directive.effort).toBeTruthy();
    // INVARIANT: the directive always names a concrete model (the builder default when no profile pins one), never null/omitted.
    expect(body.directive.model).toMatch(/^claude-/);
    expect(typeof body.lazyVersion).toBe('string');
    expect(body.lazyVersion.length).toBeGreaterThan(0);
  });

  test('rejects a task MCP token', async () => {
    const taskToken = await mintMcpToken(ctx.root, { kind: 'task', taskId: 'deadbeef-dead-beef-dead-beefdeadbeef' }, 'task-x');
    await expect(handleGetBuilderLaunchEnv(ctx.root, taskToken)).rejects.toThrow(/builder-session MCP token/i);
  });
});

describe('parseResume stripping', () => {
  test('stripResumeFromClaudeArgs removes --resume pair', async () => {
    const { stripResumeFromClaudeArgs, parseResumeSessionId } = await import('../../src/supervisor/builder');
    const args = ['--model', 'opus', '--resume', 'abc', '--verbose'];
    expect(parseResumeSessionId(args)).toBe('abc');
    expect(stripResumeFromClaudeArgs(args)).toEqual(['--model', 'opus', '--verbose']);
  });
});

describe('launchEnvRefusalText', () => {
  // INVARIANT: a refused launch environment is reported in the daemon's own
  // words, not as a JSON envelope with CLI advice. A Teams member reads it off
  // the builder page and has no terminal to run `lazy daemon status` in.
  test('unwraps the daemon JSON error and adds no CLI advice', () => {
    const text = launchEnvRefusalText(400, JSON.stringify({ error: 'No credential of yours for endpoint "x".' }));
    expect(text).toBe('The daemon refused this builder\'s launch environment (400): No credential of yours for endpoint "x".');
    expect(text).not.toContain('lazy daemon status');
  });

  test('keeps a non-JSON body as it is', () => {
    expect(launchEnvRefusalText(502, 'Bad Gateway')).toBe('The daemon refused this builder\'s launch environment (502): Bad Gateway');
  });
});
