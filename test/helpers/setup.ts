/**
 * E2E test setup helpers
 *
 * Provides a TestContext that creates an isolated temp git repo with lazy
 * initialized. Tests run the real CLI via subprocess for maximum fidelity.
 */

import { basename, join, resolve } from 'path';
import { mkdtemp, rm, writeFile, readFile, realpath } from 'fs/promises';
import { tmpdir, homedir } from 'os';
import { waitForDaemon, readPid, getDaemonDir, SIGNAL_SHUTDOWN_BUDGET_MS } from '../../src/daemon';
import { TEST_PARENT_PID_ENV } from '../../src/daemon/test-parent-watch';
import {
  registerTestDaemonRoot,
  unregisterTestDaemonRoot,
  registerTestOneshotDir,
  killDaemonsForRoot,
  findSupervisorTargetsForRoot,
  signalSupervisorTarget,
  isSupervisorTargetAlive,
  killOneshotClaudeUnderDirs,
  findOneshotClaudeUnderDirs,
} from './daemon-registry';
import { storageDirFor } from './storage';
import {
  installFakeClaude,
  setClaudeScenario,
  readClaudeInvocations,
  clearClaudeInvocations,
  recordClaudeEnvKeys,
  type ClaudeInvocation,
  type ClaudeScenarioFile,
  type FakeClaude,
} from './fake-claude';
import {
  installFakeCursor,
  setCursorScenario,
  readCursorInvocations,
  clearCursorInvocations,
  recordCursorEnvKeys,
  type CursorInvocation,
  type CursorScenarioFile,
  type FakeCursor,
} from './fake-cursor';
import {
  installFakePi,
  setPiScenario,
  readPiInvocations,
  clearPiInvocations,
  recordPiEnvKeys,
  type PiInvocation,
  type PiScenarioFile,
  type FakePi,
} from './fake-pi';
import {
  installFakeCodex,
  setCodexScenario,
  readCodexInvocations,
  clearCodexInvocations,
  recordCodexEnvKeys,
  type CodexInvocation,
  type CodexScenarioFile,
  type FakeCodex,
} from './fake-codex';

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
  /**
   * Working directory for the command. Defaults to the test project root. Set
   * it to a task worktree to exercise the commands that behave differently when
   * run from inside one (the worktree Dockerfile prompts).
   */
  cwd?: string;
}

