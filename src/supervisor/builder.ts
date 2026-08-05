/**
 * Builder supervisor — runs the builder's Claude Code session.
 *
 * Unlike the agent supervisor (which uses a command/response protocol),
 * the builder supervisor runs a single interactive Claude Code session:
 *   1. Launches Claude Code interactively (stdin/stdout/stderr inherited)
 *   2. After exit, captures the conversation from JSONL files into storage
 *   3. Signals shutdown to the host HTTP server
 *
 * MCP config (lazy MCP server entry in ~/.claude.json) is prepared by the
 * runner on the host side before launching the supervisor. In Docker mode,
 * a merged config file is mounted into the container.
 *
 * Tool execution: The MCP server runs in proxy mode — tool calls are
 * forwarded over HTTP to the host-side builder server via TCP.
 * This means the container needs no CLI, no storage access, no git.
 *
 * This module runs inside the Docker container's supervisor process,
 * NOT on the host CLI side.
 */

import { readFile } from 'fs/promises';
import { spawn } from '../utils/spawn';
import { basename } from 'path';
import { log, logError, setLogFile } from './log';

// JSONL discovery / capture for conversation capture
import { discoverProjectSessionFiles } from '../import/claude-code-logs';
import { safeArgvPrompt } from '../agent/argv-safety';
import {
  snapshotSessionFiles,
  captureNewOrModifiedConversations,
  type SessionSnapshot,
} from '../import/capture-session';

/** How often to check for JSONL changes and re-capture (ms) */
const CAPTURE_INTERVAL_MS = 30_000;

export interface BuilderSupervisorConfig {
  /** Path to the repo root (working directory for Claude Code) */
  worktreePath: string;
  /**
   * Stable per-builder identifier (the `lazy-builder-<builderId>` run name).
   * When present, the detected Claude sessionId is stamped onto a matching
   * builder-resume-intent on exit so the host relaunch loop can resume the same
   * conversation deterministically. Docker mode passes this; host-process mode
   * (which learns the sessionId directly) does not.
   */
  builderId?: string;
  /** Path to a file containing the system prompt */
  systemPromptFile: string;
  /** Path to the builder config JSON (host + port + token) — used for conversation capture */
  builderConfigPath: string;
  /** Path to the daemon MCP config JSON — routes MCP tool calls through daemon */
  daemonConfigPath?: string;
  /** Additional args to pass to Claude Code */
  claudeExtraArgs?: string[];
  /** Debug mode */
  debug?: boolean;
}

/**
 * Run the builder supervisor.
 *
 * This is the entry point called by agent-entry.ts (Docker mode) or
 * index.ts hidden command (host-process mode).
 */
