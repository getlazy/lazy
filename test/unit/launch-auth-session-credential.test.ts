/**
 * getLaunchAuthEnvVars: session placeholders vs JIT grants.
 *
 * INVARIANT: team-mode session tokens (`lazy-sess-…`) must bypass
 * placeholderizeAuthEnv — running them through JIT would replace the owner's
 * binding with an unrelated grant the per-user swap path cannot resolve.
 * Ordinary credentials (including real keys passed through from the host
 * runner) still get JIT placeholders when the proxy is live.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rm, readFile } from 'fs/promises';
import { join } from 'path';
import { Glob } from 'bun';
import { getLaunchAuthEnvVars } from '../../src/capture/claude';
import { setDaemonContext, clearDaemonContext } from '../../src/daemon/context';
import { SESSION_TOKEN_PREFIX, isSessionPlaceholderToken } from '../../src/daemon/session-credentials';
import {
  clearCredentialGrantCache,
  looksLikeLazyPlaceholder,
} from '../../src/proxy/credential-broker';
import { ANTHROPIC_DEFAULT_TARGET, LOCAL_BACKEND_CREDS } from '../../src/utils/role-target';
import { NO_CREDENTIAL } from '../../src/config/agent-profiles';
import { makeDaemonBaseDir, pinDaemonBaseDir } from '../helpers/daemon-base-dir';

const ROOT = '/tmp/launch-auth-session-credential';
const SESSION_TOKEN = `${SESSION_TOKEN_PREFIX}unit-test-owner-placeholder`;
const REAL_API_KEY = 'sk-ant-api03-real-credential-for-jit';

describe('getLaunchAuthEnvVars session vs JIT placeholders', () => {
  let undo: () => void;
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await makeDaemonBaseDir();
    undo = pinDaemonBaseDir(baseDir);
    clearCredentialGrantCache();
    setDaemonContext({ webPort: 26024, token: 'test', proxyPort: 40001 });
  });

  afterEach(async () => {
    clearDaemonContext();
    undo();
    clearCredentialGrantCache();
    await rm(baseDir, { recursive: true, force: true });
  });

  const identity = {
    role: 'agent' as const, taskId: 'task-1', label: 'lazy-task-1', profile: 'claude-code',
  };

  test('session placeholders pass through unchanged', async () => {
    const injected = [{ key: 'CLAUDE_CODE_OAUTH_TOKEN', value: SESSION_TOKEN }];
    const vars = await getLaunchAuthEnvVars(identity, undefined, undefined, 'host', injected);
    const token = vars.find((v) => v.key === 'CLAUDE_CODE_OAUTH_TOKEN')?.value;
    expect(token).toBe(SESSION_TOKEN);
    expect(isSessionPlaceholderToken(token!)).toBe(true);
    expect(looksLikeLazyPlaceholder(token!)).toBe(false);
  });

  test('ordinary injected credentials are JIT-placeholderized', async () => {
    const injected = [{ key: 'ANTHROPIC_API_KEY', value: REAL_API_KEY }];
    const vars = await getLaunchAuthEnvVars(identity, undefined, undefined, 'host', injected);
    const token = vars.find((v) => v.key === 'ANTHROPIC_API_KEY')?.value;
    expect(token).not.toBe(REAL_API_KEY);
    expect(looksLikeLazyPlaceholder(token!)).toBe(true);
    expect(isSessionPlaceholderToken(token!)).toBe(false);
  });

  // INVARIANT: whether to skip JIT placeholderization is decided by the creds
  // the launch actually USES. A profile with its own credential slot resolves
  // its own key ahead of any injected session placeholder, and that key must
  // never reach the process unswapped just because session creds were offered.
  test("a profile's own credential is placeholderized even when session creds are injected", async () => {
    const injected = [{ key: 'CLAUDE_CODE_OAUTH_TOKEN', value: SESSION_TOKEN }];
    const target = {
      ...ANTHROPIC_DEFAULT_TARGET, credential: NO_CREDENTIAL, profile: 'local-model',
    };
    const vars = await getLaunchAuthEnvVars(identity, target, undefined, 'host', injected);
    const values = vars.map((v) => v.value);
    expect(values).not.toContain(SESSION_TOKEN);
    const local = LOCAL_BACKEND_CREDS.map((c) => c.value);
    for (const v of vars.filter((x) => LOCAL_BACKEND_CREDS.some((c) => c.key === x.key))) {
      expect(local).not.toContain(v.value);
      expect(looksLikeLazyPlaceholder(v.value)).toBe(true);
    }
  });
});

describe('team-mode session placeholders always travel with the proxy address', () => {
  let undo: () => void;
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await makeDaemonBaseDir();
    undo = pinDaemonBaseDir(baseDir);
    clearCredentialGrantCache();
    setDaemonContext({ webPort: 26024, token: 'test', proxyPort: 40001 });
  });
  afterEach(async () => {
    clearDaemonContext();
    undo();
    clearCredentialGrantCache();
    await rm(baseDir, { recursive: true, force: true });
  });

  const identity = {
    role: 'builder' as const, taskId: null, label: 'review-session:b1', profile: 'claude-code',
  };
  const target = { ...ANTHROPIC_DEFAULT_TARGET, proxyUrl: 'http://host.docker.internal:40001' };

  // INVARIANT: a launch handed a lazy-sess-… placeholder carries ANTHROPIC_BASE_URL
  // pointing at lazy's proxy, on BOTH surfaces, with the surface's own address.
  // Only the proxy can resolve that placeholder; without the base URL the agent
  // dials api.anthropic.com and 401s on its first request (review conversations
  // and daemon-owned builder sessions both shipped that way).
  for (const [surface, host] of [['container', 'host.docker.internal'], ['host', 'localhost']] as const) {
    test(`${surface} surface`, async () => {
      const injected = [{ key: 'CLAUDE_CODE_OAUTH_TOKEN', value: SESSION_TOKEN }];
      const vars = await getLaunchAuthEnvVars(identity, target, { role: 'builder' }, surface, injected);
      expect(vars.find((v) => v.key === 'CLAUDE_CODE_OAUTH_TOKEN')?.value).toBe(SESSION_TOKEN);
      const base = vars.find((v) => v.key === 'ANTHROPIC_BASE_URL')?.value;
      expect(base).toBeDefined();
      expect(new URL(base!).hostname).toBe(host);
    });
  }
});

describe('no launch path bypasses getLaunchAuthEnvVars with a plan credential', () => {
  const SRC = join(import.meta.dir, '../../src');

  async function sources(): Promise<Array<{ file: string; src: string }>> {
    const out: Array<{ file: string; src: string }> = [];
    for await (const file of new Glob('**/*.ts').scan(SRC)) {
      out.push({ file, src: await readFile(join(SRC, file), 'utf8') });
    }
    expect(out.length).toBeGreaterThan(100);
    return out;
  }

  // INVARIANT: a turn-credential plan's env is handed to getLaunchAuthEnvVars
  // as injectedCreds, never used INSTEAD of it (`credEnv ?? getLaunchAuthEnvVars(…)`).
  // That shape skips the proxy address entirely whenever a plan exists; it was
  // copied into two launch paths before anyone noticed, so a third copy must
  // fail here.
  test('no `?? getLaunchAuthEnvVars(` fallback shape', async () => {
    const offenders = (await sources())
      .filter(({ src }) => /\?\?\s*(await\s+)?(this\.)?getLaunchAuthEnvVars\s*\(/.test(src))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  // INVARIANT: every caller of credentialEnvForPlan is reviewed for how the
  // plan env reaches the launch. A syntactic scan cannot see every bypass (an
  // if/else or a ternary does the same damage), so a NEW caller fails until
  // someone confirms its env goes through getLaunchAuthEnvVars' injectedCreds
  // and adds it here with the route.
  test('every credentialEnvForPlan caller is a reviewed route', async () => {
    const REVIEWED: Record<string, RegExp> = {
      // the definition
      'daemon/turn-credentials.ts': /export function credentialEnvForPlan/,
      // getLaunchAuthEnvVars(…, 'container', credEnv ?? undefined)
      'daemon/builder-sessions.ts': /getLaunchAuthEnvVars\([^;]*credEnv \?\? undefined/,
      // getLaunchAuthEnvVars(…, surface, credEnv ?? undefined)
      'daemon/review-session-builder-turn.ts': /getLaunchAuthEnvVars\([^;]*credEnv \?\? undefined/,
      // → runOneshot ownerCredentialEnv → runner's getLaunchAuthEnvVars injectedCreds
      'daemon/link-describe.ts': /ownerCredentialEnv/,
      // memory compact: withCompactCredential → ownerCredentialEnv → compact's
      // runOneshot → runner's getLaunchAuthEnvVars injectedCreds (spender = asker)
      'daemon/rpc-memory.ts': /ownerCredentialEnv/,
      // a member's own terminal container: getLaunchAuthEnvVars(…, 'container', credEnv)
      // on the built-in Anthropic target, so no profile credential outranks it
      'server/member-exec-credential.ts': /getLaunchAuthEnvVars\([^;]*'container', credEnv\)/,
    };
    const callers = (await sources()).filter(({ src }) => src.includes('credentialEnvForPlan('));
    expect(callers.map(({ file }) => file).sort()).toEqual(Object.keys(REVIEWED).sort());
    for (const { file, src } of callers) expect(REVIEWED[file]!.test(src)).toBe(true);
  });
});
