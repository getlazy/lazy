/**
 * Daemon HTTP server — a single TCP listener is the daemon's ONLY transport.
 *
 * The daemon binds one TCP port (loopback 127.0.0.1 by default; remote access
 * is opt-in via [server] bind in lazy.toml — see daemon-bind-localhost). The
 * CLI, agents in containers, the builder, and the browser all reach the daemon
 * on this port. There is deliberately no unix socket: it was a second code path
 * that made Docker and Windows special cases, and everything it gated by
 * filesystem permissions is gated here by the bearer token instead
 * (drop-unix-socket).
 *
 * Endpoints:
 *   GET  /daemon/status          — health check (no auth; liveness probe)
 *   POST /daemon/shutdown        — graceful shutdown (shared daemon token)
 *   POST /rpc/{command}          — CLI command pass-through (shared daemon token)
 *   POST /mcp/:taskId/:toolName  — MCP tool execution (per-identity MCP token,
 *                                  never the shared token — see mcp-routes.ts)
 *   everything else              — web dashboard (no auth, read-only rendering;
 *                                  mutations go through /rpc//mcp handlers)
 */

import { randomUUID } from 'crypto';
import { mkdirSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { getDaemonDir, getStartupErrorPath } from './paths';
import { writePid, generateToken, readToken, readWebPort, writeWebPort, writeWebHost, cleanupOwnDaemonFiles, acquireDaemonLock, releaseDaemonLock, SIGNAL_SHUTDOWN_BUDGET_MS, SHUTDOWN_STOP_GRACE_SECONDS, type AutoReactBudgetEntry } from './lifecycle';
import { startDaemonStateFileWatch } from './state-files';
import { writeDaemonRoot } from './registry';
import { startTestParentWatch, TEST_PARENT_PID_ENV } from './test-parent-watch';
import { installDaemonProcessGuards } from './process-guards';
import { readProjectInstanceId } from './project-instance';
import { assertDaemonCredentials } from './credential-gate';
import { assertStoredCredentialsReachedEnv, hydrateCredentialEnv } from '../credentials/hydrate';
import { handleRpc, handleBuilderStorageCall, handleGetBuilderLaunchEnv, handleGetAgentLaunchEnv, openProjectStorage, initDaemonStorage, getOrCreateStorage, closeAllStorage } from './rpc-handlers';
import { lookupMcpIdentity } from './mcp-tokens';
import { initTracing, shutdownTracing } from '../tracing';
import { withRequestSpan } from './request-span';
import { authorizeMcpCall, handleMcpToolCall, httpStatusForError, parseMcpToolCallBody } from './mcp-routes';
import { resolveRpcActor, rpcAuthErrorMessage, describeActor } from './rpc-auth';
import type { ActorIdentity } from './actor-tokens';
import { lookupDaemonTokenLabel } from './actor-tokens';
import { acceptRemedyOf } from '../types';

/**
 * The body of a failed reply.
 *
 * Errors that carry a structured remedy (a refused accept) send it alongside
 * the message so the client does not have to pattern-match prose to learn what
 * the human should do next. Everything else is unchanged: `{ error }`.
 */
function errorBody(err: unknown, message: string): { error: string; remedy?: unknown } {
  const remedy = acceptRemedyOf(err);
  return remedy ? { error: message, remedy } : { error: message };
}
import { clearAllWaits } from './wait-registry';
import { clearAllProgress } from './progress-registry';
import { readJsonBody, readJsonObjectBody } from './http-body';
import {
  clientAcceptsHeartbeat,
  heartbeatEnvelopeResponse,
  type EnvelopeResult,
} from './heartbeat';
import {
  eventStreamResponse,
  parseLastEventId,
  subscriberCount,
  closeAllEventStreams,
  startDaemonHealthEvents,
  MAX_EVENT_SUBSCRIBERS,
} from './event-feed';
import type { ProgressEmitter } from './progress';
import { reconcileTasks, interruptForDaemonStop } from '../utils/reconcile';
import {
  reapPreviousGenerationChildren,
  snapshotPreviousGenerationChildren,
  type PreviousGenerationSnapshot,
} from './restart-reaper';
import { createRunner } from '../runner';
import { indexRunsByName, type OwnedRuns } from '../runner/run-ownership';
import type { Storage } from '../storage/interface';
import { logger, LogLevel } from '../utils/logger';
import { markLoggedToFile } from '../utils/logged-error';
import { createWebRequestHandler, tryBindTcpPort } from '../server';
import { createShellUpgrader } from '../server/shell-ws';
import { createWatchUpgrader, createRpcWatchUpgrader } from '../server/watch-ws';
import { revokeLeftoverMemberTerminalCredentials } from '../server/member-exec-credential';
import { sweepLeftoverMemberEnvironments } from './member-leftovers';
import { createActionRunUpgrader } from '../server/action-ws';
import { createSessionAttachUpgrader } from '../server/session-attach-ws';
import { multiMemberDaemon } from './session-attach';
import { composeUpgraders } from '../server/ws';
import { createServeProxy, createServeProxyUpgrader, type ServeProxyDeps } from '../server/serve-proxy';
import { setDashboardAuthority } from '../serve/subdomain';
import { createReviewActions } from './review-service';
import { createReviewSessionActions } from './review-session-service';
import { createMessageActions } from './message-service';
import { createMemoryActions } from './memory-service';
import { createDoctorActions } from './doctor-service';
import { createServeActions } from './serve-service';
import { importStartServicesCmdFromConfig } from '../serve/start-cmd';
import { createTaskEditActions } from './task-edit-service';
import { dashboardHostFor, resolveDashboardUrl } from './dashboard-url';
import { isManagedMode } from '../config/managed';
import { guardDashboardRequest, serveDashboardRequest } from './dashboard-auth';
import { getLogPath } from './paths';
import { loadConfig, resolveConfigPath } from '../config/loader';
import type { RunnerType } from '../config/types';
import { DEFAULT_WEB_PORT, DEFAULT_SERVER_BIND, MAX_PORT_ATTEMPTS } from '../config/constants';
import { buildProxyCredentialDeps } from '../proxy/credential-deps';
import { agentUpstreamMap } from '../proxy/agent-upstreams';
import { ProxyToolStatsRecorder } from '../proxy/tool-stats';
import {
  createProxyServer,
  type ProxyServer,
  loadProxyRequestPlugins,
  PLUGIN_DIR_RELATIVE,
  ProxyAuditLog,
  auditLogPath,
  auditLogDir,
  pruneLegacyAuditLog,
  formatSize,
  AUDIT_SEGMENT_MAX_BYTES,
  AUDIT_RETAINED_SEGMENTS,
} from '../proxy';
import { teeTaskProgress } from './task-progress';
import { createSessionCredentialResolver } from './turn-credentials';
import { resolveDaemonBindHosts, resolveProxyBindHosts } from './bind-hosts';
import { pushBranchAfterStateChange, retryFailedPushes } from './push';
import { setDaemonContext, setDaemonProxyPort } from './context';
import {
  autoUnblockTask,
  createReconcileEventState,
  detectAndDeliverEvents,
  deliverStateChangeEvents,
  runBlockedTaskCatchup,
  type ReconcileEventState,
  type StateChange,
} from './auto-deliver';
import { runAutoReact } from './auto-react';
import { runAutoReviewCatchup } from './auto-review';
import { processAutoResumeQueue } from './auto-resume-queue';
import { describeUsagePauseState, processUsagePauseHolds } from './usage-pause';
import { flushUsageReadingWrites, installUsageReadingStore } from './usage-readings';
import { resumeHeldReviewFix } from './task-lifecycle';
import { closeSignalDb, initSignalDb } from './signals';
import { startSyncRetryLoop } from './sync-retry';
import { sweepConversations, createSweepCursor } from '../import/capture-sweep';
import { findTerminalTaskWorktrees } from '../doctor/findings';
import { cleanupWorktree } from '../task/cleanup';
import { checkLock } from '../utils/lock';
import { createDriver } from '../remote';
import { runSync, debugSyncLogger } from './remote-sync';
import { isOfflineMode } from '../utils/offline';
import { parentTaskIdOf } from '../task-target';
import {
  daemonHealthRecorder,
  forgetDaemonHealth,
  runRecordedSweep,
  RECONCILE_LOOP,
  REMOTE_SYNC_LOOP,
} from './health-registry';

export interface DaemonServerOptions {
  /** Project root this daemon serves. Required — the daemon is per-project. */
  projectRoot: string;
  /** Use an existing token instead of generating a new one. For tests. */
  token?: string;
  /** Override reconcile interval in seconds. For tests. */
  reconcileIntervalSeconds?: number;
  /** TCP port to bind. 0 means an OS-assigned ephemeral port (tests). */
  webPort?: number;
  /** Maximum port attempts for auto-increment. */
  maxPortAttempts?: number;
  /**
   * Test-only: run the FULL production web-bind path even when LAZY_TEST=1
   * (config-driven port/bind resolution, port persistence, MCP config refresh,
   * bridge binds). Without it, a LAZY_TEST daemon binds a minimal ephemeral
   * loopback listener instead — reachable, but with none of the production
   * side effects, so parallel suites never contend on the shared port window.
   * Not part of the daemon's public contract.
   */
  _forceBindWebInTest?: boolean;
}

export interface RunningDaemon {
  token: string;
  startedAt: number;
  /** The single project root this daemon serves. */
  projectRoot: string;
  /** Cache of task short IDs, populated by the reconcile loop.
   *  Used by stop() to filter supervisors to only this project's tasks. */
  knownTaskIds: Set<string>;
  /** The daemon's TCP listener (primary bind) — its only transport. */
  webServer: ReturnType<typeof Bun.serve>;
  /**
   * Additional TCP listeners on the same port for other interfaces (e.g. the
   * docker bridge gateway on native Linux so containers can reach the daemon).
   * Tracked separately so stop() tears them all down.
   */
  extraWebServers?: ReturnType<typeof Bun.serve>[];
  /** TCP port the daemon is listening on. */
  webPort: number;
  /** Interface the listener bound to (= config.server.bind). */
  bindHost: string;
  /** Public dashboard origin, including a configured reverse proxy. */
  dashboardUrl: string;
  /** Anthropic passthrough proxy server — always started; undefined only if startup failed. */
  proxyServer?: ReturnType<typeof Bun.serve>;
  /**
   * Stop the daemon server and clean up files. Does NOT exit the process.
   *
   * Async on purpose, and the signature says so: shutdown terminates
   * supervisors, closes storage and, crucially, removes the pidfile. A caller
   * that does not await it (an in-process daemon in a test, say) can race its
   * own teardown into reading a stale pidfile that still names the CURRENT
   * process — and then signal itself. Await it.
   */
  stop: () => Promise<void>;
}

/** The bearer credential a request presents, or null when it presents none. */
function bearerToken(req: Request): string | null {
  const header = req.headers.get('authorization');
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

/**
 * Record a hard startup failure and return the Error the caller must throw
 * (`throw await recordStartupFailure(...)` — returning rather than throwing
 * keeps the abort visible to the compiler's control-flow analysis at every call
 * site). Three steps, in this order, and the order is the load-bearing part:
 *
 *  1. Write the startup-error marker FIRST — before any teardown, so it is on
 *     disk even if a teardown step never finishes. It is the channel that
 *     reaches a human: the parent process (the CLI that spawned this detached
 *     daemon via startDaemonBackground) reads it when its readiness poll times
 *     out and prints the reason instead of a generic "Daemon did not start
 *     within 5 seconds", and `lazy daemon status` prints it once the daemon is
 *     down. The parent cleared any stale marker before spawning, so its
 *     presence means "this child wrote it". Best-effort: the file-backed log
 *     remains the source of truth if the marker write fails.
 *  2. Run `teardown`, when the caller has something to tear down — a failure
 *     late in startup must never leave half a daemon running. The earliest
 *     preconditions (config, credentials) pass none: nothing exists yet.
 *     Teardown logs as it goes: storage close at debug level, a warn if the
 *     store refuses to close, per-step failures at debug level.
 *  3. logger.error LAST, exactly once. The logger appends (O_APPEND), so the
 *     message lands at the very END of daemon.log — which is the point: an
 *     operator debugging a daemon that would not start runs `tail daemon.log`,
 *     and the last thing there has to be why it died. Logging before teardown
 *     (what this used to do) left the reason eleven lines up, buried under
 *     teardown's own storage-close chatter, so a default ten-line tail showed
 *     remediation bullets and debug noise but never the failure. Exactly one
 *     copy: `test/e2e/daemon.test.ts` pins that too, because this message once
 *     landed in the log three times over.
 *
 * The returned Error is marked already-logged so the top-level CLI catch in
 * src/index.ts doesn't append a second untimestamped copy (in background mode
 * its console.* writes land back in daemon.log via O_APPEND).
 *
 * The daemon directory is created here rather than assumed: the earliest
 * preconditions (config, credentials) deliberately run before ANY side effect,
 * which includes the mkdir the socket path would otherwise have done — and a
 * refusal whose marker silently failed to write is a refusal the user never
 * sees.
 */
async function recordStartupFailure(
  projectRoot: string,
  errorMessage: string,
  teardown?: () => Promise<void>,
): Promise<Error> {
  try {
    await mkdir(getDaemonDir(projectRoot), { recursive: true });
    await writeFile(getStartupErrorPath(projectRoot), errorMessage, { mode: 0o644 });
  } catch (markerErr) {
    logger.warn(`Failed to write startup-error marker: ${markerErr instanceof Error ? markerErr.message : String(markerErr)}`);
  }
  if (teardown) await teardown();
  logger.error(errorMessage);
  return markLoggedToFile(new Error(errorMessage));
}

/**
 * Load the project's config, or abort startup.
 *
 * INVARIANT: a lazy.toml that exists but does not load is a hard startup
 * failure, never a fall-through to defaults. Every value in it is a decision
 * the user made — where storage lives, which port the dashboard serves, which
 * interface it is reachable from, which runner every task container uses.
 * Guessing them serves a daemon the user did not ask for and then hands those
 * guesses to every task it launches; the resulting symptom ("why is my runner
 * docker?") is arbitrarily far from the cause. A MISSING lazy.toml is not this
 * case — loadConfig returns defaults for it without throwing.
 *
 * THIS RUNS FIRST, before every other startup step, and that ordering is the
 * whole point. Config is read by the credential gate (via the `[ollama]` flag)
 * and by daemon storage init, both of which run before the daemon has bound
 * anything — so whichever of them touched it first used to surface the loader's
 * RAW error and this gate never got the chance to wrap it. The user saw a bare
 * parse error with no indication that it had stopped their daemon. Adding a
 * startup step that reads config BEFORE this call re-opens exactly that hole.
 *
 * The file read is always the PROJECT ROOT's: loadConfig takes no starting
 * directory at all (see "A task worktree's lazy.toml has no authority" in
 * src/config/loader.ts), so a detached daemon cannot be handed a different
 * config by whatever directory the CLI that spawned it happened to be in.
 */
async function loadDaemonConfigOrFail(projectRoot: string) {
  try {
    return await loadConfig(projectRoot);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const configPath = resolveConfigPath(projectRoot);
    throw await recordStartupFailure(
      projectRoot,
      `Daemon failed to load ${configPath}: ${detail}\n` +
      `\n` +
      `The daemon reads lazy.toml to decide where its storage lives, which port the ` +
      `dashboard serves on, which interface it binds, and the runner every task ` +
      `container uses. It will not start on guessed values: it would serve on a port ` +
      `you did not configure with a runner you may not have, and hand both to every ` +
      `task it launches.\n` +
      `\n` +
      `To fix:\n` +
      `  • Correct the error above in ${configPath}\n` +
      `  • Compare against the documented example: lazy.toml.example\n` +
      `  • Once lazy.toml loads, check the rest of the setup: lazy doctor`,
    );
  }
}

/**
 * Start the daemon HTTP server on its TCP port — the daemon's only transport.
 *
 * Creates PID file, generates bearer token, binds the TCP listener (which
 * serves daemon routes AND the web dashboard). Returns the running server
 * handle for lifecycle management.
 */
export async function startDaemonServer(options: DaemonServerOptions): Promise<RunningDaemon> {
  // Mark this process as the daemon to prevent recursive RPC calls
  process.env.LAZY_IS_DAEMON = '1';

  // No git the daemon runs may ever open a terminal prompt.
  //
  // The daemon is a BACKGROUND process, and it is detached but not setsid — it
  // keeps the controlling terminal of whoever started it. Its sync loop runs
  // `git fetch` every 60 seconds, and git asks for credentials by opening
  // /dev/tty directly, not by reading stdin (which is 'ignore' here). So a
  // project whose remote needs credentials the machine does not have turns into
  // a `Username for 'https://...':` prompt on somebody's terminal, once a
  // minute, forever — with no indication of which process is asking.
  //
  // Set on the process rather than per-call so it also covers the git run by
  // anything the daemon spawns. Env still wins if an operator deliberately
  // exported GIT_TERMINAL_PROMPT=1 to debug an auth problem.
  process.env.GIT_TERMINAL_PROMPT ??= '0';

  const projectRoot = options.projectRoot;

  // Configure logger: write to daemon.log via appendFileSync (supports rotation).
  //
  // In BACKGROUND mode (LAZY_DAEMON_BACKGROUND=1, set by auto-start.ts when
  // spawning the detached child), stdout and stderr are redirected to
  // daemon.log via O_APPEND. Anything written to console.* therefore also
  // lands in daemon.log — without a timestamp — and causes duplicate entries
  // whenever logger.* also echoes to console. Set consoleLevel to SILENT so
  // the logger writes *only* to the file, giving a single timestamped entry
  // per log call.
  //
  // In FOREGROUND mode (user ran `lazy daemon start --foreground` directly),
  // stdout/stderr are the user's terminal. Keep consoleLevel at ERROR so the
  // user sees errors on their terminal; the logger also writes them to the
  // file with a timestamp for post-mortem debugging. The two destinations
  // are different sinks so no duplication occurs.
  if (!process.env.LAZY_TEST) {
    logger.setLogFile(getLogPath(projectRoot));
    const background = process.env.LAZY_DAEMON_BACKGROUND === '1';
    logger.configure({ consoleLevel: background ? LogLevel.SILENT : LogLevel.ERROR });
    logger.enableRotation(10 * 1024 * 1024, 3); // 10MB, keep 3 rotated files
  }

  logger.info(`Daemon starting for project: ${projectRoot} (PID ${process.pid})`);

  // The config precondition — see loadDaemonConfigOrFail. FIRST, before the
  // credential gate and before any side effect, because both of the steps that
  // follow read config themselves and would otherwise surface the loader's raw
  // error in place of this one. Nothing has been created yet, so a refusal here
  // leaves nothing to clean up.
  const startupConfig = await loadDaemonConfigOrFail(projectRoot);

  // Say which lazy this is, in the log, at the top, every time.
  //
  // A long-lived daemon serves whatever code it was started with, and the
  // failure that produced this line was invisible precisely because nothing
  // anywhere stated the answer: a daemon built from one ref silently did not
  // render a feature that existed only on another, and it read as a lost
  // feature rather than a version mismatch. Fire-and-forget so a slow
  // filesystem cannot delay the listen; the fingerprint is ~90ms of reading.
  void (async () => {
    try {
      const { getSourceIdentity } = await import('../utils/source-id');
      const identity = await getSourceIdentity();
      // Dynamic, like the status route's: the generated version file may not
      // exist in a test tree, and a missing version must not cost the log line.
      const version = await import('../version').then(m => m.VERSION).catch(() => 'unknown');
      logger.info(
        `Running lazy ${version} — source ${identity.id} (${identity.kind})` +
        `${identity.checkoutPath ? ` from ${identity.checkoutPath}` : ''}`,
      );
    } catch (err) {
      logger.warn(`Could not determine which lazy source this daemon is running: ${err instanceof Error ? err.message : err}`);
    }
  })();

  // Load any stored credential into this process's environment BEFORE the gate.
  // Everything downstream (getAuthEnvVars, the proxy, container env inheritance)
  // reads env vars, so this is the one place the store has to be consulted —
  // and doing it before the gate is what lets a daemon start from a shell that
  // has no token exported (the `lazy upgrade` abort this task exists to fix).
  // Env always wins; see hydrateCredentialEnv.
  //
  // Skipped under LAZY_TEST=1 for the same reason the gate below is: suites
  // must not depend on what the developer's machine happens to have stored.
  let hydrationError: unknown;
  if (process.env.LAZY_TEST !== '1') {
    try {
      await hydrateCredentialEnv(projectRoot);
    } catch (err) {
      // Held, not swallowed. The gate below CANNOT catch this on its own: it
      // answers from the same non-secret index whose disagreement with the
      // backend is what made hydration throw, so it would pass and bring up a
      // daemon with an empty environment. assertStoredCredentialsReachedEnv,
      // run with the gate, is what turns that into a refusal — and this error
      // is the only thing that says why, so it is carried there.
      hydrationError = err;
      logger.error(
        `Failed to load stored credentials: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // INVARIANT: a daemon never exists without a model credential.
  //
  // This is the AUTHORITATIVE enforcement point — the callers (auto-start,
  // `lazy daemon start`, `daemon restart`, `lazy upgrade`) pre-flight the same
  // gate so the refusal lands in the user's terminal, but this is the single
  // function that actually brings a daemon up, so enforcing here is what makes
  // the invariant structural instead of a convention each new caller has to
  // remember. A credential-less daemon is worse than no daemon: it runs,
  // answers RPC, and launches containers that can't reach the model API, so
  // tasks spin uselessly instead of failing fast.
  //
  // Runs BEFORE any side effect (storage, signal DB, loops, lock, PID file) so
  // a refusal leaves nothing behind to clean up.
  //
  // Skipped under LAZY_TEST=1, matching the daemon's other test carve-outs
  // (flock, chdir, logger). Suites that drive a daemon in-process would
  // otherwise depend on whether the developer happens to have a credential
  // exported — green on a laptop, red in CI. test/preload-generate.ts also
  // pins a hermetic fake credential for the test process, so this carve-out is
  // belt-and-braces rather than the only thing keeping those suites green.
  // The production path is covered end-to-end by
  // test/e2e/daemon-credential-gate.test.ts, which runs the real CLI as a
  // subprocess with LAZY_TEST=''.
  if (process.env.LAZY_TEST !== '1') {
    try {
      // Order matters. The store's promise is checked FIRST, because a store
      // that said "stored" and delivered nothing is a strictly more specific
      // (and more actionable) failure than "no credential anywhere" — and it is
      // a failure the gate itself is structurally unable to see.
      await assertStoredCredentialsReachedEnv(projectRoot, hydrationError);
      await assertDaemonCredentials(projectRoot);
    } catch (err) {
      // The marker recordStartupFailure writes is what carries a detached
      // child's refusal to the caller's terminal (startDaemonBackground reads
      // it after its readiness poll) and lets `lazy daemon status` explain why
      // there is no daemon. The parent pre-flight normally catches this first;
      // the marker covers the case where the child's environment differs from
      // the spawning process's.
      throw await recordStartupFailure(projectRoot, err instanceof Error ? err.message : String(err));
    }
  }

  // Initialize storage module with the project root so getOrCreateStorage()
  // doesn't need a parameter — the daemon is single-project.
  initDaemonStorage(projectRoot);

  // [usage_pause] readings are written through to Storage and seeded from it,
  // so a pause survives a restart after the audit log rotated its reading away.
  installUsageReadingStore(getOrCreateStorage);

  // Initialize request tracing (always on). Finished spans are persisted
  // through the daemon's own Storage as JSONL — no collector.
  initTracing('daemon', async (spans) => {
    const storage = await getOrCreateStorage();
    await storage.appendTraceSpans(spans);
  });

  // Initialize signal DB with the project root so signals are stored
  // per-project in .lazy/signals.db instead of globally.
  initSignalDb(projectRoot);

  // File a system message if the daemon version changed since the last start
  // (the built-in system-messages producer). Fire-and-forget: never blocks or
  // fails the launch — the helper logs its own errors.
  void (async () => {
    const { maybePostUpgradeNotice } = await import('./upgrade-notice');
    await maybePostUpgradeNotice(projectRoot, () => getOrCreateStorage());
  })().catch(err => {
    logger.error(`Upgrade-notice check failed: ${err instanceof Error ? err.message : String(err)}`);
  });

  // Set daemon cwd to the project root so all relative paths resolve correctly.
  // This eliminates the need for call sites to pass { cwd: projectRoot } everywhere.
  // Skip in tests — multiple daemons share the same process, and test cleanup
  // removes the temp directory, leaving cwd pointing at a deleted path.
  if (!process.env.LAZY_TEST) {
    process.chdir(projectRoot);
  }

  // Announce a valid worktree adoption (or expire a stale one) so the human
  // sees what the daemon will launch with — principle of least surprise.
  {
    const { loadValidAdoptedImage } = await import('./adopted-image');
    const adopted = await loadValidAdoptedImage(projectRoot);
    if (adopted) {
      logger.info(
        `Adopted worktree image: ${adopted.imageName} ` +
        `(from ${adopted.dockerfilePath}, hash ${adopted.contentHash.slice(0, 12)}…, ` +
        `lazy ${adopted.lazyVersion}). Applies to all launches without a per-task pin ` +
        `until the next \`lazy upgrade\` rebuild.`
      );
    }
  }

  const startedAt = Date.now();
  // A fresh record for `lazy daemon health`: an in-process restart must not
  // inherit the previous daemon's ticks as its own.
  forgetDaemonHealth(projectRoot);
  daemonHealthRecorder(projectRoot).daemonStarted(startedAt);
  // Identity of THIS daemon process, minted once per start and never reused.
  // Children hold addresses this process issued (above all the OS-assigned
  // proxy port), so "is the daemon answering me the same one that launched me"
  // is the question they must be able to ask — see src/daemon/generation.ts.
  const instanceId = randomUUID();
  // Identity of the PROJECT this daemon was started for, seeded by whoever
  // started it (a fleet supervisor) rather than minted here. Read once, at
  // startup, so a malformed value fails the start instead of every later probe
  // — see src/daemon/project-instance.ts for why per-process identity and
  // projectRoot both fail to answer "is this daemon mine".
  const projectInstanceId = readProjectInstanceId();
  let stopped = false;
  let shutdownTimer: ReturnType<typeof setTimeout> | null = null;

  // Cache of known task short IDs — populated by the reconcile loop,
  // used by stop() to filter supervisors to only this project's tasks.
  const knownTaskIds = new Set<string>();

  // Cache of tasks at their auto-react limit — populated by the reconcile loop,
  // read by the /daemon/status endpoint so it never blocks on storage.
  let cachedTasksAtLimit: string[] = [];

  // The children that existed before this daemon could be reached. Filled in
  // just before the listeners bind (search for snapshotPreviousGenerationChildren
  // below); the reconcile loop reads it through a getter because the loop is
  // created first and the snapshot has to be taken as late as possible.
  let previousGenerationSnapshot: PreviousGenerationSnapshot | null = null;

  // Member terminals (Teams Shell/Pair/Chat) run in containers of their own,
  // each holding a credential minted for it; both are removed by the daemon
  // when the member's session ends, which a restart cuts short. No terminal
  // survives a restart, so every one left is removed here — the containers
  // (and whatever the member left running in them) first, then their
  // credentials — before the reconcile loop can launch a turn
  // (src/daemon/member-container.ts, src/server/member-exec-credential.ts).
  // A runtime that is not up yet does not lose anything: the sweep holds every
  // task a leftover home names and retries until it succeeds
  // (./member-leftovers.ts).
  try {
    const runnerType = (await loadConfig(projectRoot)).runner.type;
    if (runnerType === 'docker' || runnerType === 'podman') {
      await sweepLeftoverMemberEnvironments(projectRoot, runnerType, await getOrCreateStorage());
    }
  } catch (err) {
    logger.error(
      `Could not remove member terminal environments left by the previous daemon: ${err instanceof Error ? err.message : String(err)}. ` +
      `Their credentials are still revoked below; run \`lazy doctor\` and restart the daemon.`,
    );
  }
  try {
    const leftover = await revokeLeftoverMemberTerminalCredentials(projectRoot);
    if (leftover.bindings + leftover.grants > 0) {
      logger.info(`Revoked ${leftover.bindings} member-terminal binding(s) and ${leftover.grants} grant(s) left by the previous daemon.`);
    }
  } catch (err) {
    logger.error(
      `Could not revoke member-terminal credentials left by the previous daemon: ${err instanceof Error ? err.message : String(err)}. ` +
      `A placeholder a member could read may still resolve; run \`lazy doctor\` and restart the daemon.`,
    );
  }

  // Start reconcile loop
  const reconcileInterval = options.reconcileIntervalSeconds ?? 5;
  const stopReconcileLoop = startDaemonReconcileLoop(projectRoot, reconcileInterval, knownTaskIds, (skipped) => {
    const pausedSet = new Set(cachedTasksAtLimit);
    for (const id of skipped) pausedSet.add(id);
    cachedTasksAtLimit = [...pausedSet];
  }, () => previousGenerationSnapshot);

  // Start sync retry loop (runs alongside reconcile on same interval)
  const stopSyncRetryLoop = startSyncRetryLoop(projectRoot, reconcileInterval);

  // Start remote sync loop (independent from reconcile to avoid blocking task detection)
  const stopSyncLoop = startDaemonSyncLoop(projectRoot);

  // Start the live conversation capture sweep (host-side Claude sessions —
  // fidelity summaries, `lazy report`, memory compaction, a human's own
  // `claude` in the repo — plus a backstop for the in-container builder).
  const stopCaptureLoop = startConversationCaptureLoop(projectRoot);

  // Reclaim worktrees left behind on tasks that finished (accepted/closed/
  // rejected) but whose cleanup step never ran — see startTerminalWorktreeCleanupLoop.
  const stopWorktreeCleanupLoop = startTerminalWorktreeCleanupLoop(projectRoot);

  // Periodic `daemon.health` tick for SSE subscribers. The timer no-ops while
  // nobody is subscribed, so it costs nothing on a daemon with no listener.
  let stopHealthEvents: (() => void) | null = startDaemonHealthEvents();

  // Ensure daemon directory exists
  mkdirSync(getDaemonDir(projectRoot), { recursive: true });

  // Singleton enforcement via flock(2).
  // The daemon ALWAYS acquires its own lock, regardless of how it was started
  // (foreground or background). Bun.spawn does not inherit arbitrary file
  // descriptors — only stdin/stdout/stderr — so fd-passing from parent to
  // child is not possible. The parent releases its lock before spawning so
  // the child can acquire it here.
  let daemonLockFd: number | null = null;
  // TODO(spike-rearchitecture): Remove LAZY_TEST skip once tests use isolated
  // daemon instances with their own lock files instead of sharing a process.
  if (!process.env.LAZY_TEST) {
    daemonLockFd = acquireDaemonLock(projectRoot);
    if (daemonLockFd === null) {
      logger.error('Failed to acquire daemon lock — another daemon is running');
      throw new Error(
        'Another daemon is already running (lock held). ' +
        "Stop it first with 'lazy daemon stop'."
      );
    }
  }

  // Write PID file
  writePid(projectRoot, process.pid);

  // Record the absolute project root this daemon serves. The slug is lossy, so
  // this marker is what lets `lazy daemon list/kill-stray` recover the real
  // path and detect a "stray" daemon whose root was deleted. Best-effort —
  // writeDaemonRoot swallows + logs failures so it can't block startup.
  await writeDaemonRoot(projectRoot);

  // Reuse existing token so daemon restarts don't invalidate tokens held by
  // running containers/builders. Only generate a new token on first start.
  const existingToken = readToken(projectRoot);
  const token = options.token ?? existingToken ?? generateToken(projectRoot);
  const sessionAttachUpgrader = () => createSessionAttachUpgrader({
    getStorage: () => getOrCreateStorage(),
    root: projectRoot,
    authenticate: (req) => resolveRpcActor(projectRoot, token, req.headers.get('authorization')),
    multiMember: () => multiMemberDaemon(projectRoot),
  });
  // Watch on the same /rpc gate, for the Teams relay (managed mode 404s the
  // dashboard's own watch route).
  const rpcWatchUpgrader = () => createRpcWatchUpgrader({
    getStorage: () => getOrCreateStorage(),
    root: projectRoot,
    authenticate: (req) => resolveRpcActor(projectRoot, token, req.headers.get('authorization')),
  });

  // Mutable web port — set after TCP binding, read by status endpoint
  let boundWebPort: number | undefined;
  // Actual interface the web server bound to (= config.server.bind). Set after
  // TCP binding, surfaced via /daemon/status so the CLI prints a URL that
  // points at the real interface instead of a hardcoded `localhost`.
  let boundBindHost: string | undefined;

  // Shared daemon-specific request handler (status, shutdown, RPC)
  //
  // ROUTE TABLE — every route is classified against DAEMON_IDLE_TIMEOUT_S.
  //
  // A Bun.serve handler that has not yet returned a Response writes no bytes, so
  // the connection's idle timer expires mid-operation and the request is reaped
  // (see src/daemon/heartbeat.ts). Every route must therefore be either FRAMED
  // (heartbeat envelope, so writes keep resetting the timer) or BOUNDED (an
  // argument, stated here, for why it cannot approach the timeout). "Unknown" is
  // not an allowed answer — when you add a route below, add its line here.
  //
  //   GET  /daemon/status          BOUNDED  — see the comment on the route.
  //   POST /daemon/shutdown        BOUNDED  — schedules a 50ms timer, returns at once.
  //   POST /mcp/:taskId/:toolName  FRAMED   — tool calls run for minutes (accept, sync).
  //   POST /rpc/{command}          FRAMED   — `wait` long-polls up to 600s.
  //   POST /builder/storage        FRAMED   — saveConversation of a long builder
  //                                           session is a large write.
  //   GET  /builder/launch-env     BOUNDED  — same work as the agent one below,
  //                                           for the builder's own profile.
  //   GET  /agent/launch-env       BOUNDED  — exhaustively: one token lookup, one
  //                                           task read, loadConfig, a credential-
  //                                           store read, and a locked append to
  //                                           the grant registry. All local file
  //                                           I/O on small files, no network and
  //                                           no agent process; the registry lock
  //                                           is held for a single append. Orders
  //                                           of magnitude under the timeout, and
  //                                           its CLIENT gives up first anyway
  //                                           (see fetchAgentLaunchEnv).
  //   GET  /rpc/events             STREAMED — see below.
  //   (no match) -> null -> 404    BOUNDED  — a constant JSON body, no I/O.
  //
  // STREAMED is a third category, and only this route is in it. It is an SSE
  // feed that stays open indefinitely by design, so neither FRAMED (the
  // envelope is NDJSON for a single RPC result) nor BOUNDED (there is no
  // deadline) applies. It satisfies the same underlying requirement by the same
  // means as FRAMED: it writes bytes — an SSE comment heartbeat every
  // SSE_HEARTBEAT_INTERVAL_MS (15s, an 8x margin on the 120s idleTimeout) — so
  // the connection's idle timer never expires. Do not add a second STREAMED
  // route without the same guarantee.
  //
  // Dashboard routes are not here: they are served by createWebRequestHandler in
  // src/server/index.ts, which cannot use the envelope (the client is a browser)
  // and bounds every one of its routes with an explicit deadline instead.
  //
  // Every route above — plus the auth rejections and 404s that never reach one,
  // plus the dashboard — is wrapped in a request-lifetime span by
  // withRequestSpan at each listener's entry point, so a request reaped
  // mid-flight shows up in `lazy stats timings` as an error rather than as silence.
  const handleDaemonRequest = async (
    req: Request,
    requireAuth: boolean,
    // The actor the caller's token proves it to be, resolved by the listener
    // before this handler runs (see resolveRpcActor). Only /rpc/* has one; the
    // unauthenticated and MCP routes pass none, and RPC handlers fall back to
    // `{kind:'control'}` for in-process callers that are the daemon itself.
    rpcActor?: ActorIdentity,
  ): Promise<Response | null> => {
    const url = new URL(req.url);

    // GET /daemon/status — health check (no auth required on TCP)
    //
    // CRITICAL: This endpoint must respond IMMEDIATELY (<100ms). It is the
    // liveness probe used by ensureDaemon/checkDaemonHealth. If it blocks on
    // storage, file locks, or the reconcile loop, the health check times out,
    // the caller thinks the daemon is dead, and spawns another one — causing
    // daemon accumulation (we've seen 28 daemon processes from this bug).
    //
    // NO storage access. NO file lock contention. Only synchronous/cached data.
    // Budget info comes from a plain JSON file read (no lock needed).
    //
    // BOUNDED (not heartbeat-framed), and the two halves of that are separate
    // claims:
    //
    // (a) It cannot approach DAEMON_IDLE_TIMEOUT_S. Exhaustively, the work below
    //     is: two dynamic imports of generated constants (../version,
    //     ../build-info); loadConfig (one small file read + parse); readDailyBudget
    //     and isGlobalAutoReactPaused (small unlocked JSON file reads);
    //     getRunningCodeSha (one `git rev-parse`, memoised after the first call);
    //     and reads of in-process variables. No Storage call, no lock acquisition,
    //     no network, and nothing proportional to project size — the only
    //     unbounded-in-principle step, the reconcile loop, deliberately publishes
    //     through a cache rather than being consulted here. Under storage pressure
    //     this route is unaffected, because it never touches storage.
    //
    // (b) It MUST NOT be framed even if (a) ever stopped holding. This is the
    //     liveness probe, and its callers include things that are not lazy: curl,
    //     browsers, and any health check a user wires up. NDJSON framing would
    //     break them, and it would defeat the purpose anyway — a probe that
    //     answers "still working on it" for two minutes is a probe that has
    //     already failed. If this route ever grows expensive work, the fix is to
    //     move that work behind a cache, not to frame it.
    if (url.pathname === '/daemon/status' && req.method === 'GET') {
      const uptime = Date.now() - startedAt;
      let version = 'unknown';
      try {
        const mod = await import('../version');
        version = mod.VERSION;
      } catch { /* version file may not exist in tests */ }

      // Build metadata embedded at compile time (UTC ISO string + git SHA +
      // dirty flag), or dev defaults when running from source (bun run
      // ./src/index.ts). Falls back gracefully so status never crashes.
      let buildTime = 'dev';
      let buildSha = 'dev';
      let buildDirty = false;
      let buildBranch = 'dev';
      let buildSourcePath = 'dev';
      try {
        const mod = await import('../build-info');
        buildTime = mod.BUILD_TIME;
        buildSha = mod.BUILD_SHA ?? 'dev';
        buildDirty = mod.BUILD_DIRTY ?? false;
        buildBranch = mod.BUILD_BRANCH ?? 'dev';
        buildSourcePath = mod.BUILD_SOURCE_PATH ?? 'dev';
      } catch { /* build-info file may not exist in some contexts */ }

      // Auto-react budget: file-based read only (no storage, no lock).
      // tasksAtLimit is populated from a cache updated by the reconcile loop.
      let autoReactBudget: AutoReactBudgetEntry[] | undefined;
      try {
        const { readDailyBudget, effectiveDailyLimit, isGlobalAutoReactPaused } = await import('./auto-react-budget');
        const { nextLocalMidnight } = await import('../utils/local-day');
        const config = await loadConfig(projectRoot);
        const dataDir = join(projectRoot, '.lazy');
        const budget = await readDailyBudget(dataDir);
        const limit = effectiveDailyLimit(budget, config.daemon.auto_react_daily_budget);
        const pause = await isGlobalAutoReactPaused(dataDir);
        autoReactBudget = [{
          project: projectRoot,
          used: budget.used,
          limit,
          tasksAtLimit: cachedTasksAtLimit,
          resetAt: nextLocalMidnight().getTime(),
          paused: pause.paused,
          pauseExpiresAt: pause.expiresAt,
          capOverridden: budget.capOverride !== undefined,
        }];
      } catch {
        // Auto-react budget info is optional
      }

      // Git SHA of the source the daemon is RUNNING (captured at startup, cached).
      // Lets `lazy daemon status` detect a stale daemon serving code older than
      // the working tree. null for compiled/installed binaries (no source tree).
      let codeSha: string | null = null;
      try {
        const { getRunningCodeSha } = await import('./code-version');
        codeSha = getRunningCodeSha();
      } catch { /* code-version module optional; never block status */ }

      // Content identity of the source tree the daemon is RUNNING. Strictly more
      // than codeSha: it moves with uncommitted edits, and it exists for a
      // release build with no `.git`. This is what Lazy Teams compares against
      // the tree it would launch the next daemon from, so a fleet can never
      // quietly serve old code — see src/utils/source-id.ts.
      let sourceId: string | null = null;
      let sourceIdKind: string | null = null;
      try {
        const { getSourceIdentity } = await import('../utils/source-id');
        const identity = await getSourceIdentity();
        sourceId = identity.id;
        sourceIdKind = identity.kind;
      } catch { /* identity is diagnostic; never block the health probe */ }

      // Proxy status — so `lazy daemon status` can show where audited traffic
      // flows (the primary way to find the address now that the port is
      // OS-assigned by default). File read only; no storage/lock.
      let proxy: {
        running: boolean;
        bind: string;
        /** Every address the proxy actually listens on: `bind`, then the container bridge gateway when bound. */
        binds: string[];
        port: number | null;
        address: string | null;
        upstream: string;
        fallbacks: number;
        policyEnforce: boolean;
      } | undefined;
      try {
        const config = await loadConfig(projectRoot);
        // The proxy is always configured — `running` is the only question, and
        // `false` means a degraded daemon, not an operator's choice.
        const port = proxyServer?.port ?? null;
        proxy = {
          running: proxyServer !== undefined,
          bind: config.proxy.bind,
          binds: proxyServer?.binds ?? [config.proxy.bind],
          port,
          address: port !== null ? `http://${config.proxy.bind}:${port}` : null,
          upstream: config.proxy.upstream,
          fallbacks: config.proxy.fallbacks.length,
          policyEnforce: config.proxy.policy.enforce,
        };
      } catch { /* proxy status is optional; never block the health probe */ }

      return Response.json({
        status: 'running',
        pid: process.pid,
        uptime,
        version,
        // Per-process identity. A client comparing this across two readings
        // learns "same daemon" vs "it restarted" without having to infer it
        // from pid (recycled) or uptime (only ever a heuristic).
        instanceId,
        // The project this daemon serves. Daemons for different projects share
        // one TCP port window, so a client that gets a 401 needs this to tell
        // "my token rotated" from "a foreign daemon took my port" — the latter
        // being the real cause of permanently-dead MCP tools in a live builder.
        // No new exposure: the unauthenticated dashboard on this same port
        // already renders this project's data.
        projectRoot,
        // The identity the fleet supervisor seeded for this project, echoed
        // verbatim. Omitted when nothing seeded one (every unsupervised daemon),
        // so its presence is itself the signal that an identity check is
        // possible. Costs an already-read variable — the health probe's budget
        // is untouched.
        ...(projectInstanceId ? { projectInstanceId } : {}),
        buildTime,
        buildSha,
        buildDirty,
        buildBranch,
        buildSourcePath,
        ...(codeSha ? { codeSha } : {}),
        ...(sourceId ? { sourceId, sourceIdKind } : {}),
        webPort: boundWebPort,
        bindHost: boundBindHost,
        // string when the dashboard is on; null when managed mode has it off.
        // Callers must not invent a URL from bindHost+webPort when this is null.
        dashboardUrl: isManagedMode()
          ? null
          : (boundWebPort
            ? resolveDashboardUrl(boundBindHost, boundWebPort, startupConfig.server.dashboard_url)
            : null),
        ...(autoReactBudget ? { autoReactBudget } : {}),
        ...(proxy ? { proxy } : {}),
      });
    }

    // All remaining daemon routes require auth
    if (requireAuth) {
      const authHeader = req.headers.get('authorization');
      if (authHeader !== `Bearer ${token}`) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }

    // POST /daemon/shutdown — graceful shutdown
    //
    // BOUNDED: it schedules the actual teardown on a 50ms timer and returns
    // immediately, precisely so the reply reaches the client before the process
    // exits. The slow part (stop()) runs after the response, off the request.
    if (url.pathname === '/daemon/shutdown' && req.method === 'POST') {
      logger.info('Shutdown requested via RPC');
      shutdownTimer = setTimeout(async () => {
        await stop();
        process.exit(0);
      }, 50);
      return Response.json({ ok: true, message: 'Shutting down' });
    }

    // POST /mcp/:taskId/:toolName — MCP tool execution
    const mcpMatch = url.pathname.match(/^\/mcp\/([^/]+)\/(.+)$/);
    if (mcpMatch && req.method === 'POST') {
      const taskIdParam = decodeURIComponent(mcpMatch[1]);
      const toolName = decodeURIComponent(mcpMatch[2]);
      const reqProject = req.headers.get('x-lazy-project');
      if (!reqProject) {
        return Response.json({ error: 'Missing X-Lazy-Project header' }, { status: 400 });
      }
      if (reqProject !== projectRoot) {
        return Response.json({ error: `Project mismatch: daemon serves ${projectRoot}, request is for ${reqProject}` }, { status: 400 });
      }

      // INVARIANT: identity comes from the TOKEN, never from the URL. The
      // :taskId segment is a claim; authorizeMcpCall refuses (403) when it
      // disagrees with the identity the presented token is bound to, and 401s
      // an unknown/revoked token. The shared daemon token is deliberately NOT
      // accepted here — this is a security boundary, so there is no fallback
      // path that would let every agent share one identity again.
      //
      // It also performs the malformed-segment check (400 with what the path
      // should look like), so task resolution never sees garbage.
      let authorizedTaskId: string;
      try {
        authorizedTaskId = await authorizeMcpCall(
          projectRoot,
          taskIdParam,
          bearerToken(req),
        );
      } catch (err) {
        const status = httpStatusForError(err);
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`MCP ${toolName} refused (${status}) for claimed task ${taskIdParam.substring(0, 8)}: ${message}`);
        return Response.json({ error: message }, { status });
      }

      const mcpStart = Date.now();
      // One source of truth for the outcome, used by both the plain and the
      // heartbeat-framed reply below. A tool call can run for minutes (accept,
      // sync, a wrap-up turn launch), which is exactly the case Bun.serve's
      // idle timer kills — see src/daemon/heartbeat.ts.
      const produce = async (emit?: ProgressEmitter): Promise<EnvelopeResult> => {
        try {
          // INVARIANT: arguments are parsed and schema-checked BEFORE dispatch.
          // A body without the {"arguments": {...}} envelope, or one that
          // violates the tool's declared inputSchema, is a 400 naming the field
          // — never a call with silently-empty arguments. See
          // src/mcp/validate-args.ts for the "undefined" commit this prevents.
          const body = await readJsonBody(req, `MCP ${toolName} request body`);
          const args = parseMcpToolCallBody(toolName, body);
          // The token's own task id ('' for the builder surface) — never the
          // caller's claim, which has already been proven to agree with it.
          // The builder surface also carries its token's label, which names a
          // daemon-owned builder session (and so the member it bills).
          const token = bearerToken(req);
          const builderTokenLabel = !authorizedTaskId && token
            ? await lookupDaemonTokenLabel(projectRoot, token)
            : null;
          const result = await handleMcpToolCall(projectRoot, authorizedTaskId, toolName, args, emit, builderTokenLabel);
          const durationMs = Date.now() - mcpStart;
          logger.info(`MCP ${toolName} for task ${taskIdParam.substring(0, 8)} completed in ${durationMs}ms`);
          return { status: 200, body: { result } };
        } catch (err) {
          const durationMs = Date.now() - mcpStart;
          const message = err instanceof Error ? err.message : String(err);
          // Preserve the error's own status (RpcError from a handler, or an
          // RpcApplicationError relayed from another daemon call). Both the
          // plain and the heartbeat-framed reply below read it from here, so
          // the enveloped {"status":N} line carries the real status too.
          const status = httpStatusForError(err);
          // A 4xx is the caller's mistake, not a daemon fault — log it at info,
          // matching how the /rpc route below treats an RpcError.
          const line = `MCP ${toolName} for task ${taskIdParam.substring(0, 8)} failed (${status}) in ${durationMs}ms: ${message}`;
          if (status >= 500) logger.error(line); else logger.info(line);
          return { status, body: errorBody(err, message) };
        }
      };

      if (clientAcceptsHeartbeat(req)) return heartbeatEnvelopeResponse(produce, { signal: req.signal });
      const outcome = await produce();
      return Response.json(outcome.body, { status: outcome.status });
    }

    // POST /builder/storage — capture-scoped storage for a builder container
    //
    // WHY THIS ROUTE EXISTS AT ALL. The builder supervisor runs INSIDE the
    // builder container and persists two things through the daemon: the
    // conversations it captures on a timer, and the resume-intent stamp on
    // exit. It holds one credential — the per-identity MCP token bind-mounted
    // as its daemon MCP config — and for a long time it presented that token to
    // /rpc/storage, which requires the SHARED daemon token. Every capture tick
    // 401'd for the whole session; nothing but a log file said so.
    //
    // The two ways to "fix" that by moving the credential are both wrong. Ship
    // the shared daemon token into the container and the container (and the
    // agent in it) gains every /rpc/<command> CLI pass-through plus unrestricted
    // storage. Accept MCP tokens on /rpc/* and the anti-impersonation boundary
    // documented on the /mcp/ route collapses. So capture gets its own surface:
    // per-identity MCP auth like /mcp/*, restricted to a builder-kind token, and
    // authorized against a six-method allowlist (BUILDER_STORAGE_METHODS).
    if (url.pathname === '/builder/storage' && req.method === 'POST') {
      const reqProject = req.headers.get('x-lazy-project');
      if (!reqProject) {
        return Response.json({ error: 'Missing X-Lazy-Project header' }, { status: 400 });
      }
      if (reqProject !== projectRoot) {
        return Response.json({ error: `Project mismatch: daemon serves ${projectRoot}, request is for ${reqProject}` }, { status: 400 });
      }

      // INVARIANT: builder-kind MCP tokens only. A TASK agent's token is a valid
      // MCP token but has no business writing builder conversations or resume
      // intents, and the shared daemon token is not accepted here either — this
      // surface is narrower than both, never a second door to either.
      const identity = await lookupMcpIdentity(projectRoot, bearerToken(req));
      if (!identity || identity.kind !== 'builder') {
        logger.warn(
          `Builder storage call refused (401): presented token is ` +
          `${identity ? `a ${identity.kind} token` : 'not a valid daemon MCP token'}`,
        );
        return Response.json({
          error:
            'Unauthorized: /builder/storage requires a builder-session MCP token. ' +
            'Builder MCP tokens are minted per builder session and revoked when it ends — ' +
            'relaunch the builder to obtain a fresh one.',
        }, { status: 401 });
      }

      const produce = async (): Promise<EnvelopeResult> => {
        try {
          const params = await readJsonObjectBody(req, 'Builder storage params');
          const result = await handleBuilderStorageCall(projectRoot, params);
          return { status: 200, body: result ?? null };
        } catch (err) {
          const status = httpStatusForError(err);
          const message = err instanceof Error ? err.message : String(err);
          const line = `Builder storage call failed (${status}): ${message}`;
          if (status >= 500) logger.error(line); else logger.info(line);
          return { status, body: errorBody(err, message) };
        }
      };

      if (clientAcceptsHeartbeat(req)) return heartbeatEnvelopeResponse(produce, { signal: req.signal });
      const outcome = await produce();
      return Response.json(outcome.body, { status: outcome.status });
    }

    // GET /builder/launch-env — fresh auth/proxy env for an in-container builder
    // relaunching Claude Code after a daemon restart (see src/builder/launch-env.ts).
    if (url.pathname === '/builder/launch-env' && req.method === 'GET') {
      const reqProject = req.headers.get('x-lazy-project');
      if (!reqProject) {
        return Response.json({ error: 'Missing X-Lazy-Project header' }, { status: 400 });
      }
      if (reqProject !== projectRoot) {
        return Response.json({ error: `Project mismatch: daemon serves ${projectRoot}, request is for ${reqProject}` }, { status: 400 });
      }

      const token = bearerToken(req);
      if (!token) {
        return Response.json({ error: 'Missing Authorization bearer token' }, { status: 401 });
      }

      try {
        const body = await handleGetBuilderLaunchEnv(projectRoot, token);
        return Response.json(body);
      } catch (err) {
        const status = httpStatusForError(err);
        const message = err instanceof Error ? err.message : String(err);
        const line = `Builder launch-env failed (${status}): ${message}`;
        if (status >= 500) logger.error(line); else logger.info(line);
        return Response.json(errorBody(err, message), { status });
      }
    }

    // GET /agent/launch-env — fresh auth/proxy env for an in-container TASK
    // supervisor relaunching its agent on a retry (see
    // src/supervisor/launch-env.ts). Same shape and same authentication style as
    // /builder/launch-env, with a task MCP token instead of a builder one.
    if (url.pathname === '/agent/launch-env' && req.method === 'GET') {
      const reqProject = req.headers.get('x-lazy-project');
      if (!reqProject) {
        return Response.json({ error: 'Missing X-Lazy-Project header' }, { status: 400 });
      }
      if (reqProject !== projectRoot) {
        return Response.json({ error: `Project mismatch: daemon serves ${projectRoot}, request is for ${reqProject}` }, { status: 400 });
      }

      const token = bearerToken(req);
      if (!token) {
        return Response.json({ error: 'Missing Authorization bearer token' }, { status: 401 });
      }

      try {
        const body = await handleGetAgentLaunchEnv(projectRoot, token);
        return Response.json(body);
      } catch (err) {
        const status = httpStatusForError(err);
        const message = err instanceof Error ? err.message : String(err);
        const line = `Agent launch-env failed (${status}): ${message}`;
        if (status >= 500) logger.error(line); else logger.info(line);
        return Response.json(errorBody(err, message), { status });
      }
    }

    // GET /rpc/events — SSE event feed (see src/daemon/event-feed.ts)
    //
    // Authenticated exactly like any other /rpc/* route: the listener has
    // already resolved the actor from the Authorization header and refused the
    // request if it could not. There is deliberately no query-parameter token
    // path — the subscriber is a server-side listener process that can set
    // headers, and browsers never talk to a daemon directly
    // (docs/design/lazy-teams.md §2.3).
    if (url.pathname === '/rpc/events' && req.method === 'GET') {
      const reqProject = req.headers.get('x-lazy-project');
      if (!reqProject) {
        return Response.json({ error: 'Missing X-Lazy-Project header' }, { status: 400 });
      }
      if (reqProject !== projectRoot) {
        return Response.json(
          { error: `Project mismatch: daemon serves ${projectRoot}, request is for ${reqProject}` },
          { status: 400 },
        );
      }

      // An explicit query parameter beats the automatic header, so a client
      // resuming from a cursor it stored itself is never overridden by whatever
      // the last frame happened to set.
      const raw = url.searchParams.get('last_event_id') ?? req.headers.get('last-event-id');
      const lastEventId = parseLastEventId(raw);
      if (lastEventId === null) {
        return Response.json(
          { error: `Invalid Last-Event-ID "${raw}" — expected a non-negative integer` },
          { status: 400 },
        );
      }

      if (subscriberCount() >= MAX_EVENT_SUBSCRIBERS) {
        return Response.json(
          { error: `Too many event subscribers (limit ${MAX_EVENT_SUBSCRIBERS})` },
          { status: 503 },
        );
      }

      logger.debug(`Event feed: subscriber connected (last_event_id=${lastEventId})`);
      return eventStreamResponse({ lastEventId, signal: req.signal });
    }

    // POST /rpc/{command} — CLI command pass-through
    if (url.pathname.startsWith('/rpc/') && req.method === 'POST') {
      const command = url.pathname.slice(5);
      const reqProject = req.headers.get('x-lazy-project');
      if (!reqProject) {
        return Response.json({ error: 'Missing X-Lazy-Project header' }, { status: 400 });
      }
      if (reqProject !== projectRoot) {
        logger.warn(`RPC project mismatch: daemon serves ${projectRoot}, request for ${reqProject}`);
        return Response.json({ error: `Project mismatch: daemon serves ${projectRoot}, request is for ${reqProject}` }, { status: 400 });
      }

      const rpcStart = Date.now();
      // Same shape as the MCP route: produce the outcome once, then either send
      // it plainly or wrap it in a heartbeat envelope. `wait` alone long-polls
      // for up to 600s, which no Bun.serve idleTimeout can cover (max 255).
      const produce = async (emit?: ProgressEmitter): Promise<EnvelopeResult> => {
        try {
          // Same rule as the MCP route above: a body that is present but
          // unparsable, or that is not an object of named parameters, is a 400
          // — not a silent `{}` that runs the command with no parameters.
          const params = await readJsonObjectBody(req, `RPC ${command} params`);
          const rpcResult = await handleRpc(command, projectRoot, params, emit, rpcActor);
          const durationMs = Date.now() - rpcStart;
          logger.debug(`RPC ${command} completed in ${durationMs}ms`);
          // Void methods return undefined — normalize to null for JSON serialization
          return { status: 200, body: rpcResult ?? null };
        } catch (err) {
          const durationMs = Date.now() - rpcStart;
          // Same status mapping as the /mcp route above — one helper, so the
          // two routes can never drift on what an error means.
          const status = httpStatusForError(err);
          if (status !== 500) {
            const message = err instanceof Error ? err.message : String(err);
            logger.info(`RPC ${command} failed (${status}) in ${durationMs}ms: ${message}`);
            return { status, body: errorBody(err, message) };
          }
          const message = err instanceof Error ? err.message : 'Internal error';
          logger.error(`RPC ${command} error in ${durationMs}ms: ${message}`);
          return { status: 500, body: errorBody(err, message) };
        }
      };

      if (clientAcceptsHeartbeat(req)) return heartbeatEnvelopeResponse(produce, { signal: req.signal });
      const outcome = await produce();
      return Response.json(outcome.body, { status: outcome.status });
    }

    // BOUNDED: no match, no I/O. The caller turns this into a constant 404 (unix
    // listener) or hands off to the dashboard handler (TCP listener), which
    // applies its own deadline.
    return null; // Not a daemon route
  };

  // LAST MOMENT AT WHICH "EVERYTHING ALIVE IS FROM THE PREVIOUS GENERATION" IS
  // TRUE. Nothing can reach this daemon until the TCP listener binds below, so
  // every run visible right now belongs to the daemon that died. Enumerate them
  // here and let the reap (first reconcile tick) stop only these; see
  // src/daemon/restart-reaper.ts.
  //
  // Storage is already open by this point (initDaemonStorage, far above), and
  // the runners built for the enumeration never launch anything — the type only
  // exposes discovery — so it does not matter that the audit proxy has not bound
  // its port yet.
  //
  // A snapshot that cannot be taken degrades to an EMPTY one rather than to
  // null: reaping nothing is the safe outcome, and it keeps the one-shot from
  // re-checking on every tick forever. The storage acquisition is INSIDE the
  // guard: opening storage reads lazy.toml, and a broken config must surface
  // as the actionable "Daemon failed to load" error from the bind block below,
  // not as a raw loadConfig throw from here.
  previousGenerationSnapshot =
    (await getOrCreateStorage()
      .then((storage) => snapshotPreviousGenerationChildren(projectRoot, storage))
      .catch(err => {
        logger.warn(`Daemon restart: previous-generation snapshot failed: ${err instanceof Error ? err.message : err}`);
        return null;
      })) ?? { takenAt: new Date().toISOString(), runners: [] };

  // TCP server — serves daemon routes + web dashboard. The daemon's only
  // transport.
  let webServer: ReturnType<typeof Bun.serve> | undefined;
  let webPort: number | undefined;
  // Additional listeners on the same port (e.g. docker bridge gateway on Linux).
  const extraWebServers: ReturnType<typeof Bun.serve>[] = [];
  // Anthropic passthrough proxy — always started, after the web server.
  // Declared here (not in the start block below) so teardownPartialStart can stop
  // it if a LATER startup step fails.
  let proxyServer: ProxyServer | undefined;
  // Stops the state-file self-repair watch (see below). Declared here so
  // teardownPartialStart can clear it whenever it was already armed.
  let stopStateFileWatch: (() => void) | undefined;

  // Tear down partial startup state so a failed start leaves nothing behind:
  // no stale PID/socket/lock, no leaked timers, no dangling listeners. After
  // teardown, isDaemonRunning(projectRoot) returns false and the user can start
  // a fresh daemon as soon as they fix the cause.
  // Teardown contract: we are already throwing the primary startup error to the
  // caller, so individual cleanup step failures must not mask or replace that
  // error. Each step is best-effort — if it fails, the worst case is a stale
  // file or timer, strictly no worse than the pre-teardown state; the caller
  // sees the hard failure and will not treat the daemon as running. We log
  // failures at debug level so a persistent teardown bug stays discoverable
  // without surfacing noise to the user on every failed start.
  const safeStep = async (label: string, fn: () => unknown) => {
    try {
      await fn();
    } catch (err) {
      logger.debug(`teardown step '${label}' failed (ignored): ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const teardownPartialStart = async () => {
    await safeStep('stopReconcileLoop', () => stopReconcileLoop());
    await safeStep('stopSyncRetryLoop', () => stopSyncRetryLoop());
    await safeStep('stopSyncLoop', () => stopSyncLoop());
    await safeStep('stopCaptureLoop', () => stopCaptureLoop());
    await safeStep('stopWorktreeCleanupLoop', () => stopWorktreeCleanupLoop());
    await safeStep('stopHealthEvents', () => { stopHealthEvents?.(); stopHealthEvents = null; });
    await safeStep('closeAllEventStreams', () => closeAllEventStreams());
    await safeStep('closeSignalDb', () => closeSignalDb());
    // Flush batched spans BEFORE storage closes — the span sink writes through
    // Storage, so it must still be open here.
    await safeStep('shutdownTracing', () => shutdownTracing());
    await safeStep('closeAllStorage', () => closeAllStorage());
    // Stop the TCP listeners if they were already bound (they exist when a
    // LATER step — e.g. proxy start — fails; they are undefined/empty on an
    // early bind failure, where these are no-ops).
    // stop(true) for the same reason as stop() below: lingering keep-alive
    // connections must not answer for a port the next daemon will reuse.
    if (proxyServer) await safeStep('proxyServer.stop', () => proxyServer!.stop(true));
    if (webServer) await safeStep('webServer.stop', () => webServer!.stop(true));
    for (const extra of extraWebServers) {
      await safeStep('extraWebServer.stop', () => extra.stop(true));
    }
    // cleanupOwnDaemonFiles, not cleanupStaleFiles: these files are OURS —
    // we hold the daemon lock and lazy.pid names us, which is exactly what the
    // ownership guard in cleanupStaleFiles refuses on. The guard protects other
    // daemons' files; the owner deletes its own unconditionally.
    await safeStep('cleanupOwnDaemonFiles', () => cleanupOwnDaemonFiles(projectRoot));
    await safeStep('stopStateFileWatch', () => stopStateFileWatch?.());
    if (daemonLockFd !== null) {
      await safeStep('releaseDaemonLock', () => releaseDaemonLock(daemonLockFd!));
    }
  };

  /**
   * Record a hard startup failure that happens AFTER the daemon has started
   * building itself, and return the Error the caller must throw
   * (`throw await failStartup(msg)` — returning rather than throwing keeps the
   * abort visible to the compiler's control-flow analysis at every call site).
   *
   * This is the single shape every hard startup precondition from here on (web
   * bind, proxy) ends in, so they stay consistent as more are added: hand the
   * teardown to {@link recordStartupFailure}, which writes the marker, tears
   * the partial daemon down — never leave half a daemon running — and logs the
   * reason LAST, so teardown's own chatter cannot bury it at the end of
   * daemon.log.
   *
   * The preconditions that run before anything exists (config, credentials)
   * call recordStartupFailure without a teardown: there is nothing to tear
   * down, and the teardown closes over bindings those steps precede.
   */
  const failStartup = (errorMessage: string): Promise<Error> =>
    recordStartupFailure(projectRoot, errorMessage, teardownPartialStart);

  // Build a minimal TCP handler that can accept the bind BEFORE we touch
  // storage. Storage initialization is expensive and async — if we kicked
  // it off before bind and bind then failed, the in-flight promise would
  // race our teardown and reopen storage after we closed it. Defer the
  // real handler wiring until after bind succeeds; until then, refuse
  // requests so any client hitting the port during startup sees 503.
  // Bun.serve calls fetch() lazily so in practice this placeholder only
  // runs if a request slips in during the narrow bind→wire-up window.
  let webRequestHandler: (req: Request) => Promise<Response> = async () =>
    Response.json({ error: 'Daemon starting' }, { status: 503 });

  // The live server handle Bun hands every request. Needed here because the
  // serve proxy takes it: `server.timeout()` to exempt a proxied request from
  // the daemon idle timeout, `server.requestIP()` for X-Forwarded-For.
  type ServeHandle = Parameters<Parameters<typeof tryBindTcpPort>[1]>[1];

  // The task-service reverse proxy: `<service>.<task>.lazy.localhost:<port>`
  // forwarded to the container port `[serve]` published. It is a CLIENT of the
  // serve-state path the daemon already owns (getTaskServeState), never a second
  // resolver, and it lives in its own module so the sibling work on the
  // dashboard's routes and templates never touches it.
  //
  // The dashboard host is read through a thunk because `boundBindHost` is only
  // assigned after the bind below — same window, and same default fallback, as
  // the dashboard gate at the end of this handler.
  const serveProxyDeps: ServeProxyDeps = {
    root: projectRoot,
    getStorage: () => getOrCreateStorage(),
    dashboardHost: () => dashboardHostFor(boundBindHost),
  };
  const handleServeProxy = createServeProxy(serveProxyDeps);

  const tcpHandler = (req: Request, srv: ServeHandle): Promise<Response> => withRequestSpan(req, 'tcp', async () => {
    // A request for a task's service leaves here for the container and never
    // reaches a daemon route. It has to be FIRST: the dashboard gate below is an
    // exact host match, so it would answer every serve host with a 421.
    //
    // Being ahead of the gate is also what keeps the session cookie out of task
    // apps — the proxy never consults it, and strips it from what it forwards
    // (see upstreamRequestHeaders). And it is what exempts a proxied request
    // from WEB_REQUEST_DEADLINE_MS: a dev server holding an SSE stream open for
    // an hour is normal, and cutting it at 105s would be the bug.
    const proxied = await handleServeProxy(req, srv);
    if (proxied) return proxied;

    // Daemon routes — RPC requires auth, status does not
    const url = new URL(req.url);

    // /daemon/status is available without auth — it is the liveness probe
    if (url.pathname === '/daemon/status') {
      const daemonResponse = await handleDaemonRequest(req, false);
      if (daemonResponse) return daemonResponse;
    }

    // /mcp/*, /builder/* and /agent/* authenticate with a per-identity MCP
    // token, inside the route (see authorizeMcpCall, the /builder/storage route
    // and /agent/launch-env) — the shared daemon token is NOT accepted on any
    // of them. A task container holds only its own per-task MCP token, which is
    // exactly why its launch-env refresh is a route here rather than an /rpc/
    // call it cannot authenticate.
    if (
      url.pathname.startsWith('/mcp/') ||
      url.pathname.startsWith('/builder/') ||
      url.pathname.startsWith('/agent/')
    ) {
      const daemonResponse = await handleDaemonRequest(req, false);
      if (daemonResponse) return daemonResponse;
    }

    // /rpc/* and /daemon/shutdown authenticate as an ACTOR: the legacy shared
    // daemon token (which maps to `control`, so single-user installs are
    // unchanged) or an actor token minted for the control plane or one user.
    // Agent MCP tokens are refused here — see src/daemon/rpc-auth.ts.
    if (url.pathname.startsWith('/rpc/') || url.pathname === '/daemon/shutdown') {
      const auth = await resolveRpcActor(projectRoot, token, req.headers.get('authorization'));
      if (!auth.ok) {
        return Response.json({ error: rpcAuthErrorMessage(auth.failure) }, { status: 401 });
      }
      // Shutting the daemon down is an operator action, not a user one: a
      // per-user token exists so a human can work on TASKS through the daemon,
      // and taking the daemon away from everyone else is not that.
      if (url.pathname === '/daemon/shutdown' && auth.actor.kind !== 'control') {
        logger.warn(`Refused shutdown from non-control actor: ${describeActor(auth.actor)}`);
        return Response.json(
          { error: 'Forbidden: only a control-plane actor may shut the daemon down.' },
          { status: 403 },
        );
      }
      const daemonResponse = await handleDaemonRequest(req, false, auth.actor);
      if (daemonResponse) return daemonResponse;
    }

    // Web dashboard routes — every one requires a browser session (and none
    // exist at all in managed mode). This is the single choke point for the
    // dashboard: it sits BELOW /rpc, /mcp, /builder and /daemon/status, which
    // have their own auth, and ABOVE every page, asset and /api route, so a new
    // dashboard route cannot ship unauthenticated by omission. It is also where
    // the anti-framing headers are stamped, for the same reason — and note it
    // is BELOW the proxy above, which is what keeps them off a task's own app.
    // The host is derived from the interface actually bound (see
    // dashboardHostFor): on the loopback default that is `lazy.localhost`, a
    // name no published task app port uses, which is what keeps the session
    // cookie out of agent-written code the operator opens on 127.0.0.1.
    // `boundBindHost` is assigned right after the bind below, so the fallback
    // here is only ever taken for a request that arrives in that window — and
    // it resolves to the same default.
    const dashboardUrl = boundWebPort
      ? resolveDashboardUrl(boundBindHost, boundWebPort, startupConfig.server.dashboard_url)
      : undefined;
    return serveDashboardRequest(
      projectRoot,
      req,
      dashboardUrl ? new URL(dashboardUrl).hostname : dashboardHostFor(boundBindHost),
      webRequestHandler,
      dashboardUrl,
    );
  });

  // The full production bind path resolves port/interface from config, persists
  // the bound port, and refreshes mounted MCP configs. Under LAZY_TEST those
  // side effects would contend on the shared port window and the developer's
  // real state, so test daemons take the minimal ephemeral bind below instead —
  // unless a suite opts into the full path with _forceBindWebInTest.
  const fullBindPath = options._forceBindWebInTest === true || !process.env.LAZY_TEST;

  if (fullBindPath) {
    // Port priority: explicit option > non-default config port > last-bound
    // port > default. Preferring the last-bound port over the default keeps a
    // restart on the SAME port, so daemon MCP configs already mounted into
    // running containers/builders (target = host.docker.internal:<webPort>)
    // stay valid across the restart. A user who moves [server] port off the
    // default still wins — that's authoritative — so persistence only steers
    // the default case (see the movedConfigPort note below).
    // From the config loaded at the top of startup — see loadDaemonConfigOrFail
    // for why a lazy.toml that will not load never reaches this far, and why
    // that check cannot live here.
    const configPort = startupConfig.server.port;
    // Bind interface: defaults to loopback so the dashboard and the /mcp + /rpc
    // endpoints are not exposed to the LAN. Users opt into remote access via
    // [server] bind in lazy.toml. The dashboard authenticates too (see
    // ./dashboard-auth.ts) — loopback is the outer of two defenses, not the
    // only one, because a task container reaches this port by design.
    const bindHost = startupConfig.server.bind;
    // Runner type decides whether containers need a bridge-reachable bind on
    // Linux.
    const runnerType: RunnerType = startupConfig.runner.type;

    // A config port equal to the default is treated as "unset" for persistence:
    // the `lazy init` template writes `port = 26024` (the default) explicitly,
    // and the port always scans upward from here on EADDRINUSE — so pinning the
    // default is operationally identical to leaving it unset. Only a NON-default
    // config port expresses intent to move off the default, and it is honored
    // verbatim (above the persisted port). Everything else prefers the last-bound
    // port so a restart stays put and mounted MCP configs remain valid.
    const movedConfigPort = configPort !== DEFAULT_WEB_PORT ? configPort : undefined;
    const desiredPort =
      options.webPort
      ?? movedConfigPort
      ?? readWebPort(projectRoot)
      ?? DEFAULT_WEB_PORT;
    const attempts = options.maxPortAttempts ?? MAX_PORT_ATTEMPTS;

    // WebSocket upgraders: the web shell (`/tasks/:id/shell/ws`) and the live
    // watch panel (`/tasks/:id/watch/ws`), composed because Bun.serve takes one
    // handler per bind. Storage is resolved lazily because the upgraders are
    // built before storage init completes. They run AHEAD of tcpHandler's
    // dashboard gate, so each applies the same guard itself — same host, same
    // session cookie — on every upgrade (see src/daemon/dashboard-auth.ts).
    const wsGuard = (req: Request) => {
      const dashboardUrl = boundWebPort
        ? resolveDashboardUrl(bindHost, boundWebPort, startupConfig.server.dashboard_url)
        : undefined;
      return guardDashboardRequest(
        projectRoot,
        req,
        dashboardUrl ? new URL(dashboardUrl).hostname : dashboardHostFor(bindHost),
        dashboardUrl,
      );
    };
    const wsUpgrader = composeUpgraders([
      // FIRST, for the same reason the HTTP proxy runs ahead of the dashboard
      // gate: an HMR or ActionCable socket arrives on a serve host, which the
      // dashboard's own guard would reject as the wrong host. It takes no guard
      // — a task's app is unauthenticated on its published port today, and
      // routing it through a name does not change who may open it.
      createServeProxyUpgrader(serveProxyDeps),
      // Second, right behind the serve proxy (as /rpc/* is in the HTTP order):
      // it authenticates as /rpc/* does — an actor token, never the dashboard
      // session — so it keeps working in managed mode, where every guarded
      // upgrader below answers 404.
      sessionAttachUpgrader(),
      rpcWatchUpgrader(),
      createShellUpgrader({
        getStorage: () => getOrCreateStorage(),
        root: projectRoot,
        guard: wsGuard,
      }),
      createWatchUpgrader({
        getStorage: () => getOrCreateStorage(),
        root: projectRoot,
        guard: wsGuard,
      }),
      createActionRunUpgrader({
        getStorage: () => getOrCreateStorage(),
        guard: wsGuard,
      }),
    ]);

    let bindResult: ReturnType<typeof tryBindTcpPort> = null;
    let bindThrownError: unknown = null;
    try {
      bindResult = tryBindTcpPort(desiredPort, tcpHandler, attempts, bindHost, wsUpgrader);
    } catch (err) {
      // tryBindTcpPort rethrows anything that isn't EADDRINUSE (e.g., EACCES
      // on privileged ports, unexpected Bun.serve failures). Surface these
      // with the same actionable messaging as the "all ports busy" case.
      bindThrownError = err;
    }

    if (!bindResult) {
      // INVARIANT: failing to bind the web port is a hard startup failure.
      // Containers (builder, sandbox runners) call back via
      // host.docker.internal:<webPort>, so a daemon without a reachable web
      // port would leave container-based RPCs (e.g., getDaemonMcpConfig)
      // throwing "Daemon context not initialized" — violating CLAUDE.md's
      // "fail hard on remote failures" and "principle of least surprise".
      const lastPort = desiredPort + attempts - 1;
      // Two distinct failure modes need different remediation. Only the
      // "range exhausted" case is plausibly caused by stray daemons, so only
      // it leads with `lazy daemon kill-stray` — pointing an EACCES (privileged
      // port) failure at kill-stray would be a misleading footgun and violate
      // the principle of least surprise.
      const isRangeExhausted = !bindThrownError;
      const reason = bindThrownError
        ? `bind error: ${bindThrownError instanceof Error ? bindThrownError.message : String(bindThrownError)}`
        : `no free port in range ${desiredPort}–${lastPort} (tried ${attempts} port${attempts === 1 ? '' : 's'}, all busy)`;
      const context = isRangeExhausted
        ? `The whole port range ${desiredPort}–${lastPort} is busy — this is almost always caused by ` +
          `stray daemons (e.g. left behind by crashed or interrupted runs) squatting the range.\n`
        : ``;
      const remediation = isRangeExhausted
        ? `To fix:\n` +
          `  • Reap stray daemons whose project no longer exists: lazy daemon kill-stray\n` +
          `  • See what is holding the ports: lazy daemon list  (or  lsof -i :${desiredPort})\n` +
          `  • Stop a specific colliding daemon: lazy daemon stop --project <other-project>\n` +
          `  • Or pick a different port in lazy.toml:\n` +
          `      [server]\n` +
          `      port = <number>`
        : `To fix:\n` +
          `  • Find what is holding the port: lsof -i :${desiredPort}\n` +
          `  • Stop a colliding daemon: lazy daemon stop --project <other-project>\n` +
          `  • Or pick a different port in lazy.toml:\n` +
          `      [server]\n` +
          `      port = <number>`;
      const errorMessage =
        `Daemon failed to bind web dashboard: ${reason}. ` +
        `The daemon cannot start without a reachable TCP port — containers call back via host.docker.internal:<port>.\n` +
        `\n` +
        context +
        `\n` +
        remediation;
      // failStartup logs this through the logger (appending, after teardown, so
      // it is the last thing in daemon.log) rather than leaving it to the
      // top-level process.exit handler's console.error — that was the direct
      // cause of the reported "silent hang" symptom, where the log appeared
      // frozen at "Daemon sync loop enabled" because the actual failure went to
      // stderr before the logger had a chance to flush it.
      throw await failStartup(errorMessage);
    }

    webServer = bindResult.server;
    const actualPort = webServer.port!;
    webPort = actualPort;
    boundWebPort = actualPort;
    boundBindHost = bindHost;
    // Task service URLs (`web.my-task.lazy.localhost:26024`) ride the dashboard's
    // own host and port, so nothing can compose one until the bind has answered
    // with a port. Set it here, once, and every surface rendering inside this
    // process — the servePorts RPC, the Services card, the review page — gets
    // the name form without composing a hostname itself.
    setDashboardAuthority(`${dashboardHostFor(bindHost)}:${actualPort}`);
    // Persist the bound port so the next start prefers it (see readWebPort),
    // keeping already-mounted daemon MCP configs valid across a restart.
    // Best-effort — never blocks startup.
    writeWebPort(projectRoot, actualPort);
    // Persist the interface too: with the TCP port as the only transport, the
    // host-side CLI derives its connect address from these two files (see
    // getDaemonTcpTarget in lifecycle.ts) — a non-loopback [server] bind would
    // otherwise be unreachable from the CLI.
    writeWebHost(projectRoot, bindHost);
    // Set daemon context so RPC handlers (e.g., task launcher) can access
    // the daemon's own webPort and token without health checks.
    const dashboardUrl = resolveDashboardUrl(bindHost, actualPort, startupConfig.server.dashboard_url);
    setDaemonContext({ webPort: actualPort, token, bindHost, dashboardUrl });
    const bindHealth = daemonHealthRecorder(projectRoot);
    bindHealth.recordBind({ surface: 'dashboard', host: bindHost, port: actualPort, primary: true, ok: true });
    bindHealth.recordDashboardUrl(dashboardUrl);

    // Persisting the port keeps a restart on the SAME port *when it can* — but
    // the port window is shared across projects, so another project's daemon
    // may already hold it and we land elsewhere. Containers launched before
    // that move still target the old port, where the foreign daemon answers
    // every call with 401. Rewrite their mounted configs in place (same inode,
    // so the change is visible inside running containers) with the current
    // target; the container-side proxy re-reads on 401 and retries.
    //
    // The per-identity MCP token in each config is PRESERVED: it is bound to
    // that container's identity in the token registry, which survives the
    // restart on disk. Only the address is corrected.
    // Best-effort: housekeeping must never prevent the daemon from starting.
    try {
      // Dynamic import: task-launcher pulls in runners/drivers, and server.ts
      // deliberately keeps those off the static startup path.
      const { refreshDaemonMcpConfigs } = await import('./task-launcher');
      await refreshDaemonMcpConfigs(
        projectRoot,
        { webPort: actualPort },
        { info: (m) => logger.info(m), warn: (m) => logger.warn(m) },
      );
    } catch (err) {
      logger.warn(
        `Could not refresh daemon MCP configs for running containers: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    }

    logger.info(`Web dashboard: ${dashboardUrl}`);
    if (bindHost !== DEFAULT_SERVER_BIND) {
      // Make the exposure visible: binding beyond loopback exposes the sign-in
      // surface and daemon port to anyone who can reach this interface.
      logger.warn(
        `Daemon TCP server bound to ${bindHost}:${webPort} (not loopback). ` +
        `The web dashboard is unauthenticated and now reachable from other hosts ` +
        `on that interface. This was enabled via [server] bind in lazy.toml.`,
      );
    }

    // Container reachability on native Linux Docker/Podman.
    //
    // The primary bind above (loopback by default) lets the host CLI/browser
    // reach the daemon, but on native Linux a container reaches the host via
    // host.docker.internal -> the bridge gateway (a NON-loopback interface),
    // and a loopback-only daemon refuses that connection. So when the bind is
    // the loopback default AND a container runner is configured on Linux, we
    // ALSO bind the docker bridge gateway on the same port. This interface is
    // host-local + container-network only (not routable from the LAN), so it
    // does not widen the LAN exposure daemon-bind-localhost guards against.
    // On macOS/Windows host.docker.internal is proxied to loopback, so the
    // resolver returns loopback only and this loop is a no-op.
    const resolution = resolveDaemonBindHosts({
      configBind: bindHost,
      platform: process.platform,
      runnerType,
    });
    const extraHosts = resolution.hosts.slice(1);
    for (const host of extraHosts) {
      try {
        // Bind the SAME port (maxAttempts=1) on this interface. A different
        // local IP means this is a distinct socket, so the port is normally
        // free here even though the primary already holds it on loopback.
        const extra = tryBindTcpPort(actualPort, tcpHandler, 1, host);
        if (extra) {
          extraWebServers.push(extra.server);
          bindHealth.recordBind({ surface: 'dashboard', host, port: actualPort, primary: false, ok: true });
          logger.info(`Daemon TCP server also bound to ${host}:${actualPort} (container reachability)`);
        } else {
          const reason =
            `Could not also bind the daemon to ${host}:${actualPort} (port busy on that interface). ` +
            `Containers reaching the daemon via host.docker.internal:${actualPort} may fail. ` +
            `If agents cannot reach the daemon, set a reachable interface via [server] bind in lazy.toml.`;
          bindHealth.recordBind({ surface: 'dashboard', host, port: actualPort, primary: false, ok: false, reason });
          logger.warn(reason);
        }
      } catch (err) {
        const reason =
          `Could not also bind the daemon to ${host}:${actualPort} (container reachability): ` +
          `${err instanceof Error ? err.message : String(err)}. ` +
          `If agents cannot reach the daemon, set a reachable interface via [server] bind in lazy.toml.`;
        bindHealth.recordBind({ surface: 'dashboard', host, port: actualPort, primary: false, ok: false, reason });
        logger.warn(reason);
      }
    }

    if (resolution.bridgeUnreachable) {
      // Linux + container runner, but no docker/podman bridge interface was
      // found — agents inside containers will silently fail to reach MCP/RPC.
      // Surface it loudly with an actionable remediation instead of letting the
      // failure show up later as opaque "Daemon context not initialized" errors.
      const bridgeReason =
        `Daemon is bound to loopback (${bindHost}:${actualPort}) but no docker/podman bridge ` +
        `interface was detected, and the configured runner is "${runnerType}". On native Linux ` +
        `Docker, containers reach the daemon via host.docker.internal -> the bridge gateway, which ` +
        `a loopback-only daemon refuses — agents/supervisor/MCP may fail to reach the daemon.\n` +
        `To fix, either ensure the docker bridge (docker0) is up, or set an explicit interface:\n` +
        `  [server]\n` +
        `  bind = "0.0.0.0"   # or the docker bridge gateway IP (e.g. 172.17.0.1)`;
      bindHealth.recordBridgeUnreachable(bridgeReason);
      logger.warn(bridgeReason);
    }
  } else {
    // LAZY_TEST minimal bind. The TCP port is the daemon's only transport, so
    // even an in-process test daemon must listen — but on an OS-assigned
    // ephemeral loopback port (unless the test pins one), with none of the
    // production side effects: no config-driven port resolution, no port/host
    // persistence, no MCP config refresh, no bridge binds, no daemon context
    // and no dashboard authority (multiple in-process daemons share this
    // process, and both of those are module-level singletons they would clobber
    // for each other — the authority would then print another daemon's port into
    // this one's service URLs). The proxy itself is unaffected: it reads the
    // suffix from the Host header of the request in front of it, not from that
    // singleton, so an in-process daemon proxies normally and only the rendered
    // `publicUrl` falls back to the direct loopback URL.
    let bindThrownError: unknown = null;
    let bindResult: ReturnType<typeof tryBindTcpPort> = null;
    try {
      bindResult = tryBindTcpPort(
        options.webPort ?? 0,
        tcpHandler,
        1,
        DEFAULT_SERVER_BIND,
        (() => {
          // Same dashboard gate as production — the test bind is loopback,
          // and sessions are enforced on every bind by design. That includes
          // `[server] dashboard_url`, exactly as the HTTP gate above reads it.
          const guard = (req: Request) => {
            const configured = startupConfig.server.dashboard_url || undefined;
            return guardDashboardRequest(
              projectRoot,
              req,
              configured ? new URL(configured).hostname : dashboardHostFor(DEFAULT_SERVER_BIND),
              configured,
            );
          };
          return composeUpgraders([
            createServeProxyUpgrader(serveProxyDeps),
            sessionAttachUpgrader(),
            rpcWatchUpgrader(),
            createShellUpgrader({ getStorage: () => getOrCreateStorage(), root: projectRoot, guard }),
            createWatchUpgrader({ getStorage: () => getOrCreateStorage(), root: projectRoot, guard }),
            createActionRunUpgrader({ getStorage: () => getOrCreateStorage(), guard }),
          ]);
        })(),
      );
    } catch (err) {
      bindThrownError = err;
    }
    if (!bindResult) {
      const detail = bindThrownError instanceof Error ? bindThrownError.message : String(bindThrownError ?? 'port busy');
      throw await failStartup(`Daemon failed to bind its TCP port (test mode): ${detail}`);
    }
    webServer = bindResult.server;
    webPort = webServer.port!;
    boundWebPort = webPort;
    boundBindHost = DEFAULT_SERVER_BIND;
    const testBindHealth = daemonHealthRecorder(projectRoot);
    testBindHealth.recordBind({ surface: 'dashboard', host: DEFAULT_SERVER_BIND, port: webPort, primary: true, ok: true });
    testBindHealth.recordDashboardUrl(resolveDashboardUrl(DEFAULT_SERVER_BIND, webPort, startupConfig.server.dashboard_url));
    // Persist the discovery markers even in test mode: with TCP as the only
    // transport they are how any OTHER process (a CLI subprocess in an e2e
    // test) finds this in-process daemon. The daemon base dir is redirected in
    // tests, so this never touches real state.
    writeWebPort(projectRoot, webPort);
    writeWebHost(projectRoot, DEFAULT_SERVER_BIND);
  }

  // One-time migration: pre-unification follow-ups become non-blocking raised
  // items (docs/design/raised-items-unified.md). Idempotent — a store that has
  // already been migrated scans the task dirs, finds no legacy files, and
  // returns zeroes — so it is safe on every start, and a run interrupted
  // half-way converges on the next one.
  //
  // Deliberately awaited BEFORE the web handler and the RPC surface start
  // answering: a surface that read raised items mid-migration would show a
  // human an incomplete triage queue. And deliberately LOUD — there is a large
  // stock of open follow-ups and losing one is the failure this exists to
  // prevent, so any record that could not be converted is named at WARN and its
  // source file is left in place for a retry.
  try {
    const migration = await (await getOrCreateStorage()).migrateFollowUpsToRaisedItems();
    if (migration.converted > 0 || migration.failures.length > 0) {
      logger.info(
        `Migrated ${migration.converted} follow-up(s) to raised items across ` +
        `${migration.tasks_scanned} task(s) (${migration.already_migrated} already migrated, ` +
        `${migration.tasks_retired} legacy file(s) retired)`,
      );
    }
    for (const failure of migration.failures) {
      logger.warn(
        `Follow-up migration could not convert a record on task ${failure.task_id}` +
        `${failure.follow_up_id ? ` (follow-up ${failure.follow_up_id})` : ''}: ${failure.reason}. ` +
        `The task's follow-ups.json was left in place — it will be retried on the next daemon start.`,
      );
    }
  } catch (err) {
    // A migration that cannot run is reported, not fatal: the daemon still
    // serves, and every already-converted item is already visible.
    logger.warn(
      `Follow-up → raised-item migration failed: ${err instanceof Error ? err.message : String(err)}. ` +
      `Any unconverted follow-ups are still on disk and will be retried on the next daemon start.`,
    );
  }

  // One-time migration: attribution stored as a control plane's user id becomes
  // the email the store now names people by (docs/design/actor-identity-and-
  // remote-clients.md §3.8). Idempotent — a migrated store is walked, rewrites
  // nothing and reports zeroes — so it is safe on every start.
  //
  // Also before the surfaces answer, and for the same reason as the migration
  // above: a page rendered mid-rewrite would attribute a row to nobody and then
  // to somebody. And deliberately LOUD about what it CLEARED: an id this
  // install cannot read as a person is dropped, so the count and the ids
  // themselves are reported rather than left for somebody to notice later.
  try {
    const identity = await (await getOrCreateStorage()).migrateActorIdentity();
    if (identity.carried > 0 || identity.files_rewritten > 0) {
      logger.info(
        `Migrated stored attribution to actor_email: ${identity.carried} carried forward across ` +
        `${identity.files_rewritten} file(s) in ${identity.tasks_scanned} task(s)`,
      );
    }
    if (identity.cleared > 0) {
      const ids = identity.cleared_ids.join(', ') +
        (identity.cleared_ids_truncated ? ', …' : '');
      logger.warn(
        `${identity.cleared} row(s) had an actor id this install cannot resolve to a person; ` +
        `their attribution was cleared (the rows keep their actor role). ` +
        `The ids were: ${ids}. If a control plane knows who these are, it can map them ` +
        `and rewrite the rows — see docs/design/actor-identity-and-remote-clients.md §3.8.`,
      );
    }
    for (const failure of identity.failures) {
      logger.warn(
        `Actor identity migration could not rewrite ${failure.file} on task ${failure.task_id}: ` +
        `${failure.reason}. The file was left as it was and is retried on the next daemon start.`,
      );
    }
  } catch (err) {
    // Same posture as the migration above: reported, not fatal. Every row it
    // did rewrite is already correct, and the rest are retried next start.
    logger.warn(
      `Actor identity migration failed: ${err instanceof Error ? err.message : String(err)}. ` +
      `Any unmigrated attribution is still on disk and will be retried on the next daemon start.`,
    );
  }

  // One-time import of lazy.toml's `[serve] start_services_cmd` into the store,
  // where the Start services command now lives. Idempotent: a no-op once the
  // store holds a command. Not fatal — until it succeeds, the command still
  // resolves from lazy.toml, so no user's setting disappears either way.
  try {
    const imported = await importStartServicesCmdFromConfig(await getOrCreateStorage(), projectRoot);
    if (imported) {
      logger.info(
        `Imported the Start services command "${imported}" from lazy.toml [serve] start_services_cmd ` +
        `into the project store. Change it from a task's Services card; lazy.toml is no longer read for it.`,
      );
    }
  } catch (err) {
    logger.warn(
      `Could not import [serve] start_services_cmd into the project store: ` +
      `${err instanceof Error ? err.message : String(err)}. It is still read from lazy.toml; ` +
      `the import is retried on the next daemon start.`,
    );
  }

  // Bind succeeded — now wire up the real web request handler. Storage
  // initialization is kicked off eagerly so the first web request
  // doesn't pay the cold-start cost, but we're past the bind failure
  // window so there's no teardown race.
  const handlerPromise = (async () => {
    const storage = await getOrCreateStorage();
    // The review surface mutates state (ask dispatch, unblock, accept). It
    // does so only through this port, which runs in-process here — the web
    // layer never becomes a second writer.
    return createWebRequestHandler(storage, createReviewActions(projectRoot), {
      messageActions: createMessageActions(),
      reviewSessionActions: createReviewSessionActions(projectRoot),
      memoryActions: createMemoryActions(projectRoot),
      doctorActions: createDoctorActions(projectRoot),
      taskActions: createTaskEditActions(projectRoot),
      serveActions: createServeActions(projectRoot),
      usagePauseState: () => describeUsagePauseState(projectRoot, storage),
    });
  })();
  webRequestHandler = async (req: Request) => {
    const handler = await handlerPromise;
    return handler(req);
  };

  // Start the Anthropic passthrough proxy. This is ALWAYS ON — there is no
  // config option to turn it off — so the proxy is part of a normal daemon
  // start, like the web server.
  // The daemon owns the proxy: it announces its address at INFO next to the
  // dashboard. Audit records do NOT go through Storage — they are disposable
  // telemetry written to the project-local, size-capped
  // `.lazy/logs/proxy-audit.jsonl`.
  try {
    // Search from projectRoot explicitly — loadConfig otherwise defaults its
    // search to process.cwd(), which is the project root for a real daemon but
    // NOT for an in-process test daemon.
    const cfg = await loadConfig(projectRoot);
    // Managed mode deliberately pins `[data] path` to `.lazy` (managed.ts), so
    // no fleet override here: the audit log is PROJECT-LOCAL telemetry by
    // design (see the module comment in src/proxy/audit-log.ts), and the store
    // dir is a synced artifact that a growing stream once broke a push on.
    const dataDir = join(projectRoot, cfg.data.path);

    // Upgrade path: earlier versions appended the audit stream to the STORE
    // root with no cap, where it reached 677 MiB and broke a store push. Drop
    // it — telemetry, not durable state — and say so rather than letting data
    // disappear silently.
    //
    // This is cleanup of a file a PREVIOUS version wrote, and runs on every
    // start regardless of how the proxy is doing.
    try {
      const storePath = (await getOrCreateStorage()).getStoragePath();
      const pruned = await pruneLegacyAuditLog(storePath);
      if (pruned) {
        logger.info(
          `Removed the legacy proxy audit log at ${pruned.path} (${formatSize(pruned.bytes)}). ` +
          `Audit records now live in ${auditLogPath(dataDir)}, capped at ` +
          `${formatSize(AUDIT_SEGMENT_MAX_BYTES * (AUDIT_RETAINED_SEGMENTS + 1))}. ` +
          `If that store is a git repo, the old blob is still in its history — ` +
          `use git filter-repo to purge it.`,
        );
      }
    } catch (err) {
      // Cleanup is best-effort housekeeping: a failure here must not stop the
      // daemon from starting. Say what happened so it is not silent.
      logger.warn(
        `Could not remove the legacy proxy audit log from the store root: ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        `It is safe to delete by hand.`,
      );
    }

    // User-authored request plugins, loaded by convention from the MAIN
    // checkout's .lazy/plugins (never a task worktree — see the loader). A
    // broken plugin throws here and is handled by the catch below, exactly
    // like a bad proxy config: loud, never silently ignored.
    const requestPlugins = await loadProxyRequestPlugins(projectRoot);
    proxyServer = createProxyServer(
      {
        // PROFILE UPSTREAMS: an `endpoint` on `[agents.<name>]` is where the
        // PROXY forwards that profile's traffic; the launched agent always dials
        // the proxy itself.
        ...cfg.proxy,
        // Where a task container can reach it: the bridge gateway on native
        // Linux, under the daemon port's own conditions (see bind-hosts.ts).
        // `[proxy] bind` keeps its meaning and its managed-mode pin.
        extraBindHosts: resolveProxyBindHosts({
          configBind: cfg.proxy.bind,
          platform: process.platform,
          runnerType: cfg.runner.type,
        }).hosts.slice(1),
        agentUpstreams: agentUpstreamMap(cfg),
        plugins: requestPlugins,
        // Per-user credentials: lets the proxy turn a container's session
        // placeholder into its owner's real token. Inert until a control
        // plane has stored a per-user credential in this daemon.
        resolveSessionCredential: createSessionCredentialResolver(projectRoot),
      },
      // The audit log, with a live per-task tally teed off it. The tee
      // forwards every record to the log unchanged and adds one in-memory
      // addition, which is what makes a mid-turn token counter possible
      // without a new stream, a new file, or anything at all on the
      // daemon→supervisor channel.
      teeTaskProgress(new ProxyAuditLog(dataDir)),
      // JIT credentials: from here on the daemon is the only process that holds
      // a real one. Launched agents carry placeholders the proxy exchanges.
      buildProxyCredentialDeps(projectRoot, cfg),
      {
        // Durable per-task tool stats. The store is resolved per call rather
        // than awaited here: `getOrCreateStorage` memoizes, and making proxy
        // construction wait on storage init would hold up the bind for a
        // number nobody is reading yet.
        toolStats: new ProxyToolStatsRecorder({
          getToolStats: async (taskId) => (await getOrCreateStorage()).getToolStats(taskId),
          saveToolStats: async (record) => (await getOrCreateStorage()).saveToolStats(record),
        }),
      },
    );
    // Publish the ACTUAL bound port (OS-assigned when `[proxy] port` was
    // omitted) so per-launch env injection and `lazy daemon status` resolve
    // the real proxy address.
    if (proxyServer.port) setDaemonProxyPort(proxyServer.port);
    // What `lazy daemon health` probes: the addresses, the audit directory and
    // the audit queue's own record — never a credential.
    {
      const running = proxyServer;
      daemonHealthRecorder(projectRoot).setProxy({
        bind: cfg.proxy.bind,
        binds: running.binds,
        port: running.port ?? null,
        auditDir: auditLogDir(dataDir),
        auditHealth: () => running.auditHealth(),
      });
    }
    // Announce the proxy at INFO alongside the web-dashboard line, on start
    // and restart, so operators can see where audited traffic flows.
    const fbCount = cfg.proxy.fallbacks.length;
    const alsoBound = proxyServer.binds.slice(1);
    logger.info(
      `Proxy: http://${cfg.proxy.bind}:${proxyServer.port} → ${cfg.proxy.upstream} ` +
      `(${fbCount} fallback${fbCount === 1 ? '' : 's'}, policy ${cfg.proxy.policy.enforce ? 'on' : 'off'}` +
      `${alsoBound.length ? `, also on ${alsoBound.map((h: string) => `${h}:${proxyServer!.port}`).join(', ')} for containers` : ''})`,
    );
    // A plugin rewrites outbound request bodies, so it must never be silently
    // active. Announced by name and in chain order whenever any are loaded —
    // the default (no .lazy/plugins directory) stays quiet.
    if (requestPlugins.length > 0) {
      logger.info(
        `Proxy: ${requestPlugins.length} request plugin${requestPlugins.length === 1 ? '' : 's'} ` +
        `loaded from ${PLUGIN_DIR_RELATIVE}, rewriting outbound requests in this order: ` +
        requestPlugins.map((p) => p.name).join(' → '),
      );
    }
  } catch (err) {
    // A proxy startup failure is a CONTROLLED startup error — never an unhandled
    // rejection that silently kills reconcile/sync/web (that was the ~6s-after-boot
    // daemon death), and never a silent fall-through to direct connections.
    //
    // Falling back to direct would be the WORST outcome: agent traffic would flow
    // straight to Anthropic while the audit trail recorded nothing, so the trail
    // would lie by omission and the connector deny-rules would silently not apply.
    // So we do NOT half-run: tear down the partial daemon and surface why + what
    // to do (CLAUDE.md: fail hard, cleanly and actionably — no silent fallback).
    const detail = err instanceof Error ? err.message : String(err);
    const errorMessage =
      `Daemon failed to start the [proxy] server: ${detail}\n` +
      `\n` +
      `lazy routes all agent model traffic through its local audit/policy proxy, always, ` +
      `and will not run half-configured: continuing without it would send agent traffic ` +
      `direct while the audit trail recorded nothing. There is no way to turn the proxy ` +
      `off — the fix is to get it running.\n` +
      `\n` +
      `To fix:\n` +
      `  • Port already in use: the proxy picks a free port automatically, so this means a\n` +
      `    pinned port is taken — drop or change it:\n` +
      `      [proxy]\n` +
      `      port = <number>   # or remove the line to auto-assign\n` +
      `  • Storage lock contention (another project's daemon holds the lock): two projects\n` +
      `    must not share one store — check [storage] external_path in lazy.toml, and run\n` +
      `    'lazy daemon list' to see which project each daemon serves.\n` +
      `  • Bind address unavailable: [proxy] bind must be an address this host owns\n` +
      `    (the default, 127.0.0.1, always works).`;
    throw await failStartup(errorMessage);
  }

  const result: RunningDaemon = {
    token,
    startedAt,
    projectRoot,
    knownTaskIds,
    webServer: webServer!,
    extraWebServers,
    webPort: webPort!,
    bindHost: boundBindHost!,
    dashboardUrl: resolveDashboardUrl(boundBindHost, webPort!, startupConfig.server.dashboard_url),
    proxyServer,
    stop: async () => {},
  };

  // Set below, once `stop` exists. Null in every production daemon — the watch
  // only arms when the test harness declares a parent pid.
  let stopTestParentWatch: (() => void) | null = null;

  async function stop() {
    if (stopped) return;
    stopped = true;
    if (stopTestParentWatch) stopTestParentWatch();
    logger.info('Daemon shutting down...');

    // [usage_pause] readings still waiting out their write throttle: written
    // now, so a restart seeds from the latest one. Bounded, and never fatal.
    await Promise.race([
      flushUsageReadingWrites().catch((err) => {
        logger.warn(`Shutdown: could not save the latest usage readings: ${err instanceof Error ? err.message : String(err)}`);
      }),
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);

    // Terminate active supervisors before shutting down. Without this,
    // supervisors become orphans. discoverRunningRuns() is global (finds ALL
    // lazy-* containers/PIDs) but PER RUNNER TYPE — a docker runner can't see
    // host PIDs and vice versa. Since tasks may run on different runners
    // (per-task overrides), discover on each distinct runner type that this
    // project's sessions actually ran on (plus the global default), filtering
    // to supervisors that belong to this project.
    //
    // OWNERSHIP comes from storage, via the same naming function that named the
    // run (see src/runner/run-ownership.ts). knownTaskIds — short ids recorded
    // by the reconcile loop — is only the fallback for when storage cannot be
    // read at shutdown, and it can only ever match a task with no code, since
    // every coded task's run is named for its code.
    try {
      const config = await loadConfig(projectRoot);
      const runnerTypes = new Set<RunnerType>([config.runner.type]);
      let storage: Storage | null = null;
      try {
        storage = await getOrCreateStorage();
        for (const session of await storage.listSessions(undefined, true)) {
          if (session.runner_type) runnerTypes.add(session.runner_type);
        }
      } catch (err) {
        logger.debug(`Shutdown: could not list sessions for runner discovery: ${err instanceof Error ? err.message : err}`);
      }

      for (const runnerType of runnerTypes) {
        let runner;
        try {
          runner = await createRunner(projectRoot, runnerType);
        } catch (err) {
          // A configured-but-unavailable runner (e.g. docker not installed)
          // simply has no runs to stop — skip it.
          logger.debug(`Shutdown: skipping runner ${runnerType}: ${err instanceof Error ? err.message : err}`);
          continue;
        }

        let owned: OwnedRuns | null = null;
        if (storage) {
          try {
            owned = await indexRunsByName(storage, runner);
          } catch (err) {
            logger.warn(`Shutdown: could not index this project's runs: ${err instanceof Error ? err.message : err}`);
          }
        }

        const runs = await runner.discoverRunningRuns();

        /**
         * A SHORT per-run grace for the HOST runner only.
         *
         * This sweep runs while whoever signalled us counts down to SIGKILL, and
         * everything that must survive — the interrupt records below, the storage
         * close at the end — sits on the far side of it. The host runner's
         * standalone default is a 5s SIGTERM→SIGKILL window, which does not fit
         * inside SIGNAL_SHUTDOWN_BUDGET_MS, so it is asked to escalate faster.
         *
         * Docker is deliberately left alone. There `gracefulTimeoutSeconds` is
         * not "a shorter grace" at all — it is the switch from `docker kill`
         * (immediate, the default) to `docker stop --time <n>` (SIGTERM, wait,
         * SIGKILL), and it raises the CLI spawn timeout to match. Passing it
         * would make production's runner spend real wall clock per container
         * inside this budget, to buy a politeness its own default has already
         * decided is worthless. Docker's default IS the fast path; only the host
         * runner needs telling.
         */
        const shutdownStopOpts = runner.type === 'dangerously-host-process-without-any-isolation'
          ? { gracefulTimeoutSeconds: SHUTDOWN_STOP_GRACE_SECONDS }
          : undefined;

        // Stopped in PARALLEL: each stop may wait out a SIGTERM grace period
        // before escalating, and the whole shutdown has to fit inside the window
        // its caller allows (see SIGNAL_SHUTDOWN_BUDGET_MS, and `lazy daemon
        // stop`'s own 5s/15s clocks). Serially, two slow-to-die supervisors were
        // already enough to make the CLI report the daemon as stuck.
        const stoppedTaskIds: string[] = [];
        await Promise.all(runs.map(async runName => {
          // Extract task short ID from run name (e.g., "lazy-abcd1234" → "abcd1234").
          // Only meaningful for an uncoded task — the knownTaskIds fallback below.
          const taskShortId = runName.replace(/^lazy-/, '');
          if (!taskShortId) return;

          // Only stop supervisors that belong to this project. With no evidence
          // of ownership (storage unreadable AND no reconcile tick yet) nothing
          // is stopped: a wrongly-killed supervisor costs a human's turn, a
          // missed one is cleaned up by the next daemon's restart reaper.
          const ownedByStorage = owned?.has(runName) ?? false;
          if (!ownedByStorage && (knownTaskIds.size === 0 || !knownTaskIds.has(taskShortId))) {
            logger.debug(`Skipping supervisor ${runName}: not owned by ${projectRoot}`);
            return;
          }

          try {
            logger.info(`Stopping supervisor ${runner.runDisplayName(runName)}...`);
            const ok = await runner.stopRun(runName, shutdownStopOpts);
            if (ok) {
              logger.info(`Stopped supervisor ${runner.runDisplayName(runName)}`);
              const task = owned?.get(runName);
              if (task) stoppedTaskIds.push(task.id);
            } else {
              logger.warn(`Failed to stop supervisor ${runner.runDisplayName(runName)}`);
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn(`Error stopping supervisor ${runName}: ${msg}`);
          }
        }));

        // Say what happened, in the task's own record. We just ended these
        // turns; left to the next daemon's ordinary crash path they would read
        // as "General error (exit code 1)", which sends whoever looks hunting
        // for a bug in an agent that did nothing wrong. Recording it here also
        // makes the task auto-resumable: `interrupted` is the status the next
        // daemon's stranded-interrupt sweep picks up. No resume is attempted
        // from here — this process is on its way out.
        for (const taskId of stoppedTaskIds) {
          try {
            await interruptForDaemonStop(storage!, taskId, projectRoot);
          } catch (err) {
            logger.warn(`Shutdown: could not mark task ${taskId.substring(0, 8)} interrupted: ${err instanceof Error ? err.message : err}`);
          }
        }
      }
    } catch (err) {
      // Best-effort: if we can't create a runner (e.g., config deleted),
      // log and continue — don't block daemon shutdown.
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Could not enumerate supervisors for ${projectRoot}: ${msg}`);
    }

    stopReconcileLoop();
    stopSyncRetryLoop();
    stopSyncLoop();
    stopCaptureLoop();
    stopWorktreeCleanupLoop();
    stopStateFileWatch?.();
    // Close SSE subscribers explicitly rather than leaving them to
    // webServer.stop(true) below: an ended stream lets the client see a clean
    // EOF and reconnect, and it clears the heartbeat timers before the process
    // is torn down.
    stopHealthEvents?.();
    stopHealthEvents = null;
    closeAllEventStreams();
    closeSignalDb();
    // Clear the `waiting.json` markers this daemon owns. Readers already
    // disbelieve a marker whose daemon pid is dead, but a clean stop should not
    // rely on that fallback.
    await clearAllWaits().catch(err => {
      logger.warn(`Shutdown: clearing wait markers failed: ${err instanceof Error ? err.message : err}`);
    });
    // Same for agent-reported progress lines (progress.json) — same rationale.
    await clearAllProgress().catch(err => {
      logger.warn(`Shutdown: clearing progress markers failed: ${err instanceof Error ? err.message : err}`);
    });
    // Flush any batched spans BEFORE storage closes — the span sink writes
    // through Storage, so it must still be open here.
    await shutdownTracing().catch(() => {});
    // Close all long-lived Storage instances. Awaited: closing is what releases
    // .storage-lock, and a caller that awaits stop() (a new daemon starting, a
    // test tearing down) must be able to rely on the lock being free when stop()
    // resolves. Fire-and-forget left the lock held past shutdown, so the next
    // process to want it spent its whole retry budget waiting on a corpse.
    await closeAllStorage().catch(err => {
      logger.warn(`Shutdown: closing storage failed: ${err instanceof Error ? err.message : err}`);
    });
    if (shutdownTimer) {
      clearTimeout(shutdownTimer);
      shutdownTimer = null;
    }
    // stop(true): close active connections too. A graceful stop leaves idle
    // keep-alive connections answering after the listener unbinds — and once
    // the OS (or the persisted-port logic) hands the same port to the NEXT
    // daemon, a client's pooled connection gets its reply from this stopped
    // daemon instead. With TCP as the only transport the port is reused by
    // design, so lingering connections must die with the daemon.
    if (webServer) {
      webServer.stop(true);
    }
    if (proxyServer) {
      proxyServer.stop(true);
    }
    for (const extra of extraWebServers) {
      extra.stop(true);
    }
    // Our own files — see the note in teardownPartialStart. Using the guarded
    // cleanupStaleFiles here would refuse (we still hold the lock), leaving a
    // stale PID file behind after a clean stop.
    cleanupOwnDaemonFiles(projectRoot);
    // Release the exclusive daemon lock. Closing the fd releases the flock,
    // allowing a new daemon to start immediately.
    if (daemonLockFd !== null) {
      releaseDaemonLock(daemonLockFd);
    }
    logger.info('Daemon stopped');
    process.removeListener('SIGTERM', onSigterm);
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGHUP', onSighup);
    // Same discipline as the signal listeners, and load-bearing for in-process
    // test daemons: leaving the guards installed would keep a listener on the
    // `bun test` process, and a present listener is exactly what stops Bun
    // exiting on an unhandled rejection — masking real failures in later files.
    uninstallProcessGuards();
  }

  /** Set once a signal-driven shutdown is in flight, so repeats join it. */
  let signalShutdown: Promise<void> | null = null;

  /**
   * Shut down on a signal, giving `stop()` a bounded chance to finish first.
   *
   * It used to be `stop()` fire-and-forget followed immediately by
   * `process.exit(0)`, which never got past `stop()`'s first `await` — so the
   * supervisor sweep its own comment describes ("Without this, supervisors
   * become orphans") did not happen at all on this path, and a `kill` of the
   * daemon left every supervisor running, plus every agent under it on the
   * host-process runner. That was invisible from a terminal, where Ctrl-C
   * reached the whole foreground process group; supervisors now lead groups of
   * their own so the daemon can stop the agents with them
   * (src/runner/host-process-runner.ts), and this is the only thing that
   * reaches them.
   *
   * Bounded by SIGNAL_SHUTDOWN_BUDGET_MS, because a signal is an instruction and
   * not a request: if the shutdown cannot finish in time the daemon exits
   * anyway. That budget is also the floor every caller allows before escalating
   * to SIGKILL — the two numbers are one contract, written down once.
   *
   * A REPEAT signal joins the shutdown already in flight rather than exiting on
   * the spot. `stop()` is idempotent, so a second call returns immediately —
   * which meant a second Ctrl-C landed on `process.exit(0)` while the first was
   * still inside `loadConfig`/`listSessions`/`discoverRunningRuns`, before a
   * single supervisor had been signalled. That leaked exactly what this task
   * exists to stop. The impatient caller is not made to wait long: the budget
   * caps the whole thing either way.
   */
  function shutdownOnSignal(name: string) {
    logger.info(`Received signal: ${name}`);

    if (signalShutdown) {
      logger.info(
        `Shutdown already in progress — it stops this project's agents first and ` +
        `gives up after ${SIGNAL_SHUTDOWN_BUDGET_MS / 1000}s.`,
      );
      return;
    }

    signalShutdown = stop().catch(err => {
      logger.warn(`Shutdown after ${name} failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    const capped = new Promise<void>(resolve => setTimeout(resolve, SIGNAL_SHUTDOWN_BUDGET_MS));
    Promise.race([signalShutdown, capped]).then(() => process.exit(0));
  }

  function onSigterm() {
    shutdownOnSignal('SIGTERM');
  }
  function onSigint() {
    shutdownOnSignal('SIGINT');
  }
  /**
   * SIGHUP is a shutdown here, not a reload.
   *
   * A foreground daemon whose terminal closes gets SIGHUP, and with no handler
   * the default disposition kills the process outright — `stop()` never runs, so
   * every supervisor and agent is left behind. That used to be survivable by
   * accident: the same terminal hangup reached them too, because they shared the
   * daemon's process group. They lead their own groups now, so closing a
   * terminal would strand them. Lazy has no reload semantics for SIGHUP to
   * compete with, so the shutdown reading is the only one available.
   */
  function onSighup() {
    shutdownOnSignal('SIGHUP');
  }
  process.on('SIGTERM', onSigterm);
  process.on('SIGINT', onSigint);
  process.on('SIGHUP', onSighup);

  // Last-resort net, installed only now that startup has SUCCEEDED — a daemon
  // that could not bind, open its store or start its proxy still fails hard
  // above (failStartup), because a half-running daemon is worse than none.
  // From here on, the proxy shares this process with the RPC listener, so a
  // stray rejection anywhere would otherwise end every task's turn at once.
  // See ./process-guards.ts for why surviving beats crashing here.
  const uninstallProcessGuards = installDaemonProcessGuards();

  // Test-only: a daemon spawned by an e2e run must die with that run, even when
  // the `bun test` process is SIGKILLed and none of its teardown hooks execute.
  // No-op unless LAZY_TEST_PARENT_PID is set — see ./test-parent-watch.ts.
  stopTestParentWatch = startTestParentWatch(async () => {
    logger.info(
      `${TEST_PARENT_PID_ENV} process ${process.env[TEST_PARENT_PID_ENV]} exited — ` +
      `stopping test daemon (PID ${process.pid})`,
    );
    await stop();
    process.exit(0);
  });

  result.stop = stop;

  // Self-repair for our own state files. If anything deletes lazy.pid
  // underneath us (a tmp reaper, an over-eager cleanup script, an older lazy
  // build), the file-based fallbacks — liveness when the lock verdict is
  // 'unknown', `lazy doctor`'s reporting — stop naming this daemon. The PID
  // file we simply rewrite. (The socket re-bind this watch was born for went
  // away with the socket — a bound TCP listener cannot be deleted out from
  // under the daemon.)
  stopStateFileWatch = startDaemonStateFileWatch({ projectRoot });

  logger.info(`Daemon ready (PID ${process.pid}, ${boundBindHost}:${webPort})`);

  return result;
}

/**
 * Start a periodic reconciliation loop for the daemon's single project.
 *
 * Follows the same pattern as src/server/index.ts startReconcileLoop:
 * - Skips a tick if the previous reconcile is still running
 * - Errors are logged but never crash the server
 * - First reconcile runs after 1s delay
 * - Subsequent reconciles every intervalSeconds
 */
function startDaemonReconcileLoop(
  projectRoot: string,
  intervalSeconds: number,
  knownTaskIds: Set<string>,
  onBudgetUpdate: ((tasksAtLimit: string[]) => void) | undefined,
  getPreviousGenerationSnapshot: () => PreviousGenerationSnapshot | null,
): () => void {
  let reconciling = false;
  let reconcileStartedAt = 0;
  let stopped = false;
  /**
   * Guards the one-shot previous-generation reap.
   *
   * Set only once a snapshot actually exists — startup takes the snapshot after
   * this loop is created, so on a slow start the first tick may find none. That
   * must mean "reap on a later tick", not "never reap".
   */
  let reapedPreviousGeneration = false;

  // Safety timeout: if a reconcile tick runs longer than this, the next tick
  // force-resets the guard and proceeds. This prevents a single hanging
  // subprocess (e.g., `gh` CLI, `git push`) from permanently blocking all
  // future reconciliation. The old tick continues in the background but the
  // critical path (detecting finished tasks) is no longer blocked.
  //
  // With subprocess-level timeouts (DEFAULT_SUBPROCESS_TIMEOUT_MS = 60s) and
  // withRemoteRetry (3 attempts × 60s + backoff), a single remote operation
  // can take up to ~190s. 300s gives headroom for multiple phases.
  const RECONCILE_TICK_TIMEOUT_MS = 300_000; // 5 minutes

  // Event state tracked across reconcile ticks
  const eventState = createReconcileEventState();

  /**
   * Run a reconcile phase with isolated error handling.
   * Each phase runs independently — a failure in one phase does not
   * prevent subsequent phases from executing.
   */
  async function runPhase(label: string, fn: () => Promise<void>): Promise<void> {
    // Recorded for `lazy daemon health` as well as logged: a phase failing on
    // every tick is exactly the state nobody notices in a log.
    await runRecordedSweep(projectRoot, RECONCILE_LOOP, label, fn, (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Reconcile phase '${label}' failed: ${msg}`);
    });
  }

  const health = daemonHealthRecorder(projectRoot);
  health.loopStarted(RECONCILE_LOOP, intervalSeconds * 1_000);

  const doReconcile = async () => {
    if (stopped) return;

    if (reconciling) {
      const elapsed = Date.now() - reconcileStartedAt;
      if (elapsed > RECONCILE_TICK_TIMEOUT_MS) {
        // Previous tick has been running too long — likely a hanging subprocess.
        // Force-reset and proceed. The old tick's finally block will be a no-op
        // because we use a generation check (reconcileStartedAt changes).
        logger.warn(
          `Daemon reconcile: previous tick exceeded ${RECONCILE_TICK_TIMEOUT_MS / 1000}s ` +
          `(${Math.round(elapsed / 1000)}s elapsed), force-resetting reconcile guard`
        );
        reconciling = false;
      } else {
        logger.debug('Daemon reconcile: skipping tick, previous reconcile still running');
        health.tickSkipped(RECONCILE_LOOP);
        return;
      }
    }

    reconciling = true;
    const myStartTime = Date.now();
    reconcileStartedAt = myStartTime;
    health.tickStarted(RECONCILE_LOOP);
    let tickError: unknown;

    // Announce the tick BEFORE doing anything in it. Until this line existed, a
    // tick that wedged in an early phase (storage open, listTasks, loadConfig,
    // reconcileTasks) logged nothing at all — the first entry was the
    // "tick completed" line at the very end — so an unfinished tick was
    // indistinguishable from an idle daemon in the log. Debug level: this fires
    // every few seconds and is a diagnostic, not an event.
    logger.debug('Daemon reconcile tick starting');

    // Check log rotation at the start of each tick
    logger.checkRotation();

    const reconcileStart = Date.now();
    try {
      const storage = await getOrCreateStorage();

      // FIRST TICK ONLY: stop the children the PREVIOUS daemon launched.
      //
      // They hold this project's old proxy address, which died with that
      // process, and nothing in a container can notice that for itself. This
      // runs ahead of reconcileTasks deliberately: left to the ordinary
      // run-stopped path, those tasks would be recorded as having crashed on
      // their own, which is both wrong and unhelpfully vague. See
      // src/daemon/restart-reaper.ts.
      //
      // Only the children named in the pre-listen snapshot are eligible, so a
      // task started by a human while the daemon was still coming up is never
      // caught by this. No snapshot means no evidence and nothing is reaped.
      if (!reapedPreviousGeneration) {
        const snapshot = getPreviousGenerationSnapshot();
        if (snapshot) {
          reapedPreviousGeneration = true;
          await runPhase('reapPreviousGeneration', async () => {
            await reapPreviousGenerationChildren(projectRoot, storage, snapshot);
          });
        } else {
          logger.debug('Daemon restart: no previous-generation snapshot yet; deferring reap to a later tick');
        }
      }

      // Cache task short IDs so stop() can filter supervisors synchronously
      // without needing async storage access.
      try {
        const allTasks = await storage.listTasks();
        knownTaskIds.clear();
        for (const t of allTasks) {
          knownTaskIds.add(t.id.substring(0, 8));
        }
      } catch (err) {
        logger.debug(`Failed to cache task IDs: ${err instanceof Error ? err.message : err}`);
      }

      // --- Check offline mode once per tick ---
      // Load config to read the permanent-offline flag ([remote] offline). The
      // expiry check itself is just a timestamp comparison on offline.json; the
      // small config read here is what lets a permanent-offline project gate
      // remote ops without writing to the offline file.
      const reconcileConfig = await loadConfig(projectRoot);
      const offline = await isOfflineMode(join(projectRoot, '.lazy'), reconcileConfig.remote.offline);

      // --- Critical path: detect finished tasks and transition states ---
      // This must run before any network operations (push, sync, auto-react)
      // that could hang and block the tick. Sync alone can take 2-3 minutes
      // (pushing branches, fetching PR comments), and if it runs first the
      // working-task sweep gets preempted by pending HTTP requests every tick.

      // Snapshot working tasks before reconciliation so we can detect
      // which ones transition to blocked/conflict (turn completed).
      const workingBefore = await storage.listTasksWithOptions({ workingOnly: true });
      const workingIds = new Set(workingBefore.map(t => t.id));
      const branchByTaskId = new Map<string, string>();
      const parentByTaskId = new Map<string, string | null>();

      for (const task of workingBefore) {
        parentByTaskId.set(task.id, parentTaskIdOf(task));
        const session = await storage.getSessionByTaskId(task.id);
        if (session?.git_branch) {
          branchByTaskId.set(task.id, session.git_branch);
        }
      }

      await runPhase('reconcileTasks', async () => {
        await reconcileTasks(storage, projectRoot);
      });

      // After reconciliation, detect state changes and route events + push branches.
      // These are lower priority than serving HTTP requests, so check for pending
      // requests between major steps.
      const stateChanges: StateChange[] = [];

      await runPhase('detectStateChanges', async () => {
        for (const taskId of workingIds) {
          if (stopped) break;
          try {
            const branch = branchByTaskId.get(taskId);

            const task = await storage.getTask(taskId);
            if (!task) continue;

            // Detect state change from 'working' to something else
            if (task.status !== 'working') {
              stateChanges.push({
                taskId,
                previousStatus: 'working',
                currentStatus: task.status,
                parentTaskId: parentByTaskId.get(taskId) ?? null,
              });
            }

            if (!offline && branch && (task.status === 'blocked' || task.status === 'conflict' || task.status === 'submitted')) {
              // Task completed a turn — push the branch (skip when offline)
              pushBranchAfterStateChange(projectRoot, branch).catch(err => {
                const msg = err instanceof Error ? err.message : String(err);
                logger.debug(`Background push failed for ${branch}: ${msg}`);
              });
            }
          } catch (err) {
            logger.error(`detectStateChanges: failed for task ${taskId.substring(0, 8)}: ${err instanceof Error ? err.message : err}`);
          }
        }

        if (stateChanges.length > 0) {
          for (const sc of stateChanges) {
            logger.info(`Task ${sc.taskId.substring(0, 8)} state change: working → ${sc.currentStatus}`);
          }
        }
      });

      // Auto-deliver events to blocked parent tasks (auto-unblock)
      if (stateChanges.length > 0) {
        await runPhase('deliverStateChangeEvents', async () => {
          await deliverStateChangeEvents(storage, stateChanges, projectRoot);
        });
      }

      // Detect accepts and parent branch changes, deliver to blocked tasks
      await runPhase('detectAndDeliverEvents', async () => {
        await detectAndDeliverEvents(storage, projectRoot, eventState);
      });

      // Stateless catchup: check all blocked tasks for conditions that
      // require action, regardless of whether a transition was detected.
      // This is the safety net that survives daemon restarts — it checks
      // current git/task state rather than relying on in-memory diffs.
      await runPhase('runBlockedTaskCatchup', async () => {
        await runBlockedTaskCatchup(storage, projectRoot);
      });

      // §8 (final-turn design): every task parked with a standing final claim
      // and no review turn after it is owed an auto-review. Derived, durable,
      // daemon-dispatched — its round accounting lives at the settle side
      // (task-lifecycle.ts settleAutoReviewRound).
      await runPhase('runAutoReviewCatchup', async () => {
        await runAutoReviewCatchup(storage, projectRoot);
      });

      // --- Non-critical phases: network operations ---
      // These phases make network calls (git push, gh CLI) that can hang.
      // Subprocess-level timeouts (DEFAULT_SUBPROCESS_TIMEOUT_MS) kill hanging
      // processes, and phase isolation ensures failures don't cascade.
      //
      // Note: Remote sync (upstream fetch, PR comments, branch export) runs on
      // its own independent loop — see startDaemonSyncLoop(). This keeps the
      // reconcile tick fast and prevents slow network operations from blocking
      // task state detection.

      // Retry any branches that failed to push on a previous tick.
      // Moved after reconcileTasks so a hanging push can't block task detection.
      // Skip entirely when offline — no point retrying network operations.
      if (!offline) {
        await runPhase('retryFailedPushes', async () => {
          await retryFailedPushes(projectRoot);
        });
      }

      // Auto-react: check for CI failures and PR comments on blocked tasks.
      // Runs after reconciliation so newly-blocked tasks are included.
      if (!stopped) {
        await runPhase('runAutoReact', async () => {
          const config = await loadConfig(projectRoot);
          const autoReactResult = await runAutoReact(storage, projectRoot, config);

          if (autoReactResult) {
            if (autoReactResult.commentUnblocked.length > 0) {
              logger.info(`Auto-react: unblocked ${autoReactResult.commentUnblocked.length} task(s) for PR comments: ${autoReactResult.commentUnblocked.join(', ')}`);
            }
            if (autoReactResult.budgetSkipped.length > 0) {
              logger.info(`Auto-react: ${autoReactResult.budgetSkipped.length} task(s) skipped (budget exhausted): ${autoReactResult.budgetSkipped.join(', ')}`);
            }
            for (const err of autoReactResult.errors) {
              logger.error(`Auto-react error: ${err}`);
            }

            // Report budget-exhausted tasks to the status endpoint cache
            if (onBudgetUpdate && autoReactResult.budgetSkipped.length > 0) {
              onBudgetUpdate(autoReactResult.budgetSkipped);
            }
          }
        });
      }

      // Slow-lane auto-resume: retry tasks whose fast-lane circuit breaker has
      // tripped, at most one per tick, respecting daemon.auto_resume_gap_minutes.
      if (!stopped) {
        await runPhase('processAutoResumeQueue', async () => {
          const config = await loadConfig(projectRoot);
          const dataDir = join(projectRoot, config.data.path);
          const result = await processAutoResumeQueue(storage, projectRoot, config, dataDir, Date.now());
          if (result.attempted) {
            logger.debug(`Auto-resume queue: attempted task ${result.taskId} (success=${result.success}, exhausted=${result.exhausted})`);
          }
        });
      }

      // Usage pause: clear the "held" marks whose pause has lifted or whose task
      // has moved on, so `lazy show` / `lazy doctor` never report a stale wait —
      // and run the two held launches nothing else retries: a review auto-fix,
      // and a subtask start its parent's agent asked for.
      if (!stopped) {
        await runPhase('processUsagePauseHolds', async () => {
          await processUsagePauseHolds(
            projectRoot,
            storage,
            (task) => resumeHeldReviewFix(projectRoot, storage, task),
            async (task, params) => (await import('./task-launcher')).launchHeldStart(projectRoot, task.id, params),
            // A parked parent whose held subtask start has now launched gets one
            // turn saying so — budgeted and pause-held like every daemon launch.
            async (parent, message) => {
              const session = await storage.getSessionByTaskId(parent.id);
              if (!session) return false;
              return autoUnblockTask(storage, parent, session, projectRoot, message, 'child_added');
            },
          );
        });
      }
    } catch (err) {
      // This catches failures in storage init or task snapshot — phases above
      // have their own isolated error handling via runPhase.
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Daemon reconcile error: ${msg}`);
      tickError = err;
    } finally {
      const durationMs = Date.now() - reconcileStart;
      logger.debug(`Daemon reconcile tick completed in ${durationMs}ms`);
      health.tickFinished(RECONCILE_LOOP, myStartTime, tickError);
      // Only reset the flag if this tick is still the active one.
      // If a newer tick force-reset us (timeout), don't clobber its flag.
      if (reconcileStartedAt === myStartTime) {
        reconciling = false;
      }
    }
  };

  // First reconcile shortly after server start
  const initialTimeout = setTimeout(doReconcile, 1_000);

  // Subsequent reconciles on interval
  const intervalId = setInterval(doReconcile, intervalSeconds * 1_000);

  logger.debug(`Daemon reconcile loop enabled: every ${intervalSeconds}s`);

  return () => {
    stopped = true;
    clearTimeout(initialTimeout);
    clearInterval(intervalId);
  };
}

/** How often the daemon sweeps Claude session JSONLs into the conversation store. */
const CAPTURE_SWEEP_INTERVAL_MS = 60_000;
/** Fast tick when a test explicitly arms the sweep, so an e2e can observe it. */
const CAPTURE_SWEEP_TEST_INTERVAL_MS = 1_000;

/**
 * Start the live conversation capture sweep.
 *
 * The in-container builder supervisor can only capture what it sees from inside
 * its container. Every OTHER Claude session for this project is written on the
 * host — lazy's own `claude -p` one-shots (fidelity summaries on accept, `lazy
 * report`, LLM memory compaction) and any `claude` a human runs in the repo.
 * Nothing captured those, so they only ever reached the store via an explicit
 * `lazy doctor --reimport-conversations`. The daemon is the one process that
 * can see every projects dir AND owns storage, so the sweep lives here.
 *
 * Local disk work only — no network — so it runs on its own timer rather than
 * inside the reconcile tick, which must stay fast. See src/import/capture-sweep.ts
 * for how it avoids re-parsing history on every pass.
 */
function startConversationCaptureLoop(projectRoot: string): () => void {
  // Under LAZY_TEST the sweep is off by default: it would race every test that
  // seeds session JSONLs and then asserts they are still unimported (the whole
  // `doctor --reimport-conversations` suite). `LAZY_FORCE_CAPTURE_SWEEP=1` arms
  // it — and speeds it up — for the tests that DO exercise it. Test-only, same
  // family as LAZY_FORCE_PREFLIGHT / LAZY_FORCE_PROXY_GATE.
  const forcedInTest = process.env.LAZY_FORCE_CAPTURE_SWEEP === '1';
  if (process.env.LAZY_TEST === '1' && !forcedInTest) {
    logger.debug('Conversation capture loop disabled under LAZY_TEST');
    return () => {};
  }
  const intervalMs = forcedInTest ? CAPTURE_SWEEP_TEST_INTERVAL_MS : CAPTURE_SWEEP_INTERVAL_MS;

  let sweeping = false;
  let stopped = false;
  const cursor = createSweepCursor();

  const doSweep = async () => {
    if (stopped || sweeping) return;
    sweeping = true;
    try {
      const config = await loadConfig(projectRoot);
      const storage = await getOrCreateStorage();
      const result = await sweepConversations({
        lazyRoot: projectRoot,
        dataDirAbs: join(projectRoot, config.data.path),
        storage,
        cursor,
      });
      if (result.captured.length > 0) {
        logger.debug(
          `Conversation capture: saved ${result.captured.length} session(s)` +
          (result.skippedMachineOneshots > 0
            ? `; skipped ${result.skippedMachineOneshots} machine-generated one-shot(s)`
            : ''),
        );
      }
      // Never swallowed: losing conversation history silently is the bug this
      // whole path exists to prevent.
      for (const { sessionId, error } of result.errors) {
        logger.error(`Conversation capture failed for ${sessionId}: ${error.message}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Conversation capture sweep failed: ${msg}`);
    } finally {
      sweeping = false;
    }
  };

  // First sweep shortly after start, then on interval.
  const initialTimeout = setTimeout(doSweep, forcedInTest ? 200 : 3_000);
  const intervalId = setInterval(doSweep, intervalMs);
  logger.debug(`Daemon conversation capture loop enabled: every ${intervalMs / 1000}s`);

  return () => {
    stopped = true;
    clearTimeout(initialTimeout);
    clearInterval(intervalId);
  };
}

/** How often the daemon sweeps for leftover worktrees on finished tasks. */
const WORKTREE_CLEANUP_INTERVAL_MS = 15 * 60_000;
/** Fast tick under test, mirroring the capture sweep's test-speedup pattern. */
const WORKTREE_CLEANUP_TEST_INTERVAL_MS = 1_000;

/**
 * Sweep for worktrees still on disk for tasks that are already terminal
 * (complete/abandoned) and remove them.
 *
 * `accept`/`reject`/`close` all reach `cleanupWorktree`/`cleanupWorktreeAndBranch`
 * (src/task/cleanup.ts) as their last step, but several operations run BETWEEN
 * the status flip to a terminal state and that cleanup call — reparenting
 * children, regenerating parent PR/MR fidelity, revoking tokens, stopping the
 * container/process. Any of those throwing (or the daemon/CLI process being
 * killed, the machine sleeping, etc. mid-accept) leaves the task terminal
 * forever with its worktree never reclaimed — nothing revisits a terminal task.
 * `lazy doctor --clean-worktrees` already finds and fixes exactly this
 * (`findTerminalTaskWorktrees` / `cleanupWorktree`, src/doctor/findings.ts and
 * src/task/cleanup.ts); this loop is the same finder and the same cleanup,
 * run automatically so the drift stays rare instead of accumulating until a
 * human happens to run `lazy doctor`.
 *
 * Local disk + git work only — no network, no agent involvement — so it runs
 * on its own slow timer rather than inside the reconcile tick. Sizes are not
 * measured (unlike the doctor check): the loop only needs to decide what to
 * remove, not report how much space it reclaimed.
 */
function startTerminalWorktreeCleanupLoop(projectRoot: string): () => void {
  const forcedInTest = process.env.LAZY_FORCE_CAPTURE_SWEEP === '1';
  if (process.env.LAZY_TEST === '1' && !forcedInTest) {
    logger.debug('Worktree cleanup loop disabled under LAZY_TEST');
    return () => {};
  }
  const intervalMs = forcedInTest ? WORKTREE_CLEANUP_TEST_INTERVAL_MS : WORKTREE_CLEANUP_INTERVAL_MS;

  let sweeping = false;
  let stopped = false;

  const doSweep = async () => {
    if (stopped || sweeping) return;
    sweeping = true;
    try {
      const storage = await getOrCreateStorage();
      const worktrees = await findTerminalTaskWorktrees(projectRoot, storage);
      for (const w of worktrees) {
        if (stopped) break;
        // A live lock means some other process (an accept/close/reject still
        // mid-flight, or a human in `lazy shell`) is using this worktree right
        // now — skip it this tick rather than race its own cleanup step.
        if (await checkLock(w.path)) continue;
        try {
          await cleanupWorktree(w.path, projectRoot, storage, w.taskId, w.sessionId);
          logger.info(`Worktree cleanup: removed leftover worktree for finished task ${w.taskCode} (${w.path})`);
        } catch (err) {
          logger.warn(`Worktree cleanup failed for ${w.taskCode} (${w.path}): ${err instanceof Error ? err.message : err}`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.debug(`Worktree cleanup sweep failed: ${msg}`);
    } finally {
      sweeping = false;
    }
  };

  // First sweep shortly after start, then on interval.
  const initialTimeout = setTimeout(doSweep, forcedInTest ? 200 : 10_000);
  const intervalId = setInterval(doSweep, intervalMs);
  logger.debug(`Daemon worktree cleanup loop enabled: every ${intervalMs / 1000}s`);

  return () => {
    stopped = true;
    clearTimeout(initialTimeout);
    clearInterval(intervalId);
  };
}

/**
 * Start an independent sync loop that runs remote operations
 * (upstream fetch, PR comment fetching, branch export, CI checks)
 * on its own timer, decoupled from the reconcile loop.
 *
 * This prevents slow network operations (which can take 2-3 minutes
 * with many open PRs) from blocking task state detection. The reconcile
 * loop stays fast (~seconds) while sync runs at its own pace.
 */
function startDaemonSyncLoop(projectRoot: string): () => void {
  let syncing = false;
  let stopped = false;
  const health = daemonHealthRecorder(projectRoot);

  const doSync = async () => {
    if (stopped) return;
    if (syncing) {
      logger.debug('Daemon sync: skipping tick, previous sync still running');
      health.tickSkipped(REMOTE_SYNC_LOOP);
      return;
    }

    syncing = true;
    const syncStart = Date.now();
    health.tickStarted(REMOTE_SYNC_LOOP);
    let tickError: unknown;
    try {
      const config = await loadConfig(projectRoot);
      const syncInterval = config.server.sync_interval;

      // sync_interval = 0 disables sync
      if (syncInterval <= 0) return;

      // Skip sync entirely when offline — no network noise.
      if (await isOfflineMode(join(projectRoot, '.lazy'), config.remote.offline)) return;

      const driver = createDriver(config);

      // Skip if driver doesn't need remote sync (e.g., LocalDriver)
      if (!driver.needsSync) return;

      const storage = await getOrCreateStorage();
      await runSync(projectRoot, storage, debugSyncLogger);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('Sync requires a remote driver')) {
        logger.debug(`Daemon sync error: ${msg}`);
        tickError = err;
      }
    } finally {
      health.tickFinished(REMOTE_SYNC_LOOP, syncStart, tickError);
      const durationMs = Date.now() - syncStart;
      logger.debug(`Daemon sync tick completed in ${durationMs}ms`);
      syncing = false;
    }
  };

  // First sync after a short delay (give the daemon time to fully initialize)
  const initialTimeout = setTimeout(doSync, 5_000);

  // Subsequent syncs: use the configured sync_interval.
  // Default is 60s — we check config once and use that for the interval.
  // If the user changes the config, they restart the daemon anyway.
  let intervalId: ReturnType<typeof setInterval>;
  loadConfig(projectRoot).then(config => {
    const syncIntervalMs = (config.server.sync_interval || 60) * 1_000;
    health.loopStarted(REMOTE_SYNC_LOOP, syncIntervalMs);
    intervalId = setInterval(doSync, syncIntervalMs);
    logger.debug(`Daemon sync loop enabled: every ${config.server.sync_interval || 60}s`);
  }).catch(err => {
    // Deliberately a fallback, not a startup failure — and the one place in the
    // daemon where falling back to a default is right. startDaemonServer already
    // refuses to start on an unloadable lazy.toml, so by the time this fires the
    // config must have BECOME broken after the daemon came up (the user is
    // mid-edit). Killing a healthy daemon's sync loop over an in-progress edit
    // would be worse than syncing at the documented default interval. It is not
    // silent, though: warn level, with the cause, so the log says why the
    // interval isn't the configured one.
    health.loopStarted(REMOTE_SYNC_LOOP, 60_000);
    intervalId = setInterval(doSync, 60_000);
    logger.warn(`Daemon sync loop falling back to every 60s — lazy.toml no longer loads: ${err instanceof Error ? err.message : err}`);
  });

  return () => {
    stopped = true;
    clearTimeout(initialTimeout);
    if (intervalId) clearInterval(intervalId);
  };
}
