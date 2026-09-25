/**
 * Builder supervisor continuity — ride through daemon restarts and upgrades.
 *
 * Interactive sessions (`lazy pair`, `lazy chat`) already supervise Claude Code on
 * the host and relaunch in place when the daemon generation changes. Builders run
 * the same pattern INSIDE the container: Claude keeps the terminal, the
 * supervisor watches /daemon/status via the mounted MCP config, and on a
 * generation change it stops Claude gracefully, refreshes launch env from the
 * new daemon, and relaunches with `--resume <id>`.
 *
 * MCP tool calls heal separately (daemon proxy reconnect + host-side credential
 * re-issue + the MCP launch wrapper selfcheck). This module handles the OTHER
 * half: model access through the audit proxy, which Claude Code never re-reads.
 */

import type { DaemonStatus } from '../daemon/lifecycle';
import { DAEMON_HEALTH_TIMEOUT_MS } from '../daemon/lifecycle';
import { watchDaemonGeneration } from '../daemon/generation';
import { fetchBuilderLaunchEnv, overlayLaunchEnv, type BuilderLaunchEnv } from './launch-env';
import { preflightAgentBinaryWithRetry } from '../supervisor/builder';
import { spawn } from '../utils/spawn';

/** Grace period after SIGTERM before we break silence on stderr (matches interactive). */
export const BUILDER_CONTINUITY_STOP_GRACE_MS = 10_000;

/** Poll cadence while Claude Code is running. */
export const BUILDER_CONTINUITY_POLL_MS = 2000;

export interface BuilderContinuityDeps {
  daemonConfigPath: string;
  projectRoot: string;
  /** Build argv for one Claude launch; resume id null on first launch only. */
  buildClaudeArgs: (resumeId: string | null) => string[];
  worktreePath: string;
  /** Env inherited from the supervisor process (container entry env). */
  baseEnv: Record<string, string | undefined>;
  log: (msg: string) => void;
  errorOut: (msg: string) => void;
  /** Read daemon status (injectable for tests). */
  readStatus?: (projectRoot: string) => Promise<DaemonStatus>;
  pollMs?: number;
  stopGraceMs?: number;
  /** Fetch launch env (injectable for tests). */
  fetchLaunchEnv?: (configPath: string) => Promise<BuilderLaunchEnv>;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Best-effort session id for the next `--resume` after a daemon restart.
   * Called after Claude exits due to a generation change, before relaunching.
   */
  resolveResumeId?: () => Promise<string | null>;
}

export interface BuilderContinuityResult {
  exitCode: number;
  /** How many in-place relaunches across daemon restarts/upgrades. */
  restarts: number;
}

async function readStatusViaConfig(
  daemonConfigPath: string,
  _projectRoot: string,
): Promise<DaemonStatus> {
  const { readDaemonMcpConfigMinimal } = await import('./launch-env');
  const cfg = await readDaemonMcpConfigMinimal(daemonConfigPath);
  const url = `${cfg.target.replace(/\/$/, '')}/daemon/status`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(DAEMON_HEALTH_TIMEOUT_MS) });
  if (!resp.ok) {
    return { running: false };
  }
  const body = await resp.json() as Record<string, unknown>;
  return {
    running: body.status === 'running' || body.running === true,
    pid: typeof body.pid === 'number' ? body.pid : undefined,
    uptime: typeof body.uptime === 'number' ? body.uptime : undefined,
    version: typeof body.version === 'string' ? body.version : undefined,
    instanceId: typeof body.instanceId === 'string' ? body.instanceId : undefined,
    buildTime: typeof body.buildTime === 'string' ? body.buildTime : undefined,
    buildSha: typeof body.codeSha === 'string' ? body.codeSha : undefined,
  };
}

function formatUpgradeNotice(before: DaemonStatus, after: DaemonStatus): string {
  const from = before.version ?? before.buildSha ?? 'previous';
  const to = after.version ?? after.buildSha ?? 'new';
  return `Daemon upgraded ${from} → ${to}; lazy tools reconnected and the session resumed.`;
}

