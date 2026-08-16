/**
 * INVARIANT: `lazy upgrade` removes the pre-v0.20 MCP configs that leaked the
 * shared daemon token into the repository, rotates that token, says what it did,
 * and NEVER touches the live per-identity configs in the daemon state dir.
 *
 * The leak: before v0.20 each launch's MCP config — containing the shared daemon
 * bearer token — was written to `<project>/.lazy/tmp/daemon-mcp-*.json` at 0644,
 * inside a repo that every task container bind-mounts. `/rpc/*` accepts that
 * token, so any agent could accept, close or reject any task as the daemon. One
 * project in the wild accumulated 820 of them.
 *
 * Every assertion below is load-bearing:
 *   - deleting the files without rotating leaves the credential leaked;
 *   - rotating on a project that never leaked is an unexplained side effect;
 *   - deleting anything under `~/.lazy/daemon/<slug>/mcp/` breaks a LIVE agent,
 *     because those configs are bind-mounted into running containers.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm, writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  findLegacyDaemonMcpConfigs,
  legacyMcpConfigDir,
  purgeLegacyDaemonMcpConfigs,
  purgeLegacyDaemonMcpConfigsReporting,
} from '../../src/upgrade/legacy-mcp-purge';
import { getMcpConfigDir } from '../../src/daemon/paths';
import { getTokenPath } from '../../src/daemon/paths';
import { generateToken, readToken } from '../../src/daemon/lifecycle';
import { makeDaemonBaseDir, pinDaemonBaseDir, removeDaemonBaseDir } from '../helpers/daemon-base-dir';

describe('legacy MCP config purge', () => {
  let root: string;
  let daemonBaseDir: string;
  let restoreDaemonBaseDir: (() => void) | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-purge-'));
    // getDataDir() picks `.lazy` when it exists — make this look like a real
    // project rather than relying on its new-project fallback.
    await mkdir(join(root, '.lazy'), { recursive: true });
    // The token this purge rotates lives in the daemon state dir. Never the
    // developer's real one.
    daemonBaseDir = await makeDaemonBaseDir();
    restoreDaemonBaseDir = pinDaemonBaseDir(daemonBaseDir);
  });

  afterEach(async () => {
    restoreDaemonBaseDir?.();
    restoreDaemonBaseDir = undefined;
    await removeDaemonBaseDir(daemonBaseDir);
    await rm(root, { recursive: true, force: true });
  });

  /** Seed n legacy configs, each carrying the shared token like the real ones did. */
  async function seedLegacy(n: number, token = 'shared-daemon-token'): Promise<void> {
    const dir = legacyMcpConfigDir(root);
    await mkdir(dir, { recursive: true });
    for (let i = 0; i < n; i++) {
      await writeFile(
        join(dir, `daemon-mcp-lazy-task-${i}.json`),
        JSON.stringify({ host: 'host.docker.internal', port: 26025, token }),
      );
    }
  }

  test('finds and removes every legacy config, and reports the count', async () => {
    await seedLegacy(3);
    // A builder-shaped legacy config leaked exactly the same token — the glob
    // must cover it, not just the task-shaped ones.
    await writeFile(join(legacyMcpConfigDir(root), 'daemon-mcp-builder-17859.json'), '{"token":"shared"}');

    const lines: string[] = [];
    const result = await purgeLegacyDaemonMcpConfigsReporting(root, l => lines.push(l));

    expect(result.removed).toBe(4);
    expect(result.failed).toEqual([]);
    expect(await findLegacyDaemonMcpConfigs(root)).toEqual([]);
    // "Transparent over terse": removing files from someone's repo is stated.
    expect(lines.join('\n')).toContain('Removed 4 leaked');
    expect(lines.join('\n')).toContain('Rotated the shared daemon token');
  });

  // INVARIANT: deleting the files does not un-leak a credential that every agent
  // has been able to read for months. The token must actually change.
  test('rotates the shared daemon token when it purged a real leak', async () => {
    const before = generateToken(root);
    await seedLegacy(2);

    const result = await purgeLegacyDaemonMcpConfigs(root);

    expect(result.rotated).toBe(true);
    const after = readToken(root);
    expect(after).not.toBe(before);
    expect(after).toMatch(/^[0-9a-f]{64}$/);
  });

  // The token file must stay 0600 after rotation — the whole point is that it
  // stops being world-readable.
  test('the rotated token file is not readable by anyone else', async () => {
    await seedLegacy(1);
    await purgeLegacyDaemonMcpConfigs(root);

    const { stat } = await import('fs/promises');
    const mode = (await stat(getTokenPath(root))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  // INVARIANT: a project that never leaked gets no rotation. Churning a working
  // credential on every upgrade for no reason is exactly the kind of hidden side
  // effect CLAUDE.md's "principle of least surprise" forbids.
  test('a project with no legacy configs changes nothing and reports nothing', async () => {
    const before = generateToken(root);

    const lines: string[] = [];
    const result = await purgeLegacyDaemonMcpConfigsReporting(root, l => lines.push(l));

    expect(result).toEqual({ removed: 0, failed: [], rotated: false });
    expect(readToken(root)).toBe(before);
    expect(lines).toEqual([]);
  });

  // Idempotent: the second upgrade in a row must be a no-op, including the
  // rotation. A token that changes on every upgrade would defeat the 401 heal.
  test('running twice rotates once', async () => {
    await seedLegacy(2);
    await purgeLegacyDaemonMcpConfigs(root);
    const afterFirst = readToken(root);

    const second = await purgeLegacyDaemonMcpConfigs(root);

    expect(second).toEqual({ removed: 0, failed: [], rotated: false });
    expect(readToken(root)).toBe(afterFirst);
  });

  // A project that never ran a pre-v0.20 daemon has no tmp dir at all. Missing
  // is a normal condition, not an error (CLAUDE.md: distinguish "not found" from
  // "found but broken").
  test('a project with no tmp directory is fine', async () => {
    expect(await findLegacyDaemonMcpConfigs(root)).toEqual([]);
    expect((await purgeLegacyDaemonMcpConfigs(root)).removed).toBe(0);
  });

  // INVARIANT — THE ONE THAT BREAKS PEOPLE: the live per-identity configs under
  // ~/.lazy/daemon/<slug>/mcp/ are bind-mounted into RUNNING containers.
  // Deleting one takes an agent's tools away mid-turn. Only the in-repo legacy
  // path is ever a candidate.
  test('never touches the live per-identity configs in the daemon state dir', async () => {
    const liveDir = getMcpConfigDir(root);
    await mkdir(liveDir, { recursive: true });
    await writeFile(join(liveDir, 'daemon-mcp-lazy-abc12345.json'), '{"token":"live-task"}');
    await writeFile(join(liveDir, 'daemon-mcp-builder-1786.json'), '{"token":"live-builder"}');
    await seedLegacy(2);

    await purgeLegacyDaemonMcpConfigs(root);

    expect((await readdir(liveDir)).sort()).toEqual([
      'daemon-mcp-builder-1786.json',
      'daemon-mcp-lazy-abc12345.json',
    ]);
    expect(JSON.parse(await readFile(join(liveDir, 'daemon-mcp-lazy-abc12345.json'), 'utf-8')).token)
      .toBe('live-task');
  });

  // Unrelated files in the same tmp dir are somebody else's — a purge that took
  // them too would be a different, unrequested command.
  test('leaves non-matching files in the tmp dir alone', async () => {
    await seedLegacy(1);
    const dir = legacyMcpConfigDir(root);
    await writeFile(join(dir, 'builder-a1b2c3d4.json'), '{"token":"builder-server"}');
    await writeFile(join(dir, 'daemon-mcp-notes.txt'), 'not a config');

    await purgeLegacyDaemonMcpConfigs(root);

    expect((await readdir(dir)).sort()).toEqual(['builder-a1b2c3d4.json', 'daemon-mcp-notes.txt']);
  });
});

describe('upgrade wiring', () => {
  // INVARIANT: the purge+rotation runs in the ONE window where no container and
  // no daemon holds the shared token — after every container has been stopped
  // and the old daemon has exited, and before the new daemon starts and adopts a
  // token. Rotating earlier 401s the upgrade's own shutdown RPC; rotating later
  // means the new daemon is already serving the leaked token. If this test
  // fails, the call was moved — move it back rather than relaxing the check.
  test('the purge is sequenced between the daemon stop and the daemon restart', async () => {
    const source = await readFile(
      join(import.meta.dir, '..', '..', 'src', 'cli', 'commands', 'upgrade.ts'),
      'utf-8',
    );

    const stop = source.indexOf('await requestShutdown(root)');
    const purge = source.indexOf('await purgeLegacyDaemonMcpConfigsReporting(root)');
    const restart = source.indexOf("await ensureDaemon('upgrade', root)");

    expect(stop).toBeGreaterThan(-1);
    expect(purge).toBeGreaterThan(stop);
    expect(restart).toBeGreaterThan(purge);
  });
});
