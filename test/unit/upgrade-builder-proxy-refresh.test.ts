/**
 * Unit tests: the builder's live proxy target must be re-resolved after an
 * upgrade restarts the daemon.
 *
 * THE BUG THESE ENCODE: `createRunner` resolves the live proxy address ONCE and
 * stamps it onto the runner's role targets. `lazy builder` holds that one runner
 * across a `lazy upgrade`, which restarts the daemon — and the daemon's proxy
 * port is OS-assigned by default, so the restarted daemon serves the proxy
 * somewhere else. The stamped pre-upgrade address then wins at launch (see the
 * `needsLiveProxyUrl` invariant below), so the relaunched builder came back with
 * `ANTHROPIC_BASE_URL` pointing at a dead port and every model call failed until
 * the human relaunched by hand.
 *
 * `refreshRunnerProxyTargets` is the fix: re-derive the role targets from config
 * and re-resolve the live address against the daemon now serving.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { refreshRunnerProxyTargets } from '../../src/runner';
import { needsLiveProxyUrl, ProxyUnavailableError } from '../../src/daemon/auth-env';
import { setDaemonContext, setDaemonProxyPort, clearDaemonContext } from '../../src/daemon/context';
import type { Runner } from '../../src/runner';
import type { RoleTarget, ResolvedConfig } from '../../src/config/types';

/**
 * Minimal Runner stand-in: role targets are the only surface under test, and a
 * real DockerRunner would drag Docker availability into a unit test.
 */
function fakeRunner(): Runner & { targets: { builder: RoleTarget; agent: RoleTarget } | null } {
  const runner = {
    targets: null as { builder: RoleTarget; agent: RoleTarget } | null,
    setRoleTargets(targets: { builder: RoleTarget; agent: RoleTarget }) {
      runner.targets = targets;
    },
  };
  return runner as unknown as Runner & { targets: { builder: RoleTarget; agent: RoleTarget } | null };
}

describe('builder proxy target refresh across an upgrade', () => {
  let projectRoot: string;
  const savedEnv = { ...process.env };

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'lazy-proxy-refresh-'));
  });

  afterEach(async () => {
    clearDaemonContext();
    process.env = { ...savedEnv };
    await rm(projectRoot, { recursive: true, force: true });
  });

  async function configWith(toml: string): Promise<ResolvedConfig> {
    const configPath = join(projectRoot, 'lazy.toml');
    await writeFile(configPath, toml);
    process.env.LAZY_CONFIG = configPath;
    const { loadConfig } = await import('../../src/config/loader');
    return loadConfig(projectRoot, { cwd: projectRoot });
  }

  /**
   * INVARIANT (the mechanism the bug rode in on): a role target that ALREADY
   * carries a proxyUrl is never re-resolved — `withLiveProxyTarget` and
   * `resolveAuthEnvFromDaemon` both treat an already-set address as
   * authoritative. That is correct for a single launch, and it is exactly why a
   * runner held across a daemon restart must be refreshed explicitly: nothing
   * downstream will notice that its stamped address went stale.
   */
  test('an already-stamped proxyUrl is never re-resolved on its own', async () => {
    const config = await configWith('');
    const fresh: RoleTarget = { backend: 'anthropic', model: '', endpoint: '' };
    const stamped: RoleTarget = { ...fresh, proxyUrl: 'http://127.0.0.1:40001' };

    expect(needsLiveProxyUrl(fresh)).toBe(true);
    expect(needsLiveProxyUrl(stamped)).toBe(false);
  });

  // The headline behavior: the daemon comes back on a different OS-assigned
  // port, and the refresh moves the runner onto it.
  test('re-resolves onto the restarted daemon\'s new proxy port', async () => {
    await configWith('[runner]\ntype = "dangerously-host-process-without-any-isolation"\n');
    // Pre-upgrade daemon: proxy on 40001. Resolution reads the daemon context
    // directly (the in-daemon path), so no socket or RPC is involved here.
    setDaemonContext({ webPort: 1, token: 't', proxyPort: 40001 });

    const runner = fakeRunner();
    await refreshRunnerProxyTargets(runner, projectRoot);
    expect(runner.targets?.builder.proxyUrl).toBe('http://127.0.0.1:40001');

    // Upgrade restarts the daemon; the proxy binds a different port.
    setDaemonProxyPort(40002);
    await refreshRunnerProxyTargets(runner, projectRoot);
    expect(runner.targets?.builder.proxyUrl).toBe('http://127.0.0.1:40002');
    // The agent role travels the same path and must not be left behind.
    expect(runner.targets?.agent.proxyUrl).toBe('http://127.0.0.1:40002');
  });

  /**
   * INVARIANT (the audit plane must not silently degrade): if the live address
   * cannot be resolved at relaunch, the refresh THROWS. Relaunching with the old
   * address would point the builder at a dead port; relaunching with no address
   * would connect direct to api.anthropic.com unaudited. Both are worse than a
   * loud failure that names the remedy.
   */
  test('fails loud when the proxy address cannot be resolved', async () => {
    process.env.LAZY_TEST = '1';
    process.env.LAZY_FORCE_PROXY_GATE = '1';   // re-arm the gate under LAZY_TEST
    await configWith('');                       // no [proxy] section = proxy ON (default)
    const runner = fakeRunner();
    await expect(refreshRunnerProxyTargets(runner, projectRoot)).rejects.toThrow(ProxyUnavailableError);
  });

  // The proxy is always on, so there is no "opt out" branch left to be a no-op.
  // INVARIANT (proxy-role-upstreams): a role with an explicit endpoint is NOT a
  // no-op any more. That endpoint is where the PROXY forwards the role, so the
  // role still needs the proxy's live address — and with the gate armed and no
  // daemon to answer, the refresh must FAIL rather than quietly leave the role
  // with no address and let the launch connect somewhere unaudited.
  test('a role with an explicit endpoint still needs the proxy address', async () => {
    process.env.LAZY_TEST = '1';
    process.env.LAZY_FORCE_PROXY_GATE = '1';
    await configWith(
      '[models.roles.builder]\nbackend = "proxy"\nmodel = "m"\nendpoint = "http://127.0.0.1:9999"\n' +
      '[models.roles.agent]\nbackend = "proxy"\nmodel = "m"\nendpoint = "http://127.0.0.1:9999"\n',
    );
    const runner = fakeRunner();
    await expect(refreshRunnerProxyTargets(runner, projectRoot)).rejects.toThrow(/proxy address/i);
  });
});
