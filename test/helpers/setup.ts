/**
 * E2E test setup helpers
 *
 * Provides a TestContext that creates an isolated temp git repo with lazy
 * initialized. Tests run the real CLI via subprocess for maximum fidelity.
 */

import { basename, join, resolve } from 'path';
import { mkdtemp, rm, writeFile, readFile, realpath } from 'fs/promises';
import { tmpdir } from 'os';
import { waitForDaemon, readPid, getDaemonDir } from '../../src/daemon';
import { TEST_PARENT_PID_ENV } from '../../src/daemon/test-parent-watch';
import { registerTestDaemonRoot, unregisterTestDaemonRoot, killDaemonsForRoot } from './daemon-registry';
import { storageDirFor } from './storage';
import {
  installFakeClaude,
  setClaudeScenario,
  readClaudeInvocations,
  clearClaudeInvocations,
  type ClaudeInvocation,
  type ClaudeScenarioFile,
  type FakeClaude,
} from './fake-claude';

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

  // --- fake-claude seam (only present with `setupTestLazy({ fakeClaude: true })`) ---

  /**
   * Script what the fake `claude` binary does on its next invocation(s).
   *
   * Throws when the context was not created with `fakeClaude: true` — silently
   * doing nothing would let a test "pass" while the real agent seam was never
   * installed.
   */
  setClaudeScenario: (scenario: ClaudeScenarioFile) => Promise<void>;
  /** Every fake-agent invocation so far, with the argv lazy actually passed. */
  claudeInvocations: () => Promise<ClaudeInvocation[]>;
  /** Forget recorded invocations (e.g. between two turns of one test). */
  clearClaudeInvocations: () => Promise<void>;
  /**
   * Directory holding the fake `claude` executable. A test that spawns its own
   * subprocess (rather than going through `ctx.lazy`) must prepend this to that
   * process's PATH — the harness's own PATH override lives in a private
   * `baseEnv`, so `process.env.PATH` does NOT contain it and a naive
   * `PATH: ${myBin}:${process.env.PATH}` silently runs the REAL claude.
   *
   * Undefined unless the context was created with `fakeClaude: true`.
   */
  fakeClaudeBinDir?: string;

  /**
   * `LAZY_SCRATCH_BASE_DIR` for every process this context spawns — a temp dir,
   * so builder scratch dirs never land in the developer's real ~/.lazy/scratch.
   * A test that needs this project's scratch path must derive it with THIS base
   * (the harness's own env override is private, like `fakeClaudeBinDir`'s PATH).
   */
  scratchBaseDir: string;
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
  /**
   * Install a scriptable fake `claude` binary on PATH instead of mocking
   * lazy's own `capture/claude` module, and switch the project to the
   * host-process runner so the REAL supervisor runs.
   *
   * This is the low-level agent seam (see test/helpers/fake-claude.ts). With it
   * on, `lazy start` goes daemon → HostProcessRunner → a real `lazy supervise`
   * subprocess → `execWithWatchdog` → the fake binary. Nothing in `src/` is
   * mocked, which is what makes the watchdog, kill protocol, stream-json
   * parsing, and response capture reachable from an e2e test at all.
   *
   * Implies `withDaemon: true` (the supervisor is launched by the daemon), and
   * suppresses the module-mock preload for every process this context spawns.
   */
  fakeClaude?: boolean;

  /**
   * Host permission posture for the `fakeClaude` runner. Default `'bypass'`.
   *
   * `'sandbox'` is the PRODUCTION default: the agent is launched inside Claude
   * Code's bubblewrap sandbox, which needs `bwrap` and `socat` on PATH (see
   * CLAUDE.md's Linux prerequisites). Suites asserting on watchdog behavior use
   * `'bypass'` so a missing sandbox dependency cannot masquerade as a watchdog
   * failure; a suite whose subject IS the sandbox asks for `'sandbox'`.
   *
   * Ignored unless `fakeClaude` is set.
   */
  hostPermissionMode?: 'sandbox' | 'bypass';
}