export interface TestContext {
  /** Absolute path to the temporary test directory (git repo root) */
  root: string;
  /** Absolute path to the temporary protocol base directory */
  protocolBase: string;
  /**
   * The private `HOME` given to every process this context spawns, when one was
   * created (the `fakeClaude` / real-runner seams). Undefined otherwise.
   *
   * Exposed so a suite can reach the state a supervisor writes under `$HOME` —
   * notably the host-process runner's pidfiles in `$HOME/.lazy/run`, which is
   * the only way to ask "which process IS this run?" and therefore the only way
   * to simulate a run dying without going through lazy.
   */
  agentHome?: string;
  /** Run a `lazy` CLI command in this test context */
  lazy: (args: string[], options?: LazyOptions) => Promise<WorkResult>;
  /** Run a `lazy` CLI command with Claude/Docker mocked */
  lazyMocked: (args: string[], mockResponse: MockAgentResponse, options?: LazyOptions) => Promise<WorkResult>;
  /** Run raw git commands in the test directory */
  git: (...args: string[]) => { stdout: string; stderr: string; exitCode: number };
  /**
   * Restart this context's daemon with extra environment, keeping every seam
   * the context was created with (the module-mock preload, the fake-agent PATH,
   * the private HOME).
   *
   * Exists for the one thing a daemon's environment decides and a request
   * cannot: MANAGED MODE. A suite covering the managed posture has to arm it in
   * the daemon's own environment, and the store path it must also pass is only
   * known after `lazy init` has run — so it cannot be given at setup time.
   * Restarting through `lazy daemon start` instead would start a daemon
   * WITHOUT the preload, which silently sends every task launch at the real
   * docker binary.
   *
   * Throws when the context has no daemon: silently doing nothing would let a
   * managed-mode assertion pass against an unmanaged daemon.
   */
  restartDaemon: (extraEnv?: Record<string, string>) => Promise<void>;
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
   * Ask the fake agent to echo these env keys back on every invocation, so a
   * test can assert on the agent's OWN process environment (see
   * `ClaudeInvocation.env`) rather than on the argv lazy composed.
   */
  recordClaudeEnvKeys: (keys: string[]) => Promise<void>;
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

  // --- fake-cursor seam (only present with `setupTestLazy({ fakeCursor: true })`) ---

  /**
   * Script what the fake `cursor-agent` binary does on its next invocation(s).
   *
   * Throws when the context was not created with `fakeCursor: true`, for the
   * same reason `setClaudeScenario` does.
   */
  setCursorScenario: (scenario: CursorScenarioFile) => Promise<void>;
  /** Every fake-`cursor-agent` invocation so far, with the argv lazy passed. */
  cursorInvocations: () => Promise<CursorInvocation[]>;
  /** Forget recorded cursor invocations (e.g. between two turns of one test). */
  clearCursorInvocations: () => Promise<void>;
  /** Echo these env keys back on every fake-`cursor-agent` invocation. */
  recordCursorEnvKeys: (keys: string[]) => Promise<void>;
  /**
   * Directory holding the fake `cursor-agent` executable — the cursor twin of
   * `fakeClaudeBinDir`, with the same caveat about `process.env.PATH`.
   *
   * Undefined unless the context was created with `fakeCursor: true`.
   */
  fakeCursorBinDir?: string;

  // --- fake-pi seam (only present with `setupTestLazy({ fakePi: true })`) ---

  /** Script what the fake `pi` binary does on its next invocation(s). */
  setPiScenario: (scenario: PiScenarioFile) => Promise<void>;
  /** Every fake-`pi` invocation so far, with the argv lazy passed. */
  piInvocations: () => Promise<PiInvocation[]>;
  /** Forget recorded pi invocations (e.g. between two turns of one test). */
  clearPiInvocations: () => Promise<void>;
  /** Echo these env keys back on every fake-`pi` invocation. */
  recordPiEnvKeys: (keys: string[]) => Promise<void>;
  /**
   * Directory holding the fake `pi` executable — same caveat as
   * `fakeClaudeBinDir` about `process.env.PATH`. Undefined unless the context
   * was created with `fakePi: true`.
   */
  fakePiBinDir?: string;

  // --- fake-codex seam (only present with `setupTestLazy({ fakeCodex: true })`) ---

  /**
   * Script what the fake `codex` binary does on its next invocation(s).
   *
   * Throws when the context was not created with `fakeCodex: true`, for the
   * same reason `setClaudeScenario` does.
   */
  setCodexScenario: (scenario: CodexScenarioFile) => Promise<void>;
  /** Every fake-`codex` invocation so far, with the argv lazy passed. */
  codexInvocations: () => Promise<CodexInvocation[]>;
  /** Forget recorded codex invocations (e.g. between two turns of one test). */
  clearCodexInvocations: () => Promise<void>;
  /** Echo these env keys back on every fake-`codex` invocation. */
  recordCodexEnvKeys: (keys: string[]) => Promise<void>;
  /**
   * Directory holding the fake `codex` executable — the codex twin of
   * `fakeClaudeBinDir`, with the same caveat about `process.env.PATH`.
   *
   * Undefined unless the context was created with `fakeCodex: true`.
   */
  fakeCodexBinDir?: string;

  /**
   * `LAZY_SCRATCH_BASE_DIR` for every process this context spawns — a temp dir,
   * so builder scratch dirs never land in the developer's real ~/.lazy/scratch.
   * A test that needs this project's scratch path must derive it with THIS base
   * (the harness's own env override is private, like `fakeClaudeBinDir`'s PATH).
   */
  scratchBaseDir: string;

  /**
   * `LAZY_ONESHOT_BASE_DIR` for every process this context spawns — a temp dir
   * holding the cwd machine one-shots run in (see src/oneshot/state-dir.ts).
   * Exposed for the same reason as `scratchBaseDir`: a suite asserting on WHERE
   * the accept-time one-shot ran needs the base the harness actually pinned.
   */
  oneshotBaseDir: string;

  /**
   * `LAZY_PASSPHRASE_BASE_DIR` for every process this context spawns — a temp
   * dir standing in for ~/.lazy, so an e2e run never reads or overwrites the
   * developer's own enrolled approval passphrase. Use `enrollPassphrase` from
   * test/helpers/passphrase.ts rather than composing this path by hand.
   */
  passphraseBaseDir: string;
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
   * The same seam, for cursor: install a scriptable fake `cursor-agent` on PATH
   * (see test/helpers/fake-cursor.ts) and point the project's `[agent] agent_id`
   * at `"cursor"`, so a real turn goes daemon → HostProcessRunner →
   * `lazy supervise` → `CursorAgent` → the fake binary.
   *
   * Gives the same guarantees as `fakeClaude`: implies `withDaemon: true`,
   * switches to the host-process runner, suppresses the module-mock preload, and
   * gives every process a private temp `HOME` (a cursor turn writes
   * `~/.cursor/mcp.json` and `~/.cursor/cli-config.json` on every turn — the
   * same collateral `fakeClaude`'s HOME exists to contain).
   *
   * Mutually exclusive with `fakeClaude`: one PATH, one `agent_id`, one project.
   */
  fakeCursor?: boolean;

  /**
   * The same seam, for pi: install a scriptable fake `pi` on PATH (see
   * test/helpers/fake-pi.ts) and point the project's `[agent] agent_id` at
   * `"pi"`. Same guarantees and same mutual exclusivity as `fakeCursor` (a pi
   * turn writes `~/.pi/agent/models.json` and the lazy MCP bridge extension on
   * every turn — the collateral the private HOME contains).
   */
  fakePi?: boolean;

  /**
   * The same seam, for codex: install a scriptable fake `codex` on PATH (see
   * test/helpers/fake-codex.ts) and point the project's `[agent] agent_id` at
   * `"codex"`, so a real turn goes daemon → HostProcessRunner →
   * `lazy supervise` → `CodexAgent` → the fake binary.
   *
   * Same guarantees as `fakeClaude`/`fakeCursor` (implied daemon, host-process
   * runner, no module mock, private temp HOME — a codex turn writes
   * `~/.codex/config.toml` on every turn). Mutually exclusive with both.
   */
  fakeCodex?: boolean;

  /**
   * Host permission posture for the `fakeClaude` runner. Default `'bypass'`.
   *
   * `'sandbox'` is the PRODUCTION default: the agent is launched inside Claude
   * Code's bubblewrap sandbox, which needs `bwrap` and `socat` on PATH (see
   * CLAUDE.md's Linux prerequisites). Suites asserting on watchdog behavior use
   * `'bypass'` so a missing sandbox dependency cannot masquerade as a watchdog
   * failure; a suite whose subject IS the sandbox asks for `'sandbox'`.
   *
   * Ignored unless `fakeClaude` or `fakeCursor` is set.
   */
  hostPermissionMode?: 'sandbox' | 'bypass';

  /**
   * Allow the internal host-process runner in lazy.toml for this context
   * (`LAZY_ALLOW_HOST_RUNNER=1` in baseEnv). Use when a suite needs pid-file
   * liveness or builder availability without Docker but is not exercising the
   * full fake-binary supervisor seam. Implied by `fakeClaude: true`.
   */
  allowHostRunner?: boolean;
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
 * the task. Waits for the daemon's TCP port to become responsive before returning.
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
      // Allow the daemon its whole signal-shutdown budget plus a second for the
      // exit itself. This is the tightest and most frequent case of a healthy
      // daemon being signalled, and the old flat 2s force-killed it partway
      // through the shutdown it had just started — before it stopped this
      // project's agents, recorded why their turns ended, or closed storage.
      const steps = Math.ceil((SIGNAL_SHUTDOWN_BUDGET_MS + 1_000) / 100);
      let alive = true;
      for (let i = 0; i < steps && alive; i++) {
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
 * Stop every `lazy supervise` process working inside this project, and the agent
 * each one spawned.
 *
 * Runs AFTER the daemon is stopped, so the reconciler cannot relaunch a
 * supervisor between the sweep and the end of teardown.
 *
 * Only the host-process runner (`fakeClaude: true`) puts a supervisor on this
 * host at all; for every other context this is a no-op process-table scan.
 * Graceful first — a supervisor mid-turn should get its SIGTERM handler — then
 * SIGKILL whatever ignored it, the same escalation stopTestDaemon uses.
 *
 * The targets are snapshotted BEFORE the first signal and reused for the
 * escalation, because that is the only moment a supervisor's process group can
 * be read: the SIGTERM kills the group's leader, and a second scan would find
 * neither the supervisor nor the agent it orphaned. Reaping by pid and calling
 * it done is what left fake agents alive for the rest of a `bun test` run.
 */
async function stopTestSupervisors(projectRoot: string): Promise<void> {
  const targets = findSupervisorTargetsForRoot(projectRoot);
  if (targets.length === 0) return;
  for (const target of targets) signalSupervisorTarget(target, 'SIGTERM');

  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 100));
    if (!targets.some(isSupervisorTargetAlive)) return;
  }

  for (const target of targets) signalSupervisorTarget(target, 'SIGKILL');
}

