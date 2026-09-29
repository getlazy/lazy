/**
 * The control plane's copy of a project's lazy.toml, through a REAL daemon:
 * the three RPCs over HTTP, the live re-read with no restart, and the rule
 * that only the control plane may apply a config.
 *
 * test/unit/managed-project-config.test.ts covers the rules in-process; this
 * suite covers what only a running daemon can — that the RPCs exist on the
 * wire, that a written file is what the very next request resolves, and that
 * a member's token is refused at the request path.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, readFile, realpath } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { storageDirFor } from '../helpers/storage';
import { DaemonClient, RpcApplicationError } from '../../src/daemon/client';
import { getDaemonTcpTarget, readToken } from '../../src/daemon/lifecycle';

describe('project config RPCs (real daemon)', () => {
  let ctx: TestContext;
  let configDir: string;
  let configPath: string;
  let target: string;
  let token: string;

  async function rpc(command: string, params: Record<string, unknown> = {}, as = token) {
    return await DaemonClient.fromTarget(target, as).rpc(command, ctx.root, params) as Record<string, any>;
  }

  beforeEach(async () => {
    configDir = await realpath(await mkdtemp(join(tmpdir(), 'lazy-cp-config-')));
    configPath = join(configDir, 'lazy.toml');
    ctx = await setupTestLazy({ withDaemon: true, daemonEnv: { LAZY_MANAGED_CONFIG_PATH: configPath } });
    target = getDaemonTcpTarget(ctx.root)!;
    token = readToken(ctx.root)!;
    if (!target || !token) throw new Error('test daemon did not record a TCP target and token');
  });

  afterEach(async () => {
    await ctx.cleanup();
    await rm(configDir, { recursive: true, force: true });
  });

  // INVARIANT: import once, then the daemon re-reads the control plane's file
  // on the very next request — no restart — and the clone is never written.
  test('import, validate, apply, and the next request runs on the applied file', async () => {
    const before = await rpc('getProjectConfig');
    expect(before).toMatchObject({ imported: false, source: 'repository' });
    expect(typeof before.repositoryToml).toBe('string');
    const repoBefore = await readFile(join(ctx.root, 'lazy.toml'), 'utf-8');

    const bad = await rpc('validateProjectConfig', { toml: `${before.repositoryToml}\n[proxy]\nretry_after_threshold = -1\n` });
    expect(bad.ok).toBe(false);
    expect(bad.issues).toContainEqual(expect.objectContaining({ key: 'proxy.retry_after_threshold', severity: 'error' }));

    const refused = await rpc('applyProjectConfig', { toml: `${before.repositoryToml}\n[proxy]\nretry_after_threshold = -1\n` });
    expect(refused.applied).toBe(false);

    const edited = before.repositoryToml.replace(/^default = ".*"$/m, 'default = "claude-e2e-applied"');
    expect(edited).toContain('claude-e2e-applied');
    const applied = await rpc('applyProjectConfig', { toml: edited });
    expect(applied).toMatchObject({ applied: true, changed: true, path: configPath, restartRequired: [] });

    const settings = await rpc('getProjectSettings');
    expect(settings.defaultModel.repositoryValue).toBe('claude-e2e-applied');
    expect(await rpc('getProjectConfig')).toMatchObject({ imported: true, source: 'control-plane', toml: edited });
    expect(await readFile(join(ctx.root, 'lazy.toml'), 'utf-8')).toBe(repoBefore);
  });

  // The settings page's three reads: the catalogue, the form edit, and a check
  // that says what changed and when each change is picked up.
  test('settings catalogue, form edit and a change check go through the daemon', async () => {
    const read = await rpc('getProjectConfig');
    const keys = read.settings.settings.map((s: { key: string }) => s.key);
    expect(keys).toContain('usage_pause.threshold_percent');

    const base = '# ours\n[usage_pause]\nthreshold_percent = 95\n';
    const { toml } = await rpc('editProjectConfig', { toml: base, set: { 'review.mode': 'separate' }, unset: ['usage_pause.threshold_percent'] });
    expect(toml).toContain('# ours');
    expect(toml).toContain('mode = "separate"');

    const check = await rpc('validateProjectConfig', { toml, before: base });
    expect(check.ok).toBe(true);
    expect(check.values['review.mode']).toBe('separate');
    expect(check.changes.map((c: { key: string; change: string }) => [c.key, c.change])).toEqual([
      ['review.mode', 'added'], ['usage_pause.threshold_percent', 'removed'],
    ]);

    await expect(rpc('editProjectConfig', { toml: base, set: { 'runner.type': 'host-process' } })).rejects.toThrow(/settings form/);
  });

  // INVARIANT: applying a config is the control plane's act alone — a member's
  // token is refused at the request path, whatever it sends.
  test("a member's token cannot apply a config", async () => {
    await ctx.restartDaemon({
      LAZY_MANAGED: '1',
      LAZY_MANAGED_STORAGE_PATH: storageDirFor(ctx.root),
      LAZY_MANAGED_CONFIG_PATH: configPath,
    });
    target = getDaemonTcpTarget(ctx.root)!;
    token = readToken(ctx.root)!;
    const minted = await rpc('mintActorToken', { kind: 'user', email: 'member@example.com' });

    let status = 0;
    try {
      await rpc('applyProjectConfig', { toml: '[session]\nverbose = true\n' }, minted.token);
    } catch (err) {
      if (!(err instanceof RpcApplicationError)) throw err;
      status = err.status;
    }
    expect(status).toBe(403);
    expect(await Bun.file(configPath).exists()).toBe(false);
  });
});
