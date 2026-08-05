/**
 * Unit tests for refreshDaemonMcpConfigs — the daemon-side half of "builder MCP
 * survives daemon restarts".
 *
 * A daemon MCP config is minted once at launch and bind-mounted into the
 * container as a single file (`-v <path>:<path>:ro`). If the daemon later
 * restarts onto a different port (another project's daemon can take ours in the
 * shared 26024+ window), every running container keeps calling the old port
 * where a FOREIGN daemon answers and rejects our token with a permanent 401.
 * Rewriting the mounted file IN PLACE is what lets a live session recover.
 *
 * DELIBERATE CHANGE (agent-mcp-token): this used to also rewrite the token,
 * because every container carried the same shared daemon token and the daemon
 * could rotate it. Tokens are now minted per identity (one per task session,
 * one per builder session — src/daemon/mcp-tokens.ts) and the registry that
 * binds them lives on disk, so a token SURVIVES a daemon restart by design.
 * Overwriting it during a refresh would hand a container an identity that is
 * not its own — the exact thing per-task tokens exist to prevent. Only the
 * ADDRESS is the daemon's to correct now, and the tests below assert that.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { refreshDaemonMcpConfigs, daemonMcpTarget, daemonMcpConfigDir } from '../../src/daemon/task-launcher';
import { makeDaemonBaseDir, removeDaemonBaseDir } from '../helpers/daemon-base-dir';

describe('refreshDaemonMcpConfigs', () => {
  let root: string;
  let baseDir: string;
  let configDir: string;
  const warnings: string[] = [];
  const infos: string[] = [];
  const log = {
    info: (m: string) => { infos.push(m); },
    warn: (m: string) => { warnings.push(m); },
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-mcp-refresh-'));
    // Configs live in the DAEMON's state dir, never under the project root —
    // task containers mount the repo read-only, so an in-repo per-task token
    // would be readable by every other agent.
    baseDir = await makeDaemonBaseDir();
    process.env.LAZY_DAEMON_BASE_DIR = baseDir;
    configDir = daemonMcpConfigDir(root);
    await mkdir(configDir, { recursive: true });
    warnings.length = 0;
    infos.length = 0;
  });

  afterEach(async () => {
    delete process.env.LAZY_DAEMON_BASE_DIR;
    await removeDaemonBaseDir(baseDir);
    await rm(root, { recursive: true, force: true });
  });

  async function writeConfig(name: string, body: Record<string, unknown>): Promise<string> {
    const path = join(configDir, name);
    await writeFile(path, JSON.stringify(body, null, 2));
    return path;
  }

  function readJson(path: string): Promise<Record<string, unknown>> {
    return readFile(path, 'utf-8').then(t => JSON.parse(t));
  }

  // INVARIANT: a restart that moves the daemon's port must update the configs
  // already mounted into running containers. Without this, the container keeps
  // talking to whatever now owns the old port — the exact "every lazy tool
  // returns Unauthorized forever" failure.
  test('rewrites a stale target to the daemon current port', async () => {
    const path = await writeConfig('daemon-mcp-builder-1.json', {
      token: 'identity-token',
      projectRoot: root,
      taskId: '',
      target: 'http://host.docker.internal:26024',
    });

    const result = await refreshDaemonMcpConfigs(root, { webPort: 26027 }, log);

    expect(result).toEqual({ scanned: 1, updated: 1, skipped: 0 });
    const after = await readJson(path);
    expect(after.target).toBe(daemonMcpTarget(26027));
    expect(infos.join('\n')).toContain('26027');
  });

  // INVARIANT: the refresh must NEVER rewrite the token. It is bound to one
  // identity server-side and survives daemon restarts on purpose; replacing it
  // would either break a live container or, worse, give it someone else's
  // identity. See src/daemon/mcp-tokens.ts.
  test('preserves the per-identity token across a port move', async () => {
    const path = await writeConfig('daemon-mcp-lazy-task-a.json', {
      token: 'task-a-token', projectRoot: root, taskId: 'task-a',
      target: 'http://host.docker.internal:26024',
    });

    await refreshDaemonMcpConfigs(root, { webPort: 26031 }, log);

    expect((await readJson(path)).token).toBe('task-a-token');
  });

  // INVARIANT: the rewrite must reuse the SAME inode. Docker's single-file bind
  // mount pins the inode at container start — a write-temp-then-rename would
  // leave the container reading the ORIGINAL file forever, silently defeating
  // the entire fix. This test is why refreshDaemonMcpConfigs must never be
  // "hardened" into an atomic replace.
  test('rewrites in place, preserving the inode the bind mount pins', async () => {
    const path = await writeConfig('daemon-mcp-builder-2.json', {
      token: 'tok', projectRoot: root, taskId: '', target: 'http://host.docker.internal:26024',
    });
    const before = await stat(path);

    await refreshDaemonMcpConfigs(root, { webPort: 26030 }, log);

    const after = await stat(path);
    expect(after.ino).toBe(before.ino);
  });

  // INVARIANT: only the address is the daemon's to correct. taskId is the
  // identity this config was minted for; clobbering it would misroute tool
  // calls (and now also guarantee a 403 against the token's real identity).
  test('preserves taskId and any other fields', async () => {
    const path = await writeConfig('daemon-mcp-lazy-some-task.json', {
      token: 'tok', projectRoot: root, taskId: 'abc123', target: 'http://host.docker.internal:26024',
      extra: 'keep-me',
    });

    await refreshDaemonMcpConfigs(root, { webPort: 26025 }, log);

    const after = await readJson(path);
    expect(after.taskId).toBe('abc123');
    expect(after.extra).toBe('keep-me');
    expect(after.projectRoot).toBe(root);
  });

  // A restart that lands on the same port is the common case; it must not churn
  // hundreds of files (and their mtimes) for nothing.
  test('skips configs that already carry the current target', async () => {
    await writeConfig('daemon-mcp-builder-3.json', {
      token: 'tok', projectRoot: root, taskId: '', target: daemonMcpTarget(26024),
    });

    const result = await refreshDaemonMcpConfigs(root, { webPort: 26024 }, log);

    expect(result).toEqual({ scanned: 1, updated: 0, skipped: 1 });
    expect(infos).toHaveLength(0);
  });

  // Housekeeping must never take the daemon down: one corrupt leftover in a
  // directory that accumulates hundreds of files cannot block the others.
  test('a corrupt config is warned about, not fatal, and others still refresh', async () => {
    await writeFile(join(configDir, 'daemon-mcp-corrupt.json'), 'not json{');
    const good = await writeConfig('daemon-mcp-good.json', {
      token: 'tok', projectRoot: root, taskId: '', target: 'http://host.docker.internal:26024',
    });

    const result = await refreshDaemonMcpConfigs(root, { webPort: 26026 }, log);

    expect(result.scanned).toBe(2);
    expect(result.updated).toBe(1);
    expect(result.skipped).toBe(1);
    expect(warnings.join('\n')).toContain('daemon-mcp-corrupt.json');
    expect((await readJson(good)).target).toBe(daemonMcpTarget(26026));
  });

  // The config dir may hold unrelated files; touching them would corrupt other
  // subsystems.
  test('ignores files that are not daemon MCP configs', async () => {
    const other = join(configDir, 'builder-abc123.json');
    await writeFile(other, JSON.stringify({ token: 'untouched' }));

    const result = await refreshDaemonMcpConfigs(root, { webPort: 26024 }, log);

    expect(result.scanned).toBe(0);
    expect(JSON.parse(await readFile(other, 'utf-8')).token).toBe('untouched');
  });

  // A fresh project has never launched anything; a missing config dir is
  // normal, not an error worth logging.
  test('a missing config dir is a silent no-op', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'lazy-mcp-refresh-empty-'));
    try {
      const result = await refreshDaemonMcpConfigs(empty, { webPort: 26024 }, log);
      expect(result).toEqual({ scanned: 0, updated: 0, skipped: 0 });
      expect(warnings).toHaveLength(0);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});