export async function runBuilderSupervisor(config: BuilderSupervisorConfig): Promise<void> {
  const { createStorage } = await import('../storage');

  // Where captured conversations (and the resume-intent stamp) are persisted.
  //
  // The supervisor runs INSIDE the builder container. In daemon-proxy mode the
  // configured storage backend's path is NOT reachable there: this project's
  // external_path lives outside the repo and is never mounted, so a direct
  // FileStorage would silently write every captured conversation to the
  // container's ephemeral filesystem and lose it on `--rm` — the capture bug
  // this fixes. Route through the daemon (the single storage owner) over its
  // TCP web server instead, exactly as agent tasks do. Only the legacy,
  // pre-daemon builder-server path (no daemonConfigPath) falls back to a local
  // FileStorage.
  const storageFactory: StorageFactory = buildBuilderStorageFactory(
    config.daemonConfigPath,
    createStorage,
  );

  // Redirect log output to a file so it doesn't leak into the interactive
  // Claude session (stdout/stderr are Claude's territory during the session).
  // Use /tmp since the repo may be mounted read-only in Docker mode.
  const builderLogFile = `/tmp/lazy-builder-${Date.now()}.log`;
  setLogFile(builderLogFile);

  log('[builder] Starting builder supervisor');
  log(`[builder] Worktree: ${config.worktreePath}`);

  // Read system prompt from file
  const systemPrompt = await readFile(config.systemPromptFile, 'utf-8');
  log(`[builder] System prompt loaded (${systemPrompt.length} chars)`);

  // Preflight: prove the `lazy-agent` binary Claude Code will spawn for its MCP
  // server is the real compiled agent before handing off to the interactive
  // session. If the wrong file is mounted at /usr/local/bin/lazy-agent (bare Bun,
  // a stale build, or a placeholder), the MCP child dies on startup and the
  // builder silently loses every lazy_* tool — the operator only sees an opaque
  // "-32000" buried in Claude's logs. Failing loudly here turns that into an
  // actionable error. See the `selfcheck` sentinel in agent-entry.ts.
  await preflightAgentBinary('lazy-agent');

  // Read builder config for MCP proxy setup
  const builderConfig = JSON.parse(await readFile(config.builderConfigPath, 'utf-8'));
  log(`[builder] Builder config loaded (host: ${builderConfig.host}, port: ${builderConfig.port})`);

  // Snapshot the project's session files before launch. Any file new-or-modified
  // after this baseline belongs to this run and must be captured — there can be
  // several (Claude opens a fresh JSONL on /clear, compaction, and resume).
  const beforeSnapshot = await snapshotSessionFiles(config.worktreePath);

  // When launched with `--resume <id>`, that session is where the run STARTED —
  // Claude appends to <id>.jsonl in place until /clear, compaction, or resume
  // rolls it to a fresh segment. The resume target stamped at exit is always the
  // NEWEST owned segment, not <id>; the resume id only serves as a tiebreaker so
  // an unrelated, merely-touched session in the shared ~/.claude/projects/<proj>
  // dir can't hijack detection when no new segment rolled. See
  // pickActiveSessionFile.
  const resumeSessionId = parseResumeSessionId(config.claudeExtraArgs);
  if (resumeSessionId) {
    log(`[builder] Launched with --resume ${resumeSessionId}; anchoring capture to it`);
  }

  // Build Claude args
  const claudeArgs = [
    'claude',
    '--append-system-prompt', safeArgvPrompt(systemPrompt, 'builder system prompt'),
    ...(config.claudeExtraArgs ?? []),
  ];

  if (config.debug) {
    log(`[builder] Claude args: ${claudeArgs.join(' ')}`);
  }

  // Start background incremental capture. This is the primary safety net for
  // non-graceful exit (Ctrl-C / SIGTERM / container stop / crash): it persists
  // ALL new-or-modified session files on a timer and on signal, so a builder
  // killed before the final flush still gets its conversations saved.
  //
  // The monitor also owns the resume-intent STAMP (see onFinalSession below).
  // That is deliberate: the stamp used to live only after `await proc.exited`,
  // which a SIGTERM'd supervisor never reaches — its signal handler flushes
  // capture and re-raises. So an upgrade that stopped the container lost the
  // stamp entirely and the relaunched builder had nothing to resume. Hanging it
  // off the monitor's memoized stop() makes the graceful path and the signal
  // path converge on the SAME stamp, exactly once.
  const builderId = config.builderId;
  const monitor = startCaptureMonitor(
    config.worktreePath, beforeSnapshot, storageFactory, resumeSessionId,
    builderId
      ? (storage, sessionId) =>
          stampSessionIdOnStorage(storage, builderId, config.worktreePath, sessionId)
      : undefined,
  );

  log('[builder] Launching Claude Code interactively...');

  // Launch Claude Code with inherited stdin/stdout/stderr
  const proc = spawn(claudeArgs, {
    cwd: config.worktreePath,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
    timeout: 0, // Long-running: builder Claude Code session can run for hours
  });

  const exitCode = await proc.exited;
  log(`[builder] Claude Code exited with code ${exitCode}`);

  // Final capture. The resume-intent stamp happens inside monitor.stop() (see
  // startCaptureMonitor's onFinalSession) so the signal path stamps too.
  const detectedSessionId = await monitor.stop();
  if (detectedSessionId) {
    log(`[builder] Captured conversation: ${detectedSessionId}`);
    // Print session ID to stderr (stdout is Claude's territory)
    console.error(`\nBuilder session: ${detectedSessionId}`);
  }

  // Signal shutdown to host HTTP server (host-process mode without daemon MCP proxy)
  if (!config.daemonConfigPath) {
    try {
      const { signalShutdown } = await import('../builder/client');
      await signalShutdown(builderConfig.host, builderConfig.port, builderConfig.token);
      log('[builder] Shutdown signal sent to host');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError(`[builder] Failed to signal shutdown: ${msg}`);
    }
  } else {
    log('[builder] Using daemon MCP proxy — no shutdown signal needed');
  }

  process.exit(exitCode);
}