/**
 * Every process this harness spawns declares the `bun test` process as its test
 * parent, so any daemon that inherits the variable — started explicitly by
 * `startTestDaemon`, or implicitly by `ensureDaemon` inside one of these
 * subprocesses — shuts itself down once the test run is gone.
 *
 * This is the only reaper that still works when the `bun test` process is
 * SIGKILLed (sweep timeout, OOM, `kill -9`): both `ctx.cleanup()` and the
 * process-death net in daemon-registry.ts live INSIDE that process. It is also
 * the only one that can catch a daemon auto-started by a straggler subprocess
 * AFTER its test's cleanup already ran and unregistered the root.
 *
 * Placed before `extraEnv` in every env literal so a test that is exercising the
 * guard itself can point it at a different pid.
 */
const testParentEnv: Record<string, string> = { [TEST_PARENT_PID_ENV]: String(process.pid) };

/**
 * The `LAZY_TEST` / `LAZY_IS_DAEMON` settings every process this context spawns
 * must run with.
 *
 * Both branches are EXPLICIT on purpose. A `withDaemon: true` context used to
 * merely *not set* the variable and inherit whatever the `bun test` process had
 * — which is fine in a single-file run and wrong in an aggregate one, because
 * `process.env` is shared across every test file in the run. Any daemonless
 * suite that ran earlier and declared in-process test mode left `LAZY_TEST=1`
 * behind; the daemon-backed suite's children then inherited it, took the
 * in-process RPC bypass instead of talking to the test daemon, opened storage
 * directly, and deadlocked against the daemon holding `.storage-lock`. The
 * failures land in `createTask` and point nowhere near the cause.
 *
 * `enableInProcessTestMode` is now suite-scoped so it cannot leak, but pinning
 * the value here makes a daemon-backed context immune to ANY stray `LAZY_TEST`
 * in the parent env, including sources nobody has found yet. `''` is the
 * established spelling for "off" in this repo (see
 * `test/e2e/daemon-credential-gate.test.ts`) and is equivalent to unset for
 * production readers: they test `=== '1'` or plain truthiness, and `''` is
 * falsy.
 *
 * `LAZY_IS_DAEMON` is pinned off for the same reason, and it is not
 * hypothetical: `startDaemonServer()` sets it on whatever process calls it, and
 * a dozen suites call it IN-PROCESS to drive a real daemon over a unix socket.
 * The flag survives their `stop()` and the file itself, and it means "never RPC
 * myself" — so a later daemon-backed suite's CLI children skipped the socket
 * entirely and exited "Daemon is not running" against a daemon that was running
 * fine. See test/helpers/in-process-daemon.ts for the measured repro. Pinned in
 * BOTH branches: no process this harness spawns is ever the daemon (the test
 * daemon sets the flag for itself inside startDaemonServer), so inheriting a
 * stray `1` can only ever be wrong.
 */
function withDaemonTestEnv(withDaemon: boolean): Record<string, string> {
  return withDaemon
    ? { LAZY_TEST: '', LAZY_IS_DAEMON: '' }
    : { LAZY_TEST: '1', LAZY_IS_DAEMON: '' };
}

function spawnGit(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.exitCode,
  };
}