/**
 * Stop every machine one-shot (`claude -p`, see src/oneshot) still standing
 * inside this context's directories.
 *
 * Only the HOST runner leaves one of these behind: a containerized one-shot is a
 * `--rm` container carrying the project label, reaped with the rest of them.
 *
 * Runs AFTER the daemon and its supervisors are stopped, so nothing can spawn a
 * fresh one behind the sweep. Same escalation as the supervisor sweep: SIGTERM,
 * a short wait, then SIGKILL for whatever ignored it.
 *
 * Unlike a leaked supervisor, a leaked one-shot is NOT routine — every one is
 * bounded by default now, so finding one here means a run outlived its own
 * timeout or was never bounded at all. That is worth seeing, so the sweep prints
 * one line when it finds something, and stays silent (the overwhelmingly common
 * case) when it does not.
 */
async function stopTestOneshots(dirs: string[]): Promise<void> {
  const signalled = killOneshotClaudeUnderDirs(dirs, undefined, 'SIGTERM');
  if (signalled.length === 0) return;

  process.stderr.write(
    `setup: reaped ${signalled.length} stranded machine one-shot(s) in teardown: ${signalled.join(', ')}\n`,
  );

  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 100));
    if (findOneshotClaudeUnderDirs(dirs).length === 0) return;
  }

  killOneshotClaudeUnderDirs(dirs);
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
  // and keys all its state (pidfile, markers, daemon dir) under that realpath's
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
  const useFakeCursor = options.fakeCursor === true;
  const useFakePi = options.fakePi === true;
  const useFakeCodex = options.fakeCodex === true;
  if ((useFakeClaude ? 1 : 0) + (useFakeCursor ? 1 : 0) + (useFakePi ? 1 : 0) + (useFakeCodex ? 1 : 0) > 1) {
    throw new Error(
      'setupTestLazy: fakeClaude, fakeCursor, fakePi and fakeCodex are mutually exclusive — a ' +
        'project has one [agent] agent_id, and only that agent\'s binary is ever launched.',
    );
  }
  // Any fake installs the same seam (host-process runner, real supervisor,
  // no module mock, private HOME); only the binary and the project's agent_id
  // differ. Everything below therefore branches on `useFakeAgent`.
  const useFakeAgent = useFakeClaude || useFakeCursor || useFakePi || useFakeCodex;
  const withDaemon = options.withDaemon === true || useFakeAgent;
  let fakeAgentDir: string | undefined;
  let fake: FakeClaude | undefined;
  let cursorFake: FakeCursor | undefined;
  let piFake: FakePi | undefined;
  let codexFake: FakeCodex | undefined;
  let baseEnv: Record<string, string> | undefined;
  let agentHome: string | undefined;
  if (useFakeAgent) {
    fakeAgentDir = await mkdtemp(join(
      tmpdir(),
      useFakeCursor
        ? 'lazy-e2e-cursor-'
        : useFakePi
          ? 'lazy-e2e-pi-'
          : useFakeCodex
            ? 'lazy-e2e-codex-'
            : 'lazy-e2e-claude-',
    ));
    const installed = useFakeCursor
      ? (cursorFake = await installFakeCursor(fakeAgentDir))
      : useFakePi
        ? (piFake = await installFakePi(fakeAgentDir))
        : useFakeCodex
          ? (codexFake = await installFakeCodex(fakeAgentDir))
          : (fake = await installFakeClaude(fakeAgentDir));
    // Prepend, so the fake shadows any real agent binary the developer has
    // installed. Everything this context spawns (CLI, daemon, and through the
    // daemon the supervisor and the agent) inherits this PATH.
    baseEnv = {
      LAZY_ALLOW_HOST_RUNNER: '1',
      PATH: `${installed.binDir}:${process.env.PATH ?? ''}`,
    };

    // A PRIVATE HOME for every process this context spawns, and therefore for
    // every supervisor and agent below them. This is the only runner that runs a
    // supervisor on this host, and a supervisor writes real files into `$HOME`
    // on every turn:
    // `~/.claude.json` (the MCP server entry Claude Code reads),
    // `~/.claude/settings.json` (tool permissions), `~/.lazy/run/*.json`,
    // `~/.lazy/logs/*.log`. With the developer's HOME those writes are not
    // hypothetical collateral — the e2e suite was overwriting the `mcpServers.lazy`
    // entry of whoever ran it, pointing their agent's tool channel at a temp
    // worktree that cleanup then deleted.
    //
    // Redirecting HOME is otherwise a blunt instrument (see daemon-base-dir.ts),
    // so it is paired with an explicit LAZY_DAEMON_BASE_DIR for EVERY process in
    // the context: daemon state must stay where this test process will look for
    // it in cleanup(), not follow the daemon's new HOME. Suites that pin their
    // own base dir (pinDaemonBaseDir) must do so BEFORE setupTestLazy, which
    // every such suite already does — the value is read here.
    //
    // It must be EVERY process, not just the daemon: host-process supervisor
    // pidfiles live under `$HOME/.lazy/run`, and `lazy daemon restart` spawns
    // the next daemon from a CLI child. Giving only the first daemon the private
    // HOME left the restarted one enumerating a different `run` directory, so it
    // found no previous-generation children to reap and the orphaned supervisor
    // died of its own watchdog instead (daemon-restart-children).
    agentHome = await mkdtemp(join(tmpdir(), 'lazy-e2e-home-'));
    baseEnv.HOME = agentHome;
    baseEnv.LAZY_DAEMON_BASE_DIR =
      process.env.LAZY_DAEMON_BASE_DIR || join(process.env.HOME ?? homedir(), '.lazy', 'daemon');
  } else if (options.allowHostRunner) {
    baseEnv = { ...(baseEnv ?? {}), LAZY_ALLOW_HOST_RUNNER: '1' };
  }

  // Builder scratch dirs default to ~/.lazy/scratch/<project-slug>. Redirect the
  // whole base into a temp dir for every process this context spawns, the same
  // way LAZY_DAEMON_BASE_DIR redirects daemon state: a test must never create
  // (or report on, via `lazy doctor` / `lazy system status`) a directory in the
  // developer's real ~/.lazy/scratch.
  const scratchBase = await mkdtemp(join(tmpdir(), 'lazy-e2e-scratch-'));
  baseEnv = { ...(baseEnv ?? {}), LAZY_SCRATCH_BASE_DIR: scratchBase };

  // Same treatment for the machine one-shot cwd (~/.lazy/oneshot/<slug> — see
  // src/oneshot/state-dir.ts): a test must not create one of those in the
  // developer's real ~/.lazy, and — since Claude Code derives its session
  // directory from the cwd — must not leave a ~/.claude/projects entry per test
  // project either.
  const oneshotBase = await mkdtemp(join(tmpdir(), 'lazy-e2e-oneshot-'));
  baseEnv = { ...baseEnv, LAZY_ONESHOT_BASE_DIR: oneshotBase };

  // The approval passphrase store lives at ~/.lazy/passphrase.json (see
  // src/protection/passphrase-store.ts). Only fake-agent contexts get a
  // private HOME, so without this pin an ordinary e2e run would READ — and a
  // passphrase test would CLOBBER — the developer's own enrolled passphrase.
  // Pinned for every process this context spawns so the CLI (enrollment) and
  // the daemon (verification) agree on one store.
  const passphraseBase = await mkdtemp(join(tmpdir(), 'lazy-e2e-passphrase-'));
  baseEnv = { ...baseEnv, LAZY_PASSPHRASE_BASE_DIR: passphraseBase };

  // Fidelity synthesis is stubbed for every process this context spawns.
  //
  // "Agent responses are never real" held everywhere in the suite EXCEPT here:
  // accept's merge-description step runs `claude -p` from inside the daemon, and
  // the daemon deliberately does not see LAZY_TEST=1, so no mock reached it. On
  // a developer machine that meant every accept test called the real model; in a
  // container it meant a real `claude` aimed at the (already torn down) test
  // proxy, which answers nothing, ever — three accept e2e tests timed out at
  // step [8/11] "Generate merge description" for exactly this reason, and the
  // stranded `claude` processes outlived the run.
  //
  // Pinned in baseEnv (not withDaemonTestEnv) so `daemonEnv` still overrides it:
  // a suite whose subject IS the real one-shot path — where it runs, what it is
  // allowed to do — asks for `daemonEnv: { LAZY_SUMMARIZER_STUB: '' }` and gets
  // the real ClaudeSummarizer against the fake `claude` binary.
  baseEnv = { LAZY_SUMMARIZER_STUB: '1', ...baseEnv };

  // Arm the process-death safety net for this root BEFORE any CLI call can
  // auto-start a daemon (e.g. `lazy init` below). If `afterEach`/cleanup() never
  // runs, the registry's exit/SIGINT/SIGTERM handlers reap this root's daemon.
  registerTestDaemonRoot(root);
  // Same net, for the one directory a machine one-shot can stand in that is not
  // under `root` (see stopTestOneshots).
  registerTestOneshotDir(oneshotBase);

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

  if (useFakeAgent) {
    // The fake-binary seam requires the host-process runner: it is the only
    // runner that launches the supervisor as a plain subprocess on this host,
    // where a PATH-shadowed agent binary is reachable at all. Docker mode would
    // run the agent inside a container that never sees our temp bin dir.
    //
    // permission_mode defaults to "bypass" because the production "sandbox"
    // posture needs bwrap + socat on Linux — a suite asserting on watchdog
    // behavior must not fail on a sandbox dependency. Suites whose subject IS
    // the sandbox pass hostPermissionMode: 'sandbox' to get the real posture.
    const permissionMode = options.hostPermissionMode ?? 'bypass';
    const configPath = join(root, 'lazy.toml');
    const config = await readFile(configPath, 'utf-8');
    let patched = config.replace(
      /^type\s*=\s*"docker"/m,
      `type = "dangerously-host-process-without-any-isolation"\npermission_mode = "${permissionMode}"`,
    );
    if (patched === config) {
      throw new Error('fake-agent setup: could not find [runner] type = "docker" in the generated lazy.toml');
    }

    if (useFakeCursor || useFakePi || useFakeCodex) {
      // Point the project at the fake's agent by REWRITING the key `lazy init`
      // already wrote, per CLAUDE.md — appending a second `[agent]` table is a
      // TOML redefinition error, and overwriting the file would discard
      // `external_path`. The replace is checked: a silent no-op here would run
      // every turn as claude-code and the suite would fail nowhere near the
      // cause.
      const agentId = useFakeCursor ? 'cursor' : useFakePi ? 'pi' : 'codex';
      const before = patched;
      patched = patched.replace(/^agent_id\s*=\s*"claude-code"/m, `agent_id = "${agentId}"`);
      if (patched === before) {
        throw new Error(
          `fake${useFakeCursor ? 'Cursor' : useFakePi ? 'Pi' : 'Codex'} setup: no ` +
            '`agent_id = "claude-code"` line in the generated lazy.toml to rewrite — the lazy ' +
            'init template changed and this helper needs updating.',
        );
      }
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

  /** Compose this context's daemon environment, plus anything a caller adds. */
  function composeDaemonEnv(extra?: Record<string, string>): Record<string, string> | undefined {
    // The private HOME goes in FIRST so a suite that needs its own (e.g.
    // mcp-tools-fail-loud, which injects a deliberately broken one) still wins.
    let daemonEnv: Record<string, string> = agentHome
      ? { HOME: agentHome, ...(options.daemonEnv ?? {}), ...(extra ?? {}) }
      : { ...(options.daemonEnv ?? {}), ...(extra ?? {}) };
    // A suite that prepends fake-docker (or similar) via daemonEnv.PATH must not
    // drop the fake-agent bin dir baseEnv already placed ahead of the real binary.
    // Overriding PATH wholesale left fakeClaude suites hung in `working`: the
    // daemon could not find `claude` when launching the supervisor.
    //
    // Order matters: fake-docker first (one-shots), fake-agent second (must beat
    // any real `claude` on the system PATH), then the ambient PATH tail.
    if (daemonEnv?.PATH && baseEnv?.PATH) {
      const dockerBin = daemonEnv.PATH.split(':')[0];
      const fakeAgentBin = baseEnv.PATH.split(':')[0];
      daemonEnv = {
        ...daemonEnv,
        PATH: `${dockerBin}:${fakeAgentBin}:${process.env.PATH ?? ''}`,
      };
    }
    return Object.keys(daemonEnv).length > 0 ? daemonEnv : undefined;
  }

  if (withDaemon) {
    await startTestDaemon(root, protocolBase, composeDaemonEnv(), {
      noPreload: useFakeAgent,
      baseEnv,
    });
  }

  const ctx: TestContext = {
    root,
    protocolBase,
    agentHome,
    lazy: (args, optsArg) =>
      runLazy(optsArg?.cwd ?? root, args, protocolBase, withDaemon, optsArg?.env, optsArg?.input, baseEnv),
    lazyMocked: (args, mockResponse, optsArg) =>
      runLazyMocked(
        optsArg?.cwd ?? root,
        args,
        mockResponse,
        protocolBase,
        withDaemon,
        optsArg?.env,
        optsArg?.input,
        baseEnv,
      ),
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
    oneshotBaseDir: oneshotBase,
    passphraseBaseDir: passphraseBase,
    clearClaudeInvocations: async () => {
      if (!fake) throw new Error('clearClaudeInvocations requires setupTestLazy({ fakeClaude: true })');
      await clearClaudeInvocations(fake);
    },
    recordClaudeEnvKeys: async (keys) => {
      if (!fake) throw new Error('recordClaudeEnvKeys requires setupTestLazy({ fakeClaude: true })');
      await recordClaudeEnvKeys(fake, keys);
    },
    setCursorScenario: async (scenario) => {
      if (!cursorFake) throw new Error('setCursorScenario requires setupTestLazy({ fakeCursor: true })');
      await setCursorScenario(cursorFake, scenario);
    },
    cursorInvocations: async () => {
      if (!cursorFake) throw new Error('cursorInvocations requires setupTestLazy({ fakeCursor: true })');
      return readCursorInvocations(cursorFake);
    },
    clearCursorInvocations: async () => {
      if (!cursorFake) throw new Error('clearCursorInvocations requires setupTestLazy({ fakeCursor: true })');
      await clearCursorInvocations(cursorFake);
    },
    recordCursorEnvKeys: async (keys) => {
      if (!cursorFake) throw new Error('recordCursorEnvKeys requires setupTestLazy({ fakeCursor: true })');
      await recordCursorEnvKeys(cursorFake, keys);
    },
    fakeCursorBinDir: cursorFake?.binDir,
    setPiScenario: async (scenario) => {
      if (!piFake) throw new Error('setPiScenario requires setupTestLazy({ fakePi: true })');
      await setPiScenario(piFake, scenario);
    },
    piInvocations: async () => {
      if (!piFake) throw new Error('piInvocations requires setupTestLazy({ fakePi: true })');
      return readPiInvocations(piFake);
    },
    clearPiInvocations: async () => {
      if (!piFake) throw new Error('clearPiInvocations requires setupTestLazy({ fakePi: true })');
      await clearPiInvocations(piFake);
    },
    recordPiEnvKeys: async (keys) => {
      if (!piFake) throw new Error('recordPiEnvKeys requires setupTestLazy({ fakePi: true })');
      await recordPiEnvKeys(piFake, keys);
    },
    fakePiBinDir: piFake?.binDir,
    setCodexScenario: async (scenario) => {
      if (!codexFake) throw new Error('setCodexScenario requires setupTestLazy({ fakeCodex: true })');
      await setCodexScenario(codexFake, scenario);
    },
    codexInvocations: async () => {
      if (!codexFake) throw new Error('codexInvocations requires setupTestLazy({ fakeCodex: true })');
      return readCodexInvocations(codexFake);
    },
    clearCodexInvocations: async () => {
      if (!codexFake) throw new Error('clearCodexInvocations requires setupTestLazy({ fakeCodex: true })');
      await clearCodexInvocations(codexFake);
    },
    recordCodexEnvKeys: async (keys) => {
      if (!codexFake) throw new Error('recordCodexEnvKeys requires setupTestLazy({ fakeCodex: true })');
      await recordCodexEnvKeys(codexFake, keys);
    },
    fakeCodexBinDir: codexFake?.binDir,
    restartDaemon: async (extraEnv) => {
      if (!withDaemon) {
        throw new Error('restartDaemon requires setupTestLazy({ withDaemon: true })');
      }
      await stopTestDaemon(root);
      await startTestDaemon(root, protocolBase, composeDaemonEnv(extraEnv), {
        noPreload: useFakeAgent,
        baseEnv,
      });
    },
    cleanup: async () => {
      // Always stop any daemon that was spawned for this project — either
      // explicitly via withDaemon or implicitly auto-started by a CLI call
      // (ensureDaemon in src/daemon/auto-start.ts). Without this the daemon
      // outlives the temp dir and leaks its TCP port (we've seen 248 orphan
      // daemons exhaust the 26024–26123 range across repeated test runs).
      await stopTestDaemon(root);

      // Then the supervisors it launched. Killing the daemon does NOT kill
      // them: the host-process runner spawns each `lazy supervise` detached and
      // unref()'d, so a fakeClaude suite used to leave them running against
      // worktrees this cleanup is about to delete — and each surviving turn
      // rewrote the shared ~/.claude.json MCP entry another agent reads.
      await stopTestSupervisors(root);

      // And finally the `claude -p` one-shots either of them may have spawned:
      // a child of the process that ran it, with no pidfile, so neither of the
      // two sweeps above touches it. Both directories a one-shot can stand in
      // are swept — the project root (anything the daemon triggers) and this
      // context's one-shot base dir (the fidelity summarizer, which runs outside
      // every repository on purpose).
      await stopTestOneshots([root, oneshotBase]);

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
        ...(fakeAgentDir ? [rm(fakeAgentDir, { recursive: true, force: true })] : []),
        ...(agentHome ? [rm(agentHome, { recursive: true, force: true })] : []),
        rm(scratchBase, { recursive: true, force: true }),
        rm(oneshotBase, { recursive: true, force: true }),
        rm(passphraseBase, { recursive: true, force: true }),
        ...removableStorage,
      ]);
    },
  };

  return ctx;
}