/**
 * Run Claude Code under continuity supervision until the human ends the session
 * or an external SIGTERM arrives.
 */
export async function runBuilderWithContinuity(
  deps: BuilderContinuityDeps,
): Promise<BuilderContinuityResult> {
  const {
    daemonConfigPath,
    projectRoot,
    buildClaudeArgs,
    worktreePath,
    baseEnv,
    log,
    errorOut,
    pollMs = BUILDER_CONTINUITY_POLL_MS,
    stopGraceMs = BUILDER_CONTINUITY_STOP_GRACE_MS,
    fetchLaunchEnv = fetchBuilderLaunchEnv,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    resolveResumeId = async () => null,
  } = deps;

  const readStatus = deps.readStatus
    ?? (() => readStatusViaConfig(daemonConfigPath, projectRoot));

  let resumeId: string | null = null;
  let restarts = 0;
  let externallyStopped = false;
  let child: ReturnType<typeof spawn> | null = null;

  const onSigterm = () => {
    externallyStopped = true;
    try { child?.kill('SIGTERM'); } catch { /* already gone */ }
  };
  process.on('SIGTERM', onSigterm);

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      // Prove the MCP binary before every launch — upgrade may be rewriting the mount.
      await preflightAgentBinaryWithRetry('lazy-agent', { log });

      let launchEnv: BuilderLaunchEnv;
      try {
        launchEnv = await fetchLaunchEnv(daemonConfigPath);
      } catch (err) {
        if (restarts === 0) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        errorOut('');
        errorOut('The daemon restarted, but this builder could not refresh its launch environment.');
        errorOut(msg);
        errorOut('Exit and relaunch with: lazy builder --resume <id>');
        return { exitCode: 1, restarts };
      }

      const baseline = await readStatus(projectRoot);
      const claudeArgs = buildClaudeArgs(resumeId);
      const env = overlayLaunchEnv(baseEnv, launchEnv);

      log(`[builder] Launching Claude Code${resumeId ? ` (--resume ${resumeId.substring(0, 8)})` : ''}...`);

      let restartDetected = false;
      let stopNoticeTimer: ReturnType<typeof setTimeout> | null = null;

      child = spawn(claudeArgs, {
        cwd: worktreePath,
        stdin: 'inherit',
        stdout: 'inherit',
        stderr: 'inherit',
        timeout: 0,
        env,
      });

      const watch = watchDaemonGeneration({
        projectRoot,
        ...(baseline.running ? { baseline } : {}),
        readStatus,
        intervalMs: pollMs,
        onRestart: () => {
          restartDetected = true;
          try { child?.kill('SIGTERM'); } catch { /* ok */ }
          stopNoticeTimer = setTimeout(() => {
            errorOut('');
            errorOut('The lazy daemon restarted. Claude Code was asked to exit so this builder can');
            errorOut('resume against the new daemon — use /exit if it has not yet.');
          }, stopGraceMs);
          stopNoticeTimer.unref?.();
        },
      });

      const exitCode = await child.exited;
      watch.stop();
      if (stopNoticeTimer) clearTimeout(stopNoticeTimer);
      child = null;

      if (!restartDetected || externallyStopped) {
        return { exitCode, restarts };
      }

      restarts += 1;
      const after = await readStatus(projectRoot);
      log('');
      log('The lazy daemon restarted, which invalidated this builder\'s connection to its audit proxy.');
      if (launchEnv.lazyVersion || after.version) {
        log(formatUpgradeNotice(baseline, after));
      } else {
        log('Resuming this conversation against the new daemon...');
      }
      log('');

      resumeId = await resolveResumeId();
      if (resumeId) {
        log(`Resuming the conversation (${resumeId.substring(0, 8)}) against the new daemon...`);
        log('');
      }

      // Brief pause so daemon MCP config refresh + host re-issue can settle.
      await sleep(500);
    }
  } finally {
    process.off('SIGTERM', onSigterm);
  }
}