async function runLazy(cwd: string, args: string[], protocolBase: string, withDaemon: boolean, extraEnv?: Record<string, string>, input?: string, baseEnv?: Record<string, string>): Promise<WorkResult> {
  // Symmetric with runLazyMocked: in a daemonless suite, LAZY_TEST=1 keeps
  // `ctx.lazy` from auto-starting a daemon (ensureDaemon bypasses under
  // LAZY_TEST). Without it, a plain `ctx.lazy(['create'])` (e.g. createTask)
  // spins up a daemon that holds .storage-lock, then any LAZY_TEST subprocess
  // OR in-process createStorage() in the same suite deadlocks retrying that
  // lock for 5s — the deterministic breakage behind the daemonless reconcile
  // suites. withDaemon suites must NOT set it: `ctx.lazy` has to reach the
  // real daemon for storage.
  const lazyTestEnv = withDaemonTestEnv(withDaemon);
  const proc = Bun.spawn(['bun', 'run', ENTRY_PATH, ...args], {
    cwd,
    stdin: input !== undefined ? new Blob([input]) : undefined,
    stdout: 'pipe',
    stderr: 'pipe',
    // Provide fake auth so the daemon credential gate (the single enforcement
    // point) lets the implicitly auto-started daemon come up. Mirrors
    // runLazyMocked/startTestDaemon. Placed BEFORE extraEnv so individual tests
    // can clear it (e.g. ANTHROPIC_API_KEY: '') to exercise the gate.
    env: { ...process.env, ...baseEnv, ...testParentEnv, ANTHROPIC_API_KEY: 'sk-test-fake-key-for-testing', LAZY_PROTOCOL_BASE: protocolBase, ...lazyTestEnv, ...extraEnv },
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
  baseEnv?: Record<string, string>,
): Promise<WorkResult> {
  // When a real daemon is running for this test, LAZY_TEST=1 must NOT be set —
  // it would short-circuit tryRemoteStorage/tryRpc and bypass the daemon,
  // defeating the whole point of `withDaemon`. Mocks still activate because
  // preload-mocks.ts also checks for LAZY_MOCK_CLAUDE_RESPONSE.
  const lazyTestEnv = withDaemonTestEnv(withDaemon);

  const proc = Bun.spawn(['bun', 'run', '--preload', PRELOAD_PATH, ENTRY_PATH, ...args], {
    cwd,
    stdin: input !== undefined ? new Blob([input]) : undefined,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      ...baseEnv,
      ...testParentEnv,
      // Provide fake auth so getAuthEnvVars() doesn't fail. This is a DEFAULT —
      // it precedes extraEnv so a test that deliberately exercises the
      // no-credential path (e.g. the upgrade credential preflight) can clear it.
      // Same precedence as runLazy.
      ANTHROPIC_API_KEY: 'sk-test-fake-key-for-testing',
      ...extraEnv,
      ...lazyTestEnv,
      LAZY_PROTOCOL_BASE: protocolBase,
      LAZY_MOCK_CLAUDE_RESPONSE: JSON.stringify(mockResponse),
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
async function startTestDaemon(
  projectRoot: string,
  protocolBase: string,
  extraEnv: Record<string, string> = {},
  /**
   * When true the daemon runs WITHOUT the module-mock preload: the fake-claude
   * seam replaces the agent binary instead of lazy's own modules, so preloading
   * the mock would defeat the point (it would stub out the very supervisor
   * launch path under test). `baseEnv` carries the PATH that puts the fake
   * binary ahead of any real `claude`.
   */
  options: { noPreload?: boolean; baseEnv?: Record<string, string> } = {},
): Promise<void> {
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
    const daemonArgv = options.noPreload
      ? ['bun', 'run', ENTRY_PATH, 'daemon', 'start', '--foreground', '--project', projectRoot]
      : ['bun', 'run', '--preload', PRELOAD_PATH, ENTRY_PATH, 'daemon', 'start', '--foreground', '--project', projectRoot];

    const proc = Bun.spawn(
      daemonArgv,
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
          ...options.baseEnv,
          ...testParentEnv,
          // The daemon is the one process that must NEVER see LAZY_TEST=1 from
          // a poisoned parent: under it the daemon skips its flock, its
          // credential gate and its web bind, so the suite would be exercising
          // a different daemon than the one it thinks it started. Pinned to the
          // clean-run value rather than inherited. See withDaemonTestEnv().
          ...withDaemonTestEnv(true),
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
          // Under the fake-binary seam this var must NOT be set: it is the
          // activation switch for preload-mocks.ts, and the supervisor the
          // daemon spawns would inherit it. Nothing in lazy is mocked there.
          ...(options.noPreload ? {} : {
            LAZY_MOCK_CLAUDE_RESPONSE: JSON.stringify({
              result: 'Mock daemon task completion',
              session_id: 'mock-sess-daemon',
              usage: { input_tokens: 100, output_tokens: 200 },
            }),
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
 *
 * The pidfile is the fast path, not the only one: a daemon that crashed before
 * writing it, or whose daemon dir was already removed, would be invisible here.
 * So this always finishes with a process-table sweep for daemons serving this
 * exact root — the same check the process-death net uses.
 */
async function stopTestDaemon(projectRoot: string): Promise<void> {
  const pid = readPid(projectRoot);

  if (pid !== null) {
    let signalled = true;
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Process already gone — nothing to wait for.
      signalled = false;
    }

    if (signalled) {
      // Give it up to 2s to exit cleanly
      let alive = true;
      for (let i = 0; i < 20 && alive; i++) {
        await new Promise(r => setTimeout(r, 100));
        try {
          process.kill(pid, 0);
        } catch {
          alive = false;
        }
      }
      // Still alive — force-kill
      if (alive) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
    }
  }

  // Belt and suspenders: SIGKILL anything still serving this root that the
  // pidfile did not account for (stale/absent pidfile, or a second daemon
  // auto-started by a straggler CLI subprocess while teardown was running).
  killDaemonsForRoot(projectRoot);
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

  // The fake agent seam. Its state lives OUTSIDE `root` on purpose: a bin dir
  // and a scenario file inside the repo would show up as untracked changes and
  // trip lazy's own dirty-worktree checks.
  const useFakeClaude = options.fakeClaude === true;
  const withDaemon = options.withDaemon === true || useFakeClaude;
  let fakeClaudeDir: string | undefined;
  let fake: FakeClaude | undefined;
  let baseEnv: Record<string, string> | undefined;
  if (useFakeClaude) {
    fakeClaudeDir = await mkdtemp(join(tmpdir(), 'lazy-e2e-claude-'));
    fake = await installFakeClaude(fakeClaudeDir);
    // Prepend, so the fake shadows any real `claude` the developer has
    // installed. Everything this context spawns (CLI, daemon, and through the
    // daemon the supervisor and the agent) inherits this PATH.
    baseEnv = { PATH: `${fake.binDir}:${process.env.PATH ?? ''}` };
  }

  // Builder scratch dirs default to ~/.lazy/scratch/<project-slug>. Redirect the
  // whole base into a temp dir for every process this context spawns, the same
  // way LAZY_DAEMON_BASE_DIR redirects daemon state: a test must never create
  // (or report on, via `lazy doctor` / `lazy system status`) a directory in the
  // developer's real ~/.lazy/scratch.
  const scratchBase = await mkdtemp(join(tmpdir(), 'lazy-e2e-scratch-'));
  baseEnv = { ...(baseEnv ?? {}), LAZY_SCRATCH_BASE_DIR: scratchBase };

  // Arm the process-death safety net for this root BEFORE any CLI call can
  // auto-start a daemon (e.g. `lazy init` below). If `afterEach`/cleanup() never
  // runs, the registry's exit/SIGINT/SIGTERM handlers reap this root's daemon.
  registerTestDaemonRoot(root);

  // Set LAZY_PROTOCOL_BASE for in-process protocol calls (e.g. getProtocolDir in tests).
  //
  // This is the same shape as the LAZY_TEST leak (see withDaemonTestEnv): a
  // process-wide mutation in a process shared by every test file. Every child
  // gets the value passed explicitly, so the blast radius is in-process readers
  // only — but after cleanup() this pointed at a deleted temp dir for the rest
  // of the run, and a later suite reading it in-process got a path that no
  // longer exists. cleanup() restores it, guarded on the value still being ours
  // so an interleaved context that set its own is never clobbered.
  const priorProtocolBase = process.env.LAZY_PROTOCOL_BASE;
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
  const initResult = await runLazy(root, ['init', '--skip-auth-check', '--skip-github-check', '--non-interactive'], protocolBase, withDaemon, undefined, undefined, baseEnv);
  if (initResult.exitCode !== 0) {
    throw new Error(`lazy init failed: ${initResult.stderr}\n${initResult.stdout}`);
  }

  if (useFakeClaude) {
    // The fake-binary seam requires the host-process runner: it is the only
    // runner that launches the supervisor as a plain subprocess on this host,
    // where a PATH-shadowed `claude` is reachable at all. Docker mode would run
    // the agent inside a container that never sees our temp bin dir.
    //
    // permission_mode defaults to "bypass" because the production "sandbox"
    // posture needs bwrap + socat on Linux — a suite asserting on watchdog
    // behavior must not fail on a sandbox dependency. Suites whose subject IS
    // the sandbox pass hostPermissionMode: 'sandbox' to get the real posture.
    const permissionMode = options.hostPermissionMode ?? 'bypass';
    const configPath = join(root, 'lazy.toml');
    const config = await readFile(configPath, 'utf-8');
    const patched = config.replace(
      /^type\s*=\s*"docker"/m,
      `type = "dangerously-host-process-without-any-isolation"\npermission_mode = "${permissionMode}"`,
    );
    if (patched === config) {
      throw new Error('fakeClaude setup: could not find [runner] type = "docker" in the generated lazy.toml');
    }
    await writeFile(configPath, patched);
  }

  // Branch protection is opt-in (off by default), so the harness needs no
  // config injection: the accept suites exercise the unprotected default path
  // as-is. Protection tests opt in explicitly (see test/e2e/approve.test.ts
  // enableProtection helper).

  // Commit lazy initialization so worktrees can branch from here
  spawnGit(root, 'add', '.');
  spawnGit(root, 'commit', '-m', 'Initialize lazy');

  // `lazy init` writes an `external_path` into lazy.toml, so this project's
  // task state lives OUTSIDE the temp repo (default ~/.lazy/<project-name>).
  // Resolve it now so cleanup() can remove it — otherwise every e2e run leaves
  // a ~/.lazy/lazy-e2e-* directory behind on the developer's machine forever.
  const externalStorageDir = storageDirFor(root);

  if (withDaemon) {
    await startTestDaemon(root, protocolBase, options.daemonEnv, {
      noPreload: useFakeClaude,
      baseEnv,
    });
  }

  const ctx: TestContext = {
    root,
    protocolBase,
    lazy: (args, optsArg) => runLazy(root, args, protocolBase, withDaemon, optsArg?.env, optsArg?.input, baseEnv),
    lazyMocked: (args, mockResponse, optsArg) =>
      runLazyMocked(root, args, mockResponse, protocolBase, withDaemon, optsArg?.env, optsArg?.input, baseEnv),
    git: (...args) => spawnGit(root, ...args),
    setClaudeScenario: async (scenario) => {
      if (!fake) throw new Error('setClaudeScenario requires setupTestLazy({ fakeClaude: true })');
      await setClaudeScenario(fake, scenario);
    },
    claudeInvocations: async () => {
      if (!fake) throw new Error('claudeInvocations requires setupTestLazy({ fakeClaude: true })');
      return readClaudeInvocations(fake);
    },
    fakeClaudeBinDir: fake?.binDir,
    scratchBaseDir: scratchBase,
    clearClaudeInvocations: async () => {
      if (!fake) throw new Error('clearClaudeInvocations requires setupTestLazy({ fakeClaude: true })');
      await clearClaudeInvocations(fake);
    },
    cleanup: async () => {
      // Always stop any daemon that was spawned for this project — either
      // explicitly via withDaemon or implicitly auto-started by a CLI call
      // (ensureDaemon in src/daemon/auto-start.ts). Without this the daemon
      // outlives the temp dir and leaks its TCP port (we've seen 248 orphan
      // daemons exhaust the 26024–26123 range across repeated test runs).
      await stopTestDaemon(root);

      // Daemon is stopped — the safety net no longer needs to track this root.
      unregisterTestDaemonRoot(root);

      // Don't leave LAZY_PROTOCOL_BASE pointing at the temp dir removed below.
      // Only restore if it is still the value this context set: a suite that
      // built a second context has already overwritten it, and stomping that
      // would be a new leak rather than a fix.
      if (process.env.LAZY_PROTOCOL_BASE === protocolBase) {
        if (priorProtocolBase === undefined) delete process.env.LAZY_PROTOCOL_BASE;
        else process.env.LAZY_PROTOCOL_BASE = priorProtocolBase;
      }

      // Guard: only ever remove a storage dir this harness could have created.
      // Test roots come from mkdtemp('lazy-e2e-'), so the derived project name
      // always carries that prefix — a real project's ~/.lazy/<name> can never
      // match, no matter how cleanup is called.
      const removableStorage = basename(externalStorageDir).startsWith('lazy-e2e-')
        ? [rm(externalStorageDir, { recursive: true, force: true })]
        : [];

      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(protocolBase, { recursive: true, force: true }),
        rm(getDaemonDir(root), { recursive: true, force: true }),
        ...(fakeClaudeDir ? [rm(fakeClaudeDir, { recursive: true, force: true })] : []),
        rm(scratchBase, { recursive: true, force: true }),
        ...removableStorage,
      ]);
    },
  };

  return ctx;
}