/**
 * Verify the `lazy-agent` binary Claude Code will spawn for the MCP server is
 * the real compiled lazy agent — not a bare Bun runtime, a stale build, or a
 * placeholder mistakenly mounted at /usr/local/bin/lazy-agent.
 *
 * The check execs `<command> selfcheck` and matches the agent's sentinel line
 * ('lazy-agent ok …'). A bare Bun binary errors "Script not found selfcheck"
 * (non-zero, no sentinel); a placeholder/text file fails to exec. Either way we
 * throw an actionable error rather than let Claude Code's MCP child fail
 * silently with -32000 once the interactive session is already underway.
 *
 * Exported for testing.
 */
export async function preflightAgentBinary(command: string): Promise<void> {
  let stdout = '';
  let exitCode: number | null = null;
  try {
    const proc = spawn([command, 'selfcheck'], { stdout: 'pipe', stderr: 'pipe' });
    const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    stdout = out;
    exitCode = proc.exitCode;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Builder preflight failed: could not exec '${command} selfcheck' (${msg}). ` +
      `The lazy-agent binary at /usr/local/bin/lazy-agent appears missing or not ` +
      `executable — Claude Code's MCP server cannot start and the builder would have ` +
      `no lazy_* tools. Rebuild/reinstall the agent binary and restart the builder.`,
    );
  }

  if (exitCode !== 0 || !stdout.includes('lazy-agent ok')) {
    const preview = stdout.trim().slice(0, 120) || '<no output>';
    throw new Error(
      `Builder preflight failed: '${command} selfcheck' did not identify the lazy ` +
      `agent (exit ${exitCode}, output: ${preview}). The binary at ` +
      `/usr/local/bin/lazy-agent is not the compiled lazy agent (likely bare Bun or a ` +
      `stale/placeholder file). Claude Code's MCP server would fail to start (-32000) ` +
      `and the builder would have no lazy_* tools. Rebuild/reinstall the agent binary ` +
      `(e.g. 'lazy upgrade') and restart the builder.`,
    );
  }

  log(`[builder] Preflight OK: ${stdout.trim()}`);
}

/**
 * Stamp the detected Claude sessionId onto an existing builder-resume-intent.
 *
 * Only updates an intent that already exists for this builderId — it never
 * creates one. An intent is written by `lazy upgrade` before it stops the
 * builder container; if there is no intent, this was a normal quit/crash and
 * there is nothing to resume, so creating a record here would make the host
 * relaunch loop fire spuriously. The intent's data dir is mounted read-write
 * into the container, so the host reads the stamped sessionId after the
 * container exits.
 *
 * Best-effort: any failure is logged and swallowed so it cannot affect the
 * builder's exit path.
 */
