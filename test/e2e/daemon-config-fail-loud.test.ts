/**
 * E2E tests for the daemon's config precondition: a lazy.toml that exists but
 * does not load must fail daemon startup loudly, never fall through to guessed
 * defaults.
 *
 * Before this, the web-server startup path swallowed the loadConfig failure
 * (`catch { /* config load failure shouldn't prevent web server startup *\/ }`)
 * and carried on with runnerType='docker' and the default port — serving a
 * dashboard on a port the user did not configure, with a runner they may not
 * have, and handing both guesses to every task the daemon launched.
 *
 * These bind a real TCP web port (_forceBindWebInTest) with HOME pointed at a
 * temp dir so all daemon state (token, web-port marker, socket, PID) is
 * isolated from a developer's real ~/.lazy/daemon.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdtemp, mkdir, rm, appendFile, readFile, unlink } from 'fs/promises';
import { basename, join } from 'path';
import { tmpdir } from 'os';
import { startDaemonServer, type RunningDaemon } from '../../src/daemon/server';
import { getStartupErrorPath } from '../../src/daemon/paths';
import { getOrCreateStorage, closeAllStorage } from '../../src/daemon/rpc-handlers';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { pinConfig } from '../helpers/pin-config';
import { isolateInProcessDaemonEnv } from '../helpers/in-process-daemon';

// This suite runs a daemon IN-PROCESS; keep the LAZY_IS_DAEMON flag that
// startDaemonServer() sets process-wide from leaking into later test files.
isolateInProcessDaemonEnv();

describe('daemon startup fails loudly on an unloadable lazy.toml', () => {
  let ctx: TestContext;
  let tmpDir: string;
  let originalHome: string | undefined;
  let restoreConfigPin: (() => void) | undefined;
  let restoreCwd: (() => void) | undefined;
  const daemons: RunningDaemon[] = [];

  beforeEach(async () => {
    restoreCwd = undefined;
    process.env.LAZY_TEST = '1';
    ctx = await setupTestLazy();
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-daemon-cfgfail-'));
    originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
    // An in-process daemon resolves config by walking up from process.cwd()
    // (the dev worktree under `bun test`), so without this it would read THIS
    // repo's lazy.toml — both the wrong file to be breaking and, via its
    // absolute [storage] external_path, one the test user may not be able to
    // write. See test/helpers/pin-config.ts.
    restoreConfigPin = pinConfig(ctx.root);
  });

  afterEach(async () => {
    for (const d of daemons) {
      try { d.stop(); } catch { /* already stopped */ }
    }
    daemons.length = 0;
    // The daemon initializes its Storage lazily in the background. Let that
    // settle and close it before the temp dirs go away — otherwise the init
    // races teardown and rejects on a storage path we just deleted, which
    // bun reports as an unhandled error between tests.
    await getOrCreateStorage().catch(() => { /* never initialized, or already torn down */ });
    await closeAllStorage();
    restoreConfigPin?.();
    restoreCwd?.();
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

  /** True when nothing is listening on `port` (we can bind it ourselves). */
  function portIsFree(port: number): boolean {
    try {
      const probe = Bun.serve({ port, hostname: '127.0.0.1', fetch: () => new Response('probe') });
      probe.stop(true);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Break the project's lazy.toml. An invalid `[agent] effort` is a plain typo
   * — the config file is present and readable, but the values in it cannot be
   * resolved, which is exactly the "found but broken" case that must not be
   * treated like "not found".
   */
  async function breakConfig(): Promise<void> {
    await appendFile(join(ctx.root, 'lazy.toml'), '\n[agent]\neffort = "definitely-not-an-effort"\n');
  }

  /**
   * Mangle the project's lazy.toml so it does not parse at all. The other
   * failure shape: `breakConfig` produces a file the TOML parser accepts and
   * the schema rejects, this one never gets past the parser. Both reach the
   * daemon as a loadConfig throw, and the gate must not distinguish them.
   */
  async function mangleConfig(): Promise<void> {
    await appendFile(join(ctx.root, 'lazy.toml'), '\n[server]\nport = = 26024\n');
  }

  const startWithBrokenConfig = (port: number, socket: string) =>
    startDaemonServer({
      projectRoot: ctx.root,
      token: 'cfgfail-token',
      socketPath: socket,
      webPort: port,
      _forceBindWebInTest: true,
    });

  // INVARIANT: a lazy.toml that exists but does not load is a hard startup
  // failure. The daemon reads the dashboard port, the bind interface, and the
  // runner type from it — starting on guessed values serves a daemon the user
  // did not ask for and propagates the guesses into every task it launches.
  test('broken lazy.toml aborts startup with an actionable error', async () => {
    await breakConfig();
    const port = freePort();

    const promise = startWithBrokenConfig(port, join(tmpDir, 'broken.sock'));
    await expect(promise).rejects.toThrow(/Daemon failed to load .*lazy\.toml/);

    let message = '';
    try {
      await startWithBrokenConfig(port, join(tmpDir, 'broken2.sock'));
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    // The parser's own cause survives — the user is told WHAT is wrong...
    expect(message).toContain('definitely-not-an-effort');
    // ...WHY the daemon refuses rather than guessing...
    expect(message).toContain('will not start on guessed values');
    // ...and WHAT to do about it.
    expect(message).toContain('lazy.toml.example');
    expect(message).toContain('lazy doctor');
  });

  // INVARIANT: a lazy.toml that does not PARSE is the same hard failure as one
  // that parses but holds an invalid value. The daemon gate keys on "loadConfig
  // threw", not on why, so a mangled file cannot slip through on the theory
  // that it is malformed rather than merely wrong. This case only became
  // reachable when the loader itself stopped falling back to defaults on a
  // parse error (harden-daemon-routes); before that the daemon was handed
  // defaults and never saw a throw to gate on.
  test('a lazy.toml that does not parse aborts startup with the same actionable error', async () => {
    await mangleConfig();
    const port = freePort();

    let message = '';
    try {
      await startWithBrokenConfig(port, join(tmpDir, 'mangled.sock'));
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    expect(message).toMatch(/Daemon failed to load .*lazy\.toml/);
    // The parser's line-and-cause survives to the user, same as the schema's.
    // Matched positionally rather than against a fixed line number — the
    // offending line is appended to the init template, whose length is not this
    // test's business.
    expect(message).toMatch(/line \d+: port = = 26024/);
    expect(message).toContain('will not start on guessed values');
    // ...and nothing is left listening on the port it would have guessed.
    expect(portIsFree(port)).toBe(true);
  });

  // INVARIANT: the failed start leaves nothing behind. A daemon that aborted
  // must not have a web server still listening on the port it was going to
  // guess — that listener is precisely the "serving on a port you didn't
  // configure" symptom, and it would also block the next legitimate start.
  test('no web server is left listening after the aborted start', async () => {
    await breakConfig();
    const port = freePort();

    await expect(startWithBrokenConfig(port, join(tmpDir, 'noserver.sock')))
      .rejects.toThrow(/Daemon failed to load/);

    expect(portIsFree(port)).toBe(true);
  });

  // INVARIANT: the abort writes the startup-error marker, so the CLI that
  // spawned the detached daemon can surface the real reason in the user's
  // terminal instead of a generic "Daemon did not start within 5 seconds".
  test('the actionable message reaches the startup-error marker', async () => {
    await breakConfig();

    await expect(startWithBrokenConfig(freePort(), join(tmpDir, 'marker.sock')))
      .rejects.toThrow(/Daemon failed to load/);

    const marker = await readFile(getStartupErrorPath(ctx.root), 'utf-8');
    expect(marker).toContain('Daemon failed to load');
    expect(marker).toContain('definitely-not-an-effort');
  });

  // INVARIANT: fixing the config restores a normal start. The gate is about
  // configs that cannot load — it must not become a general startup hazard.
  test('a fixed lazy.toml starts normally', async () => {
    await breakConfig();
    const port = freePort();

    await expect(startWithBrokenConfig(port, join(tmpDir, 'fixed-fail.sock')))
      .rejects.toThrow(/Daemon failed to load/);

    // Fix it: drop the bogus override entirely.
    const raw = await readFile(join(ctx.root, 'lazy.toml'), 'utf-8');
    await Bun.write(
      join(ctx.root, 'lazy.toml'),
      raw.replace('\n[agent]\neffort = "definitely-not-an-effort"\n', '\n'),
    );

    const daemon = await startDaemonServer({
      projectRoot: ctx.root,
      token: 'cfgfixed-token',
      socketPath: join(tmpDir, 'fixed.sock'),
      webPort: port,
      _forceBindWebInTest: true,
    });
    daemons.push(daemon);
    expect(daemon.webPort).toBe(port);
  });

  // INVARIANT: "missing" is not "broken". A project with no lazy.toml is a
  // normal condition — loadConfig returns defaults for it and the daemon
  // starts. Only a file that exists and fails to load is a hard failure.
  test('a project with no lazy.toml still starts on defaults', async () => {
    // pinConfig cannot be used here: the premise is that there is no config file
    // to point LAZY_CONFIG at, and LAZY_CONFIG naming a file that does not exist
    // is its own hard failure — it would mask the condition under test. So drop
    // the pin and fall back to cwd, the weaker workaround pin-config.ts
    // describes. It is still needed: the daemon's own config load starts at
    // projectRoot and stops there, but the background storage init it kicks off
    // resolves by walking up from cwd, which would otherwise reach THIS repo's
    // lazy.toml and its unwritable absolute external_path. Both restores are
    // deferred to afterEach, which settles that background init and so must run
    // with the same resolution this test set up.
    restoreConfigPin?.();
    restoreConfigPin = undefined;
    const originalCwd = process.cwd();
    process.chdir(ctx.root);
    restoreCwd = () => process.chdir(originalCwd);

    await unlink(join(ctx.root, 'lazy.toml'));
    // Removing lazy.toml also removes the harness's `external_path`, so daemon
    // storage falls back to the documented default, `$HOME/.lazy/<project>`.
    // Create it — `lazy init` would have. Without it the daemon still starts
    // (which is what this test asserts) but its background storage init rejects
    // with "Has 'lazy init' been run?", surfacing as an unhandled error.
    await mkdir(join(tmpDir, '.lazy', basename(ctx.root)), { recursive: true });
    const port = freePort();

    const daemon = await startDaemonServer({
      projectRoot: ctx.root,
      token: 'cfgmissing-token',
      socketPath: join(tmpDir, 'missing.sock'),
      webPort: port,
      _forceBindWebInTest: true,
    });
    daemons.push(daemon);
    expect(daemon.webPort).toBe(port);
  });
});
