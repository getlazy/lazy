/**
 * E2E test setup helpers
 *
 * Provides a TestContext that creates an isolated temp git repo with lazy
 * initialized. Tests run the real CLI via subprocess for maximum fidelity.
 */

import { join, resolve } from 'path';
import { mkdtemp, rm, writeFile, realpath } from 'fs/promises';
import { tmpdir } from 'os';
import { waitForDaemon, readPid, getDaemonDir } from '../../src/daemon';
import { registerTestDaemonRoot, unregisterTestDaemonRoot } from './daemon-registry';

const ENTRY_PATH = resolve(__dirname, '../../src/index.ts');
const PRELOAD_PATH = resolve(__dirname, '../mocks/preload-mocks.ts');

export interface WorkResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface MockAgentResponse {
  result: string;
  session_id: string;
  usage?: { input_tokens: number; output_tokens: number };
}

export interface LazyOptions {
  env?: Record<string, string>;
  /** Pipe this string to the command's stdin */
  input?: string;
}

export interface TestContext {
  /** Absolute path to the temporary test directory (git repo root) */
  root: string;
  /** Absolute path to the temporary protocol base directory */
  protocolBase: string;
  /** Run a `lazy` CLI command in this test context */
  lazy: (args: string[], options?: LazyOptions) => Promise<WorkResult>;
  /** Run a `lazy` CLI command with Claude/Docker mocked */
  lazyMocked: (args: string[], mockResponse: MockAgentResponse, options?: LazyOptions) => Promise<WorkResult>;
  /** Run raw git commands in the test directory */
  git: (...args: string[]) => { stdout: string; stderr: string; exitCode: number };
  /** Clean up the temporary directory */
  cleanup: () => Promise<void>;
}

export interface SetupOptions {
  /**
   * Start a real `lazy` daemon bound to this test project. The daemon runs as
   * a detached subprocess (loaded with the mock preload so agent calls stay
   * mocked) and is torn down in cleanup(). Required for tests that exercise
   * commands which need daemon-backed storage (e.g. `start`, `accept`).
   *
   * When true, `lazyMocked()` does NOT set `LAZY_TEST=1` — otherwise the CLI
   * would bypass the daemon entirely (see `tryRemoteStorage`). Mocks are still
   * activated via `LAZY_MOCK_CLAUDE_RESPONSE` (see preload-mocks.ts).
   */
  withDaemon?: boolean;
  /**
   * Extra env vars to pass to the test daemon at startup. Use this to activate
   * mock modules (e.g. `LAZY_MOCK_ACCEPT_GATES: '[]'` to load the remote mock
   * inside the daemon). Per-test mock state can then be injected via files
   * the mocks read on each call (see test/mocks/remote.ts readGatesFromFile).
   */
  daemonEnv?: Record<string, string>;
}

function spawnGit(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.exitCode,
  };
}