export async function stampSessionIdOntoResumeIntent(
  builderId: string,
  projectRoot: string,
  sessionId: string,
  storageFactory: StorageFactory,
): Promise<void> {
  let storage: import('../storage/interface').Storage | null = null;
  try {
    storage = await storageFactory(projectRoot);
    await stampSessionIdOnStorage(storage, builderId, projectRoot, sessionId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError(`[builder] Failed to stamp sessionId onto resume intent: ${msg}`);
  } finally {
    if (storage) {
      await storage.close();
    }
  }
}

/**
 * Same stamp against an ALREADY-OPEN storage handle, which it does not close.
 *
 * The capture monitor owns a live storage handle for the duration of its final
 * flush; reopening one through the factory there would close the handle the
 * monitor is still using (and close it twice). May throw — callers decide.
 */
export async function stampSessionIdOnStorage(
  storage: import('../storage/interface').Storage,
  builderId: string,
  projectRoot: string,
  sessionId: string,
): Promise<void> {
  const intents = await storage.listBuilderResumeIntents(projectRoot);
  const existing = intents.find(i => i.builderId === builderId);
  if (!existing) {
    // No upgrade-written intent — normal exit, nothing to resume.
    log(`[builder] No resume intent for ${builderId}; skipping sessionId stamp`);
    return;
  }
  if (existing.sessionId === sessionId) {
    return; // Already stamped (idempotent).
  }
  await storage.saveBuilderResumeIntent({ ...existing, sessionId });
  log(`[builder] Stamped sessionId ${sessionId} onto resume intent ${builderId}`);
}

// ---------------------------------------------------------------------------
// Conversation capture
// ---------------------------------------------------------------------------

/**
 * Build a filename→mtime map for the project's session files (async).
 *
 * This feeds {@link pickActiveSessionFile}, which decides the single live
 * session whose id is stamped onto the resume intent. Capturing conversations
 * is handled separately (and for ALL files) by the capture monitor; this map
 * exists only for resume-target detection.
 */
async function getSessionFileTimes(lazyRoot: string): Promise<Map<string, number>> {
  const files = await discoverProjectSessionFiles(lazyRoot);
  const times = new Map<string, number>();
  for (const f of files) {
    // Keyed by filename to preserve pickActiveSessionFile's contract.
    times.set(`${f.sessionId}.jsonl`, f.mtimeMs);
  }
  return times;
}

/** Convert a capture SessionSnapshot into the filename→mtime map pickActiveSessionFile expects. */
function snapshotToFileTimes(snapshot: SessionSnapshot): Map<string, number> {
  const times = new Map<string, number>();
  for (const [sessionId, info] of snapshot) {
    times.set(`${sessionId}.jsonl`, info.mtimeMs);
  }
  return times;
}

/**
 * Extract the `--resume <id>` session id from the args passed to Claude, or null
 * if the builder was started fresh.
 */
export function parseResumeSessionId(args: string[] | undefined): string | null {
  if (!args) return null;
  const i = args.indexOf('--resume');
  if (i >= 0 && i + 1 < args.length) {
    const id = args[i + 1]?.trim();
    return id ? id : null;
  }
  return null;
}

/**
 * Decide which JSONL file holds the live builder session, given the mtimes
 * before launch and after, plus the explicit `--resume` id (if any).
 *
 * The resume target is ALWAYS the newest segment owned by this run — `--resume
 * <id>` defines where the run STARTED, never what it ends as. A single run spans
 * many JSONL files: `/clear`, compaction, and resume each roll Claude to a fresh
 * `<uuid>.jsonl`. The live tail of the conversation is the newest of those.
 *
 * Pure (no fs) so the resolution order is unit-testable. Order:
 *   1. The newest file that is genuinely NEW since launch. `/clear`, compaction,
 *      and resume-rolls all write a brand-new sessionId file, as does a
 *      from-scratch session — so the newest new file is the live tail. This MUST
 *      win over the `--resume` id: after a `/clear` in a resumed run the original
 *      `<resumeId>.jsonl` still exists on disk but is dormant, and pinning to it
 *      resumes the conversation the user deliberately cleared away (the bug this
 *      fixes).
 *   2. No new file rolled: if launched with `--resume <id>` and `<id>.jsonl`
 *      exists, Claude appended to it in place and it IS the newest segment.
 *      Pinning to it here (over the merely-changed fallback below) stops an
 *      unrelated session in the shared ~/.claude/projects/<proj> dir (other
 *      builders, a plain `claude` in the repo) from hijacking detection just
 *      because it was touched more recently.
 *   3. Last resort: the newest file whose mtime merely changed (legacy
 *      heuristic) — only when there is no resume id and no new file.
 */
export function pickActiveSessionFile(
  beforeTimes: Map<string, number>,
  afterTimes: Map<string, number>,
  resumeSessionId: string | null,
): string | null {
  // 1. Prefer genuinely-new files (created after launch). These are the segments
  //    a run rolls to on /clear, compaction, resume — and the file a fresh
  //    session creates. The newest is the live tail, even across a --resume.
  let newestNew: string | null = null;
  let newestNewMtime = -1;
  for (const [file, mtime] of afterTimes) {
    if (!beforeTimes.has(file) && mtime > newestNewMtime) {
      newestNewMtime = mtime;
      newestNew = file;
    }
  }
  if (newestNew) return newestNew;

  // 2. No new segment rolled. A resumed run appended to <id>.jsonl in place —
  //    that is the newest segment. Pin to it so an unrelated, merely-touched
  //    session in the shared project dir can't hijack detection by mtime.
  if (resumeSessionId) {
    const resumedFile = `${resumeSessionId}.jsonl`;
    if (afterTimes.has(resumedFile)) return resumedFile;
  }

  // 3. Last resort: newest file whose mtime changed since launch.
  let newestChanged: string | null = null;
  let newestChangedMtime = -1;
  for (const [file, mtime] of afterTimes) {
    const beforeMtime = beforeTimes.get(file);
    if (beforeMtime !== undefined && mtime !== beforeMtime && mtime > newestChangedMtime) {
      newestChangedMtime = mtime;
      newestChanged = file;
    }
  }

  return newestChanged;
}

async function findActiveSessionFile(
  beforeTimes: Map<string, number>,
  lazyRoot: string,
  resumeSessionId: string | null,
): Promise<string | null> {
  const afterTimes = await getSessionFileTimes(lazyRoot);
  return pickActiveSessionFile(beforeTimes, afterTimes, resumeSessionId);
}

type StorageFactory = (lazyRoot: string) => Promise<import('../storage/interface').Storage>;

/**
 * Build a Storage that persists through the daemon over its TCP web server.
 *
 * The daemon MCP config (mounted into the container) carries the daemon's TCP
 * `target` (`http://host.docker.internal:<webPort>`) and bearer token. The
 * daemon exposes `/rpc/storage` on TCP, so a RemoteStorage over that target
 * writes to the real host store — the same one `lazy builder list` reads —
 * rather than to an unmounted, ephemeral in-container path. The daemon is the
 * single storage owner, so this also honors the storage-ownership invariant.
 */
export async function daemonRemoteStorage(
  daemonConfigPath: string,
): Promise<import('../storage/interface').Storage> {
  const { readDaemonMcpConfig } = await import('../daemon/mcp-proxy');
  const { DaemonClient } = await import('../daemon/client');
  const { RemoteStorage } = await import('../storage');
  const cfg = readDaemonMcpConfig(daemonConfigPath);
  // This client lives for the whole builder session — hours — so it WILL
  // outlive daemon restarts. The daemon rewrites the mounted config in place
  // when it restarts (refreshDaemonMcpConfigs), so re-reading that same trusted
  // file on a 401 lets capture keep writing instead of silently 401ing away the
  // rest of the session's conversations.
  const client = DaemonClient.fromTarget(cfg.target, cfg.token, async () => {
    const raw = await readFile(daemonConfigPath, 'utf-8');
    const fresh = JSON.parse(raw) as { token?: string; target?: string };
    return fresh.token && fresh.target ? { target: fresh.target, token: fresh.token } : null;
  });
  // getStoragePath doubles as a connectivity probe: if the daemon is
  // unreachable this throws here, surfacing the failure instead of silently
  // dropping the conversation. RemoteStorage needs the path for
  // getStoragePath()/getTaskDir(); capture itself only uses saveConversation.
  const storagePath = await client.rpc('storage', cfg.projectRoot, {
    method: 'getStoragePath',
    args: {},
  }) as string;
  return new RemoteStorage(client, cfg.projectRoot, storagePath);
}

/**
 * Choose how the supervisor persists captured conversations.
 *
 * With a daemonConfigPath (daemon-proxy mode — every containerized builder),
 * route through the daemon over TCP so writes reach the real host store. Only
 * the legacy pre-daemon builder-server path falls back to a local FileStorage
 * via `createStorage`. `createStorageFn` is injected for testability.
 */
export function buildBuilderStorageFactory(
  daemonConfigPath: string | undefined,
  createStorageFn: StorageFactory,
): StorageFactory {
  if (daemonConfigPath) {
    return () => daemonRemoteStorage(daemonConfigPath);
  }
  return createStorageFn;
}

/**
 * Background conversation capture for the builder supervisor.
 *
 * Captures EVERY session file the run touches (Claude rolls to a new JSONL on
 * /clear, compaction, and resume — single-file capture silently drops the rest)
 * and is resilient to non-graceful exit:
 *
 *   - A timer re-captures all new-or-modified files every CAPTURE_INTERVAL_MS,
 *     so a builder killed by Ctrl-C / SIGTERM / container stop / crash still has
 *     its conversations saved up to the last tick.
 *   - SIGINT/SIGTERM handlers trigger an immediate final flush before the
 *     process dies (SIGKILL and machine sleep cannot be intercepted; the timer
 *     is the safety net there).
 *   - The graceful path calls stop() after Claude exits for a final flush.
 *
 * Capture errors are surfaced (logged at error level) — never swallowed — since
 * losing builder history silently is the bug this exists to prevent.
 */
export function startCaptureMonitor(
  lazyRoot: string,
  beforeSnapshot: SessionSnapshot,
  storageFactory: StorageFactory,
  resumeSessionId: string | null,
  /**
   * Called once, during the final flush, with the detected session id and the
   * monitor's live (still-open) storage handle. The builder uses it to stamp the
   * resume intent; running here rather than after `await proc.exited` is what
   * makes the SIGTERM path stamp too (see the call site).
   */
  onFinalSession?: (
    storage: import('../storage/interface').Storage,
    sessionId: string,
  ) => Promise<void>,
): { stop: () => Promise<string | null> } {
  const beforeTimes = snapshotToFileTimes(beforeSnapshot);
  // Tracks what we've already persisted so each pass only re-saves files that
  // actually changed since last capture.
  const captured: SessionSnapshot = new Map();
  let stopped = false;
  let inFlight = false;
  let storage: import('../storage/interface').Storage | null = null;
  let lastDetectedSessionId: string | null = resumeSessionId;

  async function getStorage(): Promise<import('../storage/interface').Storage> {
    if (!storage) storage = await storageFactory(lazyRoot);
    return storage;
  }

  /** Capture all new-or-modified files once. Returns true if anything was saved. */
  async function captureOnce(): Promise<void> {
    const s = await getStorage();
    const result = await captureNewOrModifiedConversations(lazyRoot, beforeSnapshot, s, captured);
    for (const { sessionId, error } of result.errors) {
      logError(`[builder] Incremental capture failed for ${sessionId}: ${error.message}`);
    }
    if (result.captured.length > 0) {
      log(`[builder] Incremental capture: saved ${result.captured.length} session file(s)`);
    }
    // Resume target: prefer the explicit --resume id when its file still exists,
    // otherwise the newest owned session (handles /clear and compaction rolling
    // to a fresh sessionId mid-run).
    const activeFile = await findActiveSessionFile(beforeTimes, lazyRoot, resumeSessionId);
    if (activeFile) lastDetectedSessionId = basename(activeFile, '.jsonl');
    else if (result.newestSessionId) lastDetectedSessionId = result.newestSessionId;
  }

  const timer = setInterval(async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      await captureOnce();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError(`[builder] Incremental capture failed: ${msg}`);
    } finally {
      inFlight = false;
    }
  }, CAPTURE_INTERVAL_MS);

  // Non-graceful exit safety net: flush on signal, then re-raise so the process
  // exits with the conventional code. Without this, Ctrl-C / docker stop would
  // skip the final capture and rely solely on the (up-to-30s-stale) timer.
  let signalHandled = false;
  const onSignal = (signal: NodeJS.Signals) => {
    if (signalHandled) return;
    signalHandled = true;
    // Best-effort synchronous-ish flush. We can't await in a signal handler and
    // block exit indefinitely, so kick off the flush and let it complete; the
    // process is being torn down, so close storage when done.
    void (async () => {
      try {
        await stopInternal();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logError(`[builder] Signal-triggered capture failed: ${msg}`);
      } finally {
        process.removeListener('SIGINT', onSignal);
        process.removeListener('SIGTERM', onSignal);
        process.kill(process.pid, signal);
      }
    })();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  // Memoized so a graceful stop() and a signal-triggered flush converge on the
  // SAME completion — the signal handler awaits this before re-raising, so it
  // can never kill the process mid-flush.
  let stopPromise: Promise<string | null> | null = null;
  async function doStop(): Promise<string | null> {
    stopped = true;
    clearInterval(timer);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);

    try {
      await captureOnce();
      log('[builder] Final conversation capture completed');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError(`[builder] Final capture failed: ${msg}`);
    }

    // Resume-intent stamp. Deliberately OUTSIDE the capture try/catch and its own
    // failure domain: a failed capture must not skip the stamp (the id comes from
    // the filesystem scan, not from the save), and a failed stamp must not look
    // like a capture failure. Both must run before storage closes below.
    if (onFinalSession && lastDetectedSessionId) {
      try {
        await onFinalSession(await getStorage(), lastDetectedSessionId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logError(`[builder] Failed to stamp sessionId onto resume intent: ${msg}`);
      }
    }

    if (storage) {
      try {
        await storage.close();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logError(`[builder] Failed to close storage after final capture: ${msg}`);
      }
      storage = null;
    }
    return lastDetectedSessionId;
  }
  function stopInternal(): Promise<string | null> {
    if (!stopPromise) stopPromise = doStop();
    return stopPromise;
  }

  return { stop: stopInternal };
}
