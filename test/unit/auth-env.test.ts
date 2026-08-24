import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { handleGetAuthEnv } from '../../src/daemon/rpc-handlers';
import {
  resolveAuthEnvFromDaemon,
  resolveLiveProxyUrl,
  withLiveProxyTarget,
  applyLiveProxyUrl,
  ProxyUnavailableError,
} from '../../src/daemon/auth-env';
import { assertDaemonCredentials, credentialFromEnv } from '../../src/daemon/credential-gate';
import type { RoleTarget } from '../../src/config/types';
import { setDaemonContext, clearDaemonContext } from '../../src/daemon/context';
import {
  lookupCredentialGrant,
  clearCredentialGrantCache,
} from '../../src/proxy/credential-broker';
import { pinDaemonBaseDir, makeDaemonBaseDir } from '../helpers/daemon-base-dir';

/**
 * These tests pin the daemon-centric auth design (see credential-gate.ts):
 * the daemon owns the credential, and client launch paths source it from the
 * daemon rather than from their own process.env. The bug being guarded against:
 * `lazy builder` read the CLIENT's env (which legitimately has no credential in
 * a daemon-only-env deployment) and failed with "Authentication required" even
 * though the daemon held a valid token.
 */
describe('daemon auth env', () => {
  let projectRoot: string;

  // Save/restore the auth + mode env vars so tests don't leak into each other.
  const SAVED = {
    oauth: process.env.CLAUDE_CODE_OAUTH_TOKEN,
    apiKey: process.env.ANTHROPIC_API_KEY,
    lazyTest: process.env.LAZY_TEST,
    lazyConfig: process.env.LAZY_CONFIG,
  };

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'lazy-auth-env-'));
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    // Point loadConfig at a hermetic, minimal config (ollama disabled) so these
    // tests don't pick up the repo's lazy.toml via cwd-walking.
    const configPath = join(projectRoot, 'lazy.toml');
    await writeFile(configPath, '');
    process.env.LAZY_CONFIG = configPath;
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
    for (const [k, v] of [
      ['CLAUDE_CODE_OAUTH_TOKEN', SAVED.oauth],
      ['ANTHROPIC_API_KEY', SAVED.apiKey],
      ['LAZY_TEST', SAVED.lazyTest],
      ['LAZY_CONFIG', SAVED.lazyConfig],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  describe('handleGetAuthEnv', () => {
    test('returns the daemon env OAuth token', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'daemon-oauth-token';
      const result = await handleGetAuthEnv(projectRoot, { proxied: false });
      expect(result).toEqual({
        authEnvVars: [{ key: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'daemon-oauth-token' }],
      });
    });

    test('falls back to ANTHROPIC_API_KEY when no OAuth token', async () => {
      process.env.ANTHROPIC_API_KEY = 'daemon-api-key';
      const result = await handleGetAuthEnv(projectRoot, { proxied: false });
      expect(result).toEqual({
        authEnvVars: [{ key: 'ANTHROPIC_API_KEY', value: 'daemon-api-key' }],
      });
    });

    // INVARIANT: even though the credential gate makes a credential-less running
    // daemon practically unreachable, this RPC must still fail hard (never return
    // an empty credential) if the daemon env somehow lacks one.
    test('throws an actionable error when the daemon env has no credential', async () => {
      await expect(handleGetAuthEnv(projectRoot, { proxied: false })).rejects.toThrow('Authentication required');
    });
  });

  describe('resolveAuthEnvFromDaemon', () => {
    // INVARIANT: an Ollama-backed setup needs no Anthropic token. It is the
    // documented escape hatch from the daemon credential gate, so making ollama
    // roles proxied must not quietly make a real credential mandatory again —
    // the synthetic LOCAL_BACKEND_CREDS stand in, and this must never throw
    // "Authentication required".
    test('resolves an Ollama role with no Anthropic credential present', async () => {
      process.env.LAZY_TEST = '1'; // bypass the daemon RPC; resolve in-process
      // No CLAUDE/ANTHROPIC creds set; if this consulted real auth it would throw.
      const ollamaTarget: RoleTarget = {
        backend: 'ollama',
        model: 'qwen',
        endpoint: 'http://localhost:11434',
        proxyUrl: 'http://127.0.0.1:8766',
      };
      const result = await resolveAuthEnvFromDaemon(ollamaTarget);
      const map = Object.fromEntries(result.map(v => [v.key, v.value]));
      expect(map.ANTHROPIC_AUTH_TOKEN).toBe('ollama');
      // INVARIANT (proxy-role-upstreams): proxied like everything else, and the
      // ollama upstream is NOT what the launch is pointed at.
      expect(map.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8766');
      expect(result.some(v => v.value.includes('11434'))).toBe(false);
    });

    // In test mode (LAZY_TEST=1) the daemon is bypassed (tryRpc returns null),
    // so the resolver falls back to the in-process credential — which is exactly
    // how the daemon process itself would resolve it.
    test('falls back to the local env when the daemon is bypassed (test mode)', async () => {
      process.env.LAZY_TEST = '1';
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'local-token';
      const result = await resolveAuthEnvFromDaemon();
      expect(result).toEqual([{ key: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'local-token' }]);
    });

    // INVARIANT: the surface is carried all the way down to the env layer. The
    // daemon reports its proxy address in the form the CONFIGURED RUNNER would
    // use, so a docker-runner project reports `host.docker.internal` — correct
    // for a container, a guaranteed ENOTFOUND for a host process. A caller
    // launching on the host says so and gets the host-reachable address.
    //
    // Post proxy-role-upstreams this applies to the PROXY address only: a role's
    // endpoint is dialed by the daemon and has one perspective, so there is
    // nothing left to translate about it.
    test('propagates the launch surface to the injected proxy address', async () => {
      process.env.LAZY_TEST = '1'; // bypass the daemon RPC; resolve in-process
      const dockerInternal: RoleTarget = {
        backend: 'ollama',
        model: 'qwen',
        endpoint: 'http://localhost:11434',
        proxyUrl: 'http://host.docker.internal:8766',
      };
      const hostEnv = await resolveAuthEnvFromDaemon(dockerInternal, undefined, 'host');
      expect(hostEnv.find(v => v.key === 'ANTHROPIC_BASE_URL')?.value).toBe('http://localhost:8766');

      const containerEnv = await resolveAuthEnvFromDaemon(dockerInternal, undefined, 'container');
      expect(containerEnv.find(v => v.key === 'ANTHROPIC_BASE_URL')?.value)
        .toBe('http://host.docker.internal:8766');
    });
  });

  /**
   * INVARIANT (the audit plane must not silently degrade): the proxy is ALWAYS
   * ON, so a launch that cannot resolve the live proxy address FAILS. It must
   * never fall through to a direct api.anthropic.com connection: that traffic
   * would be unaudited and unenforced while the trail recorded nothing, and
   * being silent it would rot unnoticed (daemon RPC blips are real). There is
   * no opt-out — `[proxy] enabled` was removed, and `enabled = false` is
   * rejected at load.
   *
   * The gate is armed off an EXPLICIT signal, never off "the RPC returned
   * null": under LAZY_TEST the harness deliberately runs without a daemon, so
   * treating null as failure would break every test. `LAZY_FORCE_PROXY_GATE=1`
   * (test-only) re-arms it, which is what these tests use.
   */
  describe('resolveLiveProxyUrl / withLiveProxyTarget (proxy fail-loud gate)', () => {
    const anthropicRole: RoleTarget = { backend: 'anthropic', model: '', endpoint: '' };

    beforeEach(() => {
      // Deterministic: tryRpc must not reach out to any real daemon from a unit test.
      process.env.LAZY_TEST = '1';
    });

    afterEach(() => {
      delete process.env.LAZY_FORCE_PROXY_GATE;
    });

    async function configWith(toml: string) {
      const configPath = join(projectRoot, 'lazy.toml');
      await writeFile(configPath, toml);
      process.env.LAZY_CONFIG = configPath;
      const { loadConfig } = await import('../../src/config/loader');
      return loadConfig(projectRoot, { cwd: projectRoot });
    }

    test('fails with an actionable error when the proxy is on and no address resolves', async () => {
      process.env.LAZY_FORCE_PROXY_GATE = '1';
      const config = await configWith('');       // no [proxy] section — the proxy is always on
      await expect(resolveLiveProxyUrl(config)).rejects.toThrow(ProxyUnavailableError);
      await expect(resolveLiveProxyUrl(config)).rejects.toThrow('lazy daemon status');
      await expect(resolveLiveProxyUrl(config)).rejects.toThrow('lazy daemon logs');
      // REGRESSION: the message used to offer `[proxy] enabled = false` as the
      // way out. That option no longer exists — never advertise it again.
      const message = await resolveLiveProxyUrl(config).then(
        () => '',
        (err: unknown) => (err instanceof Error ? err.message : String(err)),
      );
      expect(message).not.toContain('enabled = false');
    });

    // INVARIANT: `enabled = false` is REJECTED, not ignored. Accepting it
    // silently would tell the user their traffic is direct while it is proxied.
    test('a config carrying the removed [proxy] enabled = false is rejected at load', async () => {
      await expect(configWith('[proxy]\nenabled = false\n')).rejects.toThrow(/has been removed/);
    });

    // The test harness (and the daemon talking to itself) must keep working
    // without a daemon — that is why the gate keys off an explicit signal.
    test('does not fire under the explicit daemon-RPC bypass (LAZY_TEST)', async () => {
      const config = await configWith('');
      expect(await resolveLiveProxyUrl(config)).toBeUndefined();
      expect(await withLiveProxyTarget(anthropicRole, config)).toEqual(anthropicRole);
    });

    // INVARIANT (proxy-role-upstreams): the gate fires for EVERY backend. These
    // two were the carve-outs — an ollama role and a role pinned at an explicit
    // endpoint both connected direct, behind the audit plane's back, and neither
    // needed the daemon. Their endpoint is now the upstream the PROXY forwards
    // to, so both need the proxy's address and both fail loudly without it.
    // Re-exempting either one would silently reopen the bypass.
    test('fires for an ollama role', async () => {
      process.env.LAZY_FORCE_PROXY_GATE = '1';
      const config = await configWith('');
      const ollama: RoleTarget = { backend: 'ollama', model: 'qwen', endpoint: 'http://localhost:11434' };
      await expect(withLiveProxyTarget(ollama, config)).rejects.toThrow(ProxyUnavailableError);
    });

    test('fires for a role with an explicit endpoint', async () => {
      process.env.LAZY_FORCE_PROXY_GATE = '1';
      const config = await configWith('');
      const explicit: RoleTarget = { backend: 'proxy', model: 'm', endpoint: 'http://127.0.0.1:9999' };
      await expect(withLiveProxyTarget(explicit, config)).rejects.toThrow(ProxyUnavailableError);
    });

    // ...and the endpoint survives the stamping: applyLiveProxyUrl must not
    // overwrite it, because it IS the routing the proxy reads at request time.
    test('stamping the proxy address preserves the role endpoint', async () => {
      const config = await configWith('');
      const explicit: RoleTarget = { backend: 'ollama', model: 'm', endpoint: 'http://localhost:11434' };
      expect(applyLiveProxyUrl(explicit, 'http://127.0.0.1:8766')).toEqual({
        ...explicit,
        proxyUrl: 'http://127.0.0.1:8766',
      });
      expect(config).toBeDefined();
    });
  });

  describe('assertDaemonCredentials (the single enforcement point)', () => {
    test('passes when the daemon env holds an OAuth token', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'daemon-oauth-token';
      await expect(assertDaemonCredentials(projectRoot)).resolves.toBeUndefined();
    });

    // INVARIANT: the gate is the single enforcement point — a daemon started
    // without a credential must refuse with an actionable error, never silently.
    test('throws an actionable refusal when the daemon env has no credential', async () => {
      await expect(assertDaemonCredentials(projectRoot)).rejects.toThrow(
        'Daemon refuses to start',
      );
    });

    // INVARIANT: a set-but-blank credential counts as ABSENT. `export
    // CLAUDE_CODE_OAUTH_TOKEN=$(claude setup-token)` leaves exactly this behind
    // when the inner command fails, and a presence-only check let it through —
    // producing the failure this gate exists to prevent: a daemon that runs,
    // answers RPC, and hands every container a credential the API rejects.
    test('throws when the credential is set but blank', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = '   ';
      await expect(assertDaemonCredentials(projectRoot)).rejects.toThrow(
        'Daemon refuses to start',
      );
    });

    // A blank OAuth token must not mask a real API key — the gate looks for ANY
    // usable credential, not just the first one that happens to be set.
    test('passes when a blank OAuth token is accompanied by a real API key', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = '';
      process.env.ANTHROPIC_API_KEY = 'sk-ant-real';
      await expect(assertDaemonCredentials(projectRoot)).resolves.toBeUndefined();
    });

    // INVARIANT: Ollama-backed setups talk to a local model with dummy
    // credentials, so the gate must not demand an Anthropic token — mirroring
    // runner.checkAvailability().
    test('is skipped when [ollama] is enabled', async () => {
      await writeFile(
        join(projectRoot, 'lazy.toml'),
        '[ollama]\nenabled = true\nmodel = "qwen3:8b"\n',
      );
      await expect(assertDaemonCredentials(projectRoot)).resolves.toBeUndefined();
    });
  });

  /**
   * JIT credential injection. The daemon still owns the credential — but what
   * it hands a PROXIED launch is a placeholder, and the real value stays here.
   */
  describe('handleGetAuthEnv — placeholders for proxied launches', () => {
    let unpin: () => void;
    let baseDir: string;

    beforeEach(async () => {
      baseDir = await makeDaemonBaseDir();
      unpin = pinDaemonBaseDir(baseDir);
      clearCredentialGrantCache();
      // A bound proxy is what makes a swap possible; without one there is
      // nowhere to redeem a placeholder.
      setDaemonContext({ webPort: 0, token: 't', proxyPort: 45999 });
    });

    afterEach(async () => {
      clearDaemonContext();
      unpin();
      clearCredentialGrantCache();
      await rm(baseDir, { recursive: true, force: true });
    });

    // INVARIANT: no launched process holds the human's real credential. This is
    // the daemon-side half of that guarantee — the value handed out for a
    // proxied launch is a placeholder that only this machine's proxy can redeem.
    test('a proxied launch gets a placeholder, never the real credential', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-THE-REAL-ONE';
      const result = await handleGetAuthEnv(projectRoot, {
        proxied: true, role: 'agent', taskId: 'task-77', label: 'lazy-task-77',
      }) as { authEnvVars: Array<{ key: string; value: string }> };

      const token = result.authEnvVars.find(v => v.key === 'CLAUDE_CODE_OAUTH_TOKEN');
      expect(token).toBeDefined();
      expect(JSON.stringify(result)).not.toContain('sk-ant-oat01-THE-REAL-ONE');

      // ...and the placeholder is resolvable back to the launch that got it,
      // which is how the proxy attributes the request.
      const grant = await lookupCredentialGrant(projectRoot, token!.value);
      expect(grant?.role).toBe('agent');
      expect(grant?.taskId).toBe('task-77');
    });

    // The key must survive the swap: the client picks its auth header from
    // WHICH variable is set, so changing it would change the request shape.
    test('the env var the credential occupies is unchanged', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-THE-REAL-ONE';
      const result = await handleGetAuthEnv(projectRoot, {
        proxied: true, role: 'builder', label: 'builder-abc',
      }) as { authEnvVars: Array<{ key: string; value: string }> };
      expect(result.authEnvVars.map(v => v.key)).toContain('ANTHROPIC_API_KEY');
      expect(JSON.stringify(result)).not.toContain('sk-ant-api03-THE-REAL-ONE');
    });

    // INVARIANT (proxy-role-upstreams): an ollama-backed role is proxied like
    // everything else, and an ollama-only project is the documented escape hatch
    // from the credential gate — so the daemon may legitimately hold no Anthropic
    // credential at all. `selfCredentialed` says "mint the grant over the local
    // stand-in", which must still produce a redeemable placeholder (that grant is
    // how the proxy authenticates the caller and routes it to the role's upstream)
    // WITHOUT consulting the daemon's own credential.
    test('a self-credentialed launch mints a grant without a real credential', async () => {
      // Deliberately no CLAUDE/ANTHROPIC creds: this must not throw.
      const result = await handleGetAuthEnv(projectRoot, {
        proxied: true, selfCredentialed: true, role: 'agent', taskId: 'task-88', label: 'lazy-task-88',
      }) as { authEnvVars: Array<{ key: string; value: string }> };

      const token = result.authEnvVars.find(v => v.key === 'ANTHROPIC_AUTH_TOKEN');
      expect(token).toBeDefined();
      // A placeholder, not the literal stand-in — the proxy needs something to look up.
      expect(token!.value).not.toBe('ollama');
      const grant = await lookupCredentialGrant(projectRoot, token!.value);
      expect(grant?.role).toBe('agent');
      expect(grant?.taskId).toBe('task-88');
    });

    // Same boundary discipline as `proxied`: a non-boolean is a lazy bug, and a
    // silently-coerced one would decide which credential source is consulted.
    test('a non-boolean selfCredentialed is rejected at the boundary', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-THE-REAL-ONE';
      await expect(handleGetAuthEnv(projectRoot, {
        proxied: true, selfCredentialed: 'yes', role: 'agent', label: 'x',
      })).rejects.toThrow('selfCredentialed');
    });

    // A launch that does not identify itself cannot have a placeholder minted
    // for it — and must not be quietly given the real credential instead.
    test('a proxied launch with no identity is refused, not downgraded', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-THE-REAL-ONE';
      await expect(handleGetAuthEnv(projectRoot, { proxied: true }))
        .rejects.toThrow('must identify themselves');
    });

    test('a bad identity is rejected at the boundary', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-THE-REAL-ONE';
      await expect(handleGetAuthEnv(projectRoot, { proxied: true, role: 'root', label: 'x' }))
        .rejects.toThrow('role must be');
      await expect(handleGetAuthEnv(projectRoot, { proxied: true, role: 'agent', label: '' }))
        .rejects.toThrow('label must be');
    });

    // INVARIANT: `proxied` is REQUIRED at this boundary, not defaulted. It
    // selects between a placeholder and the human's real credential, so a caller
    // that forgets it would silently receive the real one and ship it into a
    // container — the exact failure this task exists to close.
    test('rejects a request that omits the proxied parameter', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-THE-REAL-ONE';
      await expect(handleGetAuthEnv(projectRoot, {}))
        .rejects.toThrow(/`proxied` parameter is required/);
    });

    test('rejects a non-boolean proxied parameter', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-THE-REAL-ONE';
      await expect(handleGetAuthEnv(projectRoot, { proxied: 'true' }))
        .rejects.toThrow(/must be a boolean/);
    });

    // The address-only caller (resolveLiveProxyUrl) has no launch to inject
    // into, so it must not be handed a credential at all.
    test('credentials: false returns the address and nothing else', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-THE-REAL-ONE';
      const result = await handleGetAuthEnv(projectRoot, { credentials: false, proxied: false }) as {
        authEnvVars: unknown[]; proxyBaseUrl?: string;
      };
      expect(result.authEnvVars).toEqual([]);
      expect(result.proxyBaseUrl).toContain('45999');
    });

    // An unproxied launch (an explicit endpoint, a non-proxied backend) talks
    // to that endpoint directly, so a placeholder would authenticate nothing.
    test('an unproxied launch still gets the real credential', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-THE-REAL-ONE';
      const result = await handleGetAuthEnv(projectRoot, { proxied: false }) as {
        authEnvVars: Array<{ key: string; value: string }>;
      };
      expect(result.authEnvVars[0]!.value).toBe('sk-ant-oat01-THE-REAL-ONE');
    });
  });

  describe('credentialFromEnv', () => {
    test('names the var holding the credential, OAuth first', () => {
      expect(credentialFromEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'a', ANTHROPIC_API_KEY: 'b' }))
        .toBe('CLAUDE_CODE_OAUTH_TOKEN');
      expect(credentialFromEnv({ ANTHROPIC_API_KEY: 'b' })).toBe('ANTHROPIC_API_KEY');
    });

    test('treats missing, empty, and whitespace-only values as absent', () => {
      expect(credentialFromEnv({})).toBeNull();
      expect(credentialFromEnv({ CLAUDE_CODE_OAUTH_TOKEN: '' })).toBeNull();
      expect(credentialFromEnv({ CLAUDE_CODE_OAUTH_TOKEN: '  \n\t ' })).toBeNull();
    });
  });
});