async function runLazy(cwd: string, args: string[], protocolBase: string, withDaemon: boolean, extraEnv?: Record<string, string>, input?: string): Promise<WorkResult> {
  // Symmetric with runLazyMocked: in a daemonless suite, LAZY_TEST=1 keeps
  // `ctx.lazy` from auto-starting a daemon (ensureDaemon bypasses under
  // LAZY_TEST). Without it, a plain `ctx.lazy(['create'])` (e.g. createTask)
  // spins up a daemon that holds .storage-lock, then any LAZY_TEST subprocess
  // OR in-process createStorage() in the same suite deadlocks retrying that
  // lock for 5s — the deterministic breakage behind the daemonless reconcile
  // suites. withDaemon suites must NOT set it: `ctx.lazy` has to reach the
  // real daemon for storage.
  const lazyTestEnv = withDaemon ? {} : { LAZY_TEST: '1' };
  const proc = Bun.spawn(['bun', 'run', ENTRY_PATH, ...args], {
    cwd,
    stdin: input !== undefined ? new Blob([input]) : undefined,
    stdout: 'pipe',
    stderr: 'pipe',
    // Provide fake auth so the daemon credential gate (the single enforcement
    // point) lets the implicitly auto-started daemon come up. Mirrors
    // runLazyMocked/startTestDaemon. Placed BEFORE extraEnv so individual tests
    // can clear it (e.g. ANTHROPIC_API_KEY: '') to exercise the gate.
    env: { ...process.env, ANTHROPIC_API_KEY: 'sk-test-fake-key-for-testing', LAZY_PROTOCOL_BASE: protocolBase, ...lazyTestEnv, ...extraEnv },
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { stdout, stderr, exitCode };
}

async function runLazyMocked(
  cwd: string,
  args: string[],
  mockResponse: MockAgentResponse,
  protocolBase: string,
  withDaemon: boolean,
  extraEnv?: Record<string, string>,
  input?: string,
): Promise<WorkResult> {
  // When a real daemon is running for this test, LAZY_TEST=1 must NOT be set —
  // it would short-circuit tryRemoteStorage/tryRpc and bypass the daemon,
  // defeating the whole point of `withDaemon`. Mocks still activate because
  // preload-mocks.ts also checks for LAZY_MOCK_CLAUDE_RESPONSE.
  const lazyTestEnv = withDaemon ? {} : { LAZY_TEST: '1' };

  const proc = Bun.spawn(['bun', 'run', '--preload', PRELOAD_PATH, ENTRY_PATH, ...args], {
    cwd,
    stdin: input !== undefined ? new Blob([input]) : undefined,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      ...extraEnv,
      ...lazyTestEnv,
      LAZY_PROTOCOL_BASE: protocolBase,
      LAZY_MOCK_CLAUDE_RESPONSE: JSON.stringify(mockResponse),
      // Provide fake auth so getAuthEnvVars() doesn't fail
      ANTHROPIC_API_KEY: 'sk-test-fake-key-for-testing',
    },
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { stdout, stderr, exitCode };
}

/**
 * Start a detached `lazy daemon` for the given project. Loads the mock preload
 * so agent/claude calls stay mocked even when the daemon is the one launching
 * the task. Waits for the daemon socket to become responsive before returning.
 */
async function startTestDaemon(projectRoot: string, protocolBase: string, extraEnv: Record<string, string> = {}): Promise<void> {
  const { mkdir, open } = await import('fs/promises');
  const { join: pathJoin } = await import('path');
  const daemonDir = getDaemonDir(projectRoot);
  await mkdir(daemonDir, { recursive: true });

  // Capture daemon stdout/stderr so failures to start show up somewhere. The
  // default daemon.log isn't written until after the logger is configured,
  // which is after most startup failures.
  const startupLogPath = pathJoin(daemonDir, 'test-startup.log');
  const logHandle = await open(startupLogPath, 'a');

  try {
    const proc = Bun.spawn(
      ['bun', 'run', '--preload', PRELOAD_PATH, ENTRY_PATH, 'daemon', 'start', '--foreground', '--project', projectRoot],
      {
        // cwd=projectRoot so preflight/findLazyRoot don't climb up to the
        // parent worktree and probe .lazy there (causing EROFS in sandboxed
        // test runs where the worktree is read-only).
        cwd: projectRoot,
        stdin: 'ignore',
        stdout: logHandle.fd,
        stderr: logHandle.fd,
        env: {
          ...process.env,
          LAZY_PROTOCOL_BASE: protocolBase,
          // Fake auth so agent launches in the daemon don't fail on getAuthEnvVars()
          ANTHROPIC_API_KEY: 'sk-test-fake-key-for-testing',
          // Activate preload-mocks.ts inside the daemon process itself. The
          // daemon runs task launches (createRunner, checkDocker, supervisor
          // spawn) in-process; without mocks loaded here those calls hit the
          // real docker binary / real capture/claude.ts and fail. Value is
          // a default "success" response — per-test mock overrides set by
          // runLazyMocked don't propagate into the already-running daemon,
          // but that's fine: start/accept tests only need the launch to
          // succeed, not a specific transcript.
          LAZY_MOCK_CLAUDE_RESPONSE: JSON.stringify({
            result: 'Mock daemon task completion',
            session_id: 'mock-sess-daemon',
            usage: { input_tokens: 100, output_tokens: 200 },
          }),
          // extraEnv last so callers can override anything above (e.g.
          // LAZY_MOCK_ACCEPT_GATES='[]' to activate the remote mock inside
          // the daemon for accept-gates tests).
          ...extraEnv,
        },
      },
    );
    proc.unref();
  } finally {
    await logHandle.close();
  }

  const ready = await waitForDaemon(projectRoot, 4_000);
  if (!ready) {
    const { readFile } = await import('fs/promises');
    let diag = '';
    try { diag = await readFile(startupLogPath, 'utf8'); } catch { /* ignore */ }
    throw new Error(
      `Test daemon failed to start for ${projectRoot}\n` +
      `Startup log:\n${diag.slice(-2000)}`,
    );
  }
}

/**
 * Stop any daemon running for the given project. Best-effort: reads the
 * pidfile and sends SIGTERM, then SIGKILL if the process refuses to exit.
 * Always safe to call — does nothing if no daemon is running.
 */
async function stopTestDaemon(projectRoot: string): Promise<void> {
  const pid = readPid(projectRoot);
  if (pid === null) return;

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Process already gone
    return;
  }

  // Give it up to 2s to exit cleanly
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 100));
    try {
      process.kill(pid, 0);
    } catch {
      return; // exited
    }
  }

  // Still alive — force-kill
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // already gone
  }
}

