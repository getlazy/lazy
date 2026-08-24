/**
 * E2E tests for daemon restart resilience: the bearer token AND the web port
 * must stay stable across a restart, so daemon MCP configs already minted into
 * running containers/builders (target = host.docker.internal:<webPort>, plus a
 * bearer token) keep authenticating instead of getting a permanent bare
 * "Unauthorized" (the fix-builder-daemon-reauth incident).
 *
 * Stability is best-effort, though: the 26024+ port window is shared by every
 * project on the machine, so a restart CAN land elsewhere. The last test covers
 * the recovery path for that case — a starting daemon rewrites the
 * already-minted daemon MCP configs to its current target — never the token,
 * which is bound to one identity (src/daemon/mcp-tokens.ts) and outlives the
 * restart on purpose — and publishes
 * its projectRoot on /daemon/status so a 401'd client can tell "my token
 * rotated" apart from "a foreign daemon took my port".
 *
 * These bind a real TCP web port (_forceBindWebInTest) with HOME pointed at a
 * temp dir so all daemon state (token, web-port marker, socket, PID) is
 * isolated from a developer's real ~/.lazy/daemon.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile, readFile, stat } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { startDaemonServer, type RunningDaemon } from '../../src/daemon/server';
import { readToken, readWebPort, writeWebPort } from '../../src/daemon/lifecycle';
import { daemonMcpConfigDir } from '../../src/daemon/task-launcher';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { pinConfig } from '../helpers/pin-config';
import { getOrCreateStorage, closeAllStorage } from '../../src/daemon/rpc-handlers';
import { isolateInProcessDaemonEnv } from '../helpers/in-process-daemon';

// This suite runs a daemon IN-PROCESS; keep the LAZY_IS_DAEMON flag that
// startDaemonServer() sets process-wide from leaking into later test files.
isolateInProcessDaemonEnv();

describe('daemon restart resilience', () => {
  let ctx: TestContext;
  let tmpDir: string;
  let originalHome: string | undefined;
  let restoreConfig: (() => void) | undefined;
  const daemons: RunningDaemon[] = [];

  beforeEach(async () => {
    process.env.LAZY_TEST = '1';
    ctx = await setupTestLazy();
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-daemon-portpersist-'));
    originalHome = process.env.HOME;
    // Isolate daemon state from the real ~/.lazy/daemon.
    process.env.HOME = tmpDir;
    // These daemons start IN-PROCESS, so without this they resolve config by
    // walking up from `bun test`'s cwd — lazy's OWN worktree — and adopt its
    // [storage] external_path. Two of the tests below already pin LAZY_CONFIG
    // by hand for that reason; the two that did not died at startup with
    // "EACCES: permission denied, mkdir '/Users/…'". Pin it for the whole suite.
    restoreConfig = pinConfig(ctx.root);
  });

  afterEach(async () => {
    for (const d of daemons) {
      try { await d.stop(); } catch { /* ignore */ }
    }
    daemons.length = 0;
    // Let the daemon's lazy background Storage init settle and close it before
    // the temp dirs go away, so it cannot reject on a path we just deleted.
    await getOrCreateStorage().catch(() => { /* never initialized, or already torn down */ });
    await closeAllStorage();
    restoreConfig?.();
    restoreConfig = undefined;
    process.env.HOME = originalHome;
    await ctx.cleanup();
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** Bind port 0 to learn a currently-free port, then release it. */
  function freePort(): number {
    const probe = Bun.serve({ port: 0, fetch: () => new Response('probe') });
    const port = probe.port!;
    probe.stop(true);
    return port;
  }

  // INVARIANT: on a successful web bind the daemon persists the bound port, and
  // the next start (with no explicit option and only the DEFAULT config port)
  // prefers that persisted port over the default. This is what keeps a running
  // builder's mounted `target` valid across a daemon restart — without it, a
  // restart that lands on a different port permanently breaks the builder.
  test('restart re-binds the previously bound port instead of the default', async () => {
    const port = freePort();

    // First start binds `port` explicitly and must persist it.
    const d1 = await startDaemonServer({
      projectRoot: ctx.root,
      token: 'persist-token-1',
      socketPath: join(tmpDir, 'p1.sock'),
      webPort: port,
      _forceBindWebInTest: true,
    });
    daemons.push(d1);
    expect(d1.webPort).toBe(port);
    // The port marker was written for the next start to prefer.
    expect(readWebPort(ctx.root)).toBe(port);
    await d1.stop();
    daemons.pop();

    // Second start passes NO explicit webPort. The test project's config port is
    // the default (26024), so the persisted port must win — proving readWebPort
    // is consulted ahead of the default.
    const d2 = await startDaemonServer({
      projectRoot: ctx.root,
      token: 'persist-token-2',
      socketPath: join(tmpDir, 'p2.sock'),
      _forceBindWebInTest: true,
    });
    daemons.push(d2);
    expect(d2.webPort).toBe(port);
  });

  // INVARIANT: a daemon restart REUSES the persisted bearer token rather than
  // rotating it. A running builder mints its token once at launch and cannot
  // re-authenticate; rotating on restart would invalidate it permanently.
  // (Guards the fix from commit 1f5ef27a against regression.)
  test('restart reuses the persisted bearer token', async () => {
    const port = freePort();

    // First start with NO explicit token -> generates and persists one.
    const d1 = await startDaemonServer({
      projectRoot: ctx.root,
      socketPath: join(tmpDir, 't1.sock'),
      webPort: port,
      _forceBindWebInTest: true,
    });
    daemons.push(d1);
    const tok1 = readToken(ctx.root);
    expect(tok1).toBeTruthy();
    await d1.stop();
    daemons.pop();

    // Restart with NO explicit token -> must reuse the same token.
    const d2 = await startDaemonServer({
      projectRoot: ctx.root,
      socketPath: join(tmpDir, 't2.sock'),
      webPort: port,
      _forceBindWebInTest: true,
    });
    daemons.push(d2);
    const tok2 = readToken(ctx.root);
    expect(tok2).toBe(tok1);
  });

  // A non-default config port stays authoritative — persistence only steers the
  // default case, so a user who moves [server] port off the default is never
  // overridden by a stale persisted value. (A config port EQUAL to the default
  // is treated as unset, since the init template writes the default explicitly.)
  test('a non-default config port overrides the persisted port', async () => {
    const persisted = freePort();
    const pinned = freePort();
    // Avoid the rare case where both probes hand back the same port.
    if (persisted === pinned) return;

    // Point the daemon at a config that pins a NON-default port. LAZY_CONFIG is
    // honored as an absolute path by loadConfig — cleaner than editing the
    // project lazy.toml, which the test harness resolves via process.cwd()
    // (the worktree) rather than the temp project root.
    const cfgFile = join(tmpDir, 'pinned-lazy.toml');
    await writeFile(cfgFile, `[server]\nport = ${pinned}\n`);
    const savedLazyConfig = process.env.LAZY_CONFIG;
    process.env.LAZY_CONFIG = cfgFile;
    try {
      // Seed a stale persisted port; the pinned config port must win over it.
      writeWebPort(ctx.root, persisted);
      const d = await startDaemonServer({
        projectRoot: ctx.root,
        token: 'pinned-token',
        socketPath: join(tmpDir, 'pin.sock'),
        _forceBindWebInTest: true,
      });
      daemons.push(d);
      expect(d.webPort).toBe(pinned);
      // The authoritative bound port is now what gets persisted.
      expect(readWebPort(ctx.root)).toBe(pinned);
    } finally {
      if (savedLazyConfig === undefined) delete process.env.LAZY_CONFIG;
      else process.env.LAZY_CONFIG = savedLazyConfig;
    }
  });

  // INVARIANT: a starting daemon corrects the daemon MCP configs it minted for
  // containers that are still running. Port persistence above is best-effort
  // (another project's daemon can hold ours in the shared 26024+ window), so
  // when the daemon DOES move, the mounted config — not the container — is the
  // thing that has to change. Rewritten IN PLACE: the bind mount pins the inode,
  // so an atomic replace would leave the container reading the stale original.
  test('a daemon start refreshes already-minted MCP configs and reports its projectRoot', async () => {
    const port = freePort();
    // Configs live in the DAEMON's state dir (isolated here via the temp HOME),
    // never under the project root: task containers mount the repo read-only,
    // so an in-repo per-task token would be readable by every other agent.
    const cfgDir = daemonMcpConfigDir(ctx.root);
    await mkdir(cfgDir, { recursive: true });
    const stalePath = join(cfgDir, 'daemon-mcp-lazy-some-task.json');
    await writeFile(stalePath, JSON.stringify({
      token: 'token-minted-for-this-task',
      projectRoot: ctx.root,
      taskId: 'abc12345',
      // Points at whatever now owns the old port — in the field, another
      // project's daemon, which rejects our bearer token with a bare 401.
      target: 'http://host.docker.internal:26024',
    }, null, 2));
    const beforeIno = (await stat(stalePath)).ino;

    // Pin LAZY_CONFIG so this in-process daemon cannot adopt lazy's own
    // lazy.toml (see CLAUDE.md). The API proxy is irrelevant here but is always
    // on, so keep it on loopback with an OS-assigned port — the one posture
    // that binds nothing a container would refuse.
    const cfgFile = join(tmpDir, 'pinned-lazy.toml');
    await writeFile(cfgFile, '[proxy]\nbind = "127.0.0.1"\n');
    const savedLazyConfig = process.env.LAZY_CONFIG;
    process.env.LAZY_CONFIG = cfgFile;
    try {
      const d = await startDaemonServer({
        projectRoot: ctx.root,
        socketPath: join(tmpDir, 'refresh.sock'),
        webPort: port,
        _forceBindWebInTest: true,
      });
      daemons.push(d);

      const refreshed = JSON.parse(await readFile(stalePath, 'utf-8'));
      // INVARIANT: only the ADDRESS is the daemon's to correct. The token is
      // minted per identity (src/daemon/mcp-tokens.ts) and survives a restart by
      // design; overwriting it would hand a live container an identity that is
      // not its own — the very thing per-task tokens exist to prevent.
      expect(refreshed.token).toBe('token-minted-for-this-task');
      expect(refreshed.target).toBe(`http://host.docker.internal:${port}`);
      // Per-launch routing data is the launcher's, not the daemon's, to set.
      expect(refreshed.taskId).toBe('abc12345');
      expect((await stat(stalePath)).ino).toBe(beforeIno);

      // /daemon/status is unauthenticated on TCP precisely so a client holding a
      // rejected token can still learn WHOSE daemon just refused it.
      const status = await (await fetch(`http://127.0.0.1:${port}/daemon/status`)).json();
      expect(status.projectRoot).toBe(ctx.root);
    } finally {
      if (savedLazyConfig === undefined) delete process.env.LAZY_CONFIG;
      else process.env.LAZY_CONFIG = savedLazyConfig;
    }
  });
});