/**
 * Create an isolated test lazy project: temp dir with git repo + `lazy init`.
 * Call cleanup() in afterEach to remove it.
 */
export async function setupTestLazy(options: SetupOptions = {}): Promise<TestContext> {
  // CRITICAL: canonicalize to the realpath. On macOS, tmpdir() is the symlink
  // /var/folders/... whose realpath is /private/var/folders/.... A daemon
  // auto-started by an inner CLI call derives its project root from
  // process.cwd()/findLazyRoot, which the OS resolves to the /private realpath,
  // and keys all its state (pidfile, socket, daemon dir) under that realpath's
  // slug. If `root` here stayed the /var symlink path, stopTestDaemon(),
  // rm(getDaemonDir(root)), and the safety net would all compute the WRONG slug
  // and never find — let alone kill — the daemon. That single divergence is what
  // leaked 100+ stray daemons. Resolving root once makes every slug agree with
  // the daemon's own.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lazy-e2e-')));
  const protocolBase = await mkdtemp(join(tmpdir(), 'lazy-e2e-protocol-'));

  // Arm the process-death safety net for this root BEFORE any CLI call can
  // auto-start a daemon (e.g. `lazy init` below). If `afterEach`/cleanup() never
  // runs, the registry's exit/SIGINT/SIGTERM handlers reap this root's daemon.
  registerTestDaemonRoot(root);

  // Set LAZY_PROTOCOL_BASE for in-process protocol calls (e.g. getProtocolDir in tests)
  process.env.LAZY_PROTOCOL_BASE = protocolBase;

  // Initialize git repo
  spawnGit(root, 'init');
  spawnGit(root, 'config', 'user.email', 'test@lazy.test');
  spawnGit(root, 'config', 'user.name', 'Lazy Test');
  spawnGit(root, 'checkout', '-b', 'main');

  // Create initial file and commit (worktrees require at least one commit)
  await writeFile(join(root, 'README.md'), '# Test Project\n');
  spawnGit(root, 'add', '.');
  spawnGit(root, 'commit', '-m', 'Initial commit');

  // Run `lazy init` (skip auth/github checks, non-interactive for piped test env)
  const initResult = await runLazy(root, ['init', '--skip-auth-check', '--skip-github-check', '--non-interactive'], protocolBase, options.withDaemon === true);
  if (initResult.exitCode !== 0) {
    throw new Error(`lazy init failed: ${initResult.stderr}\n${initResult.stdout}`);
  }

  // Commit lazy initialization so worktrees can branch from here
  spawnGit(root, 'add', '.');
  spawnGit(root, 'commit', '-m', 'Initialize lazy');

  if (options.withDaemon) {
    await startTestDaemon(root, protocolBase, options.daemonEnv);
  }

  const ctx: TestContext = {
    root,
    protocolBase,
    lazy: (args, optsArg) => runLazy(root, args, protocolBase, options.withDaemon === true, optsArg?.env, optsArg?.input),
    lazyMocked: (args, mockResponse, optsArg) =>
      runLazyMocked(root, args, mockResponse, protocolBase, options.withDaemon === true, optsArg?.env, optsArg?.input),
    git: (...args) => spawnGit(root, ...args),
    cleanup: async () => {
      // Always stop any daemon that was spawned for this project — either
      // explicitly via withDaemon or implicitly auto-started by a CLI call
      // (ensureDaemon in src/daemon/auto-start.ts). Without this the daemon
      // outlives the temp dir and leaks its TCP port (we've seen 248 orphan
      // daemons exhaust the 26024–26123 range across repeated test runs).
      await stopTestDaemon(root);

      // Daemon is stopped — the safety net no longer needs to track this root.
      unregisterTestDaemonRoot(root);

      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(protocolBase, { recursive: true, force: true }),
        rm(getDaemonDir(root), { recursive: true, force: true }),
      ]);
    },
  };

  return ctx;
}
