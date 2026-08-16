/**
 * Keep a live builder session's daemon MCP credential valid across daemon
 * restarts — without ever loosening what that credential is.
 *
 * The gap this closes. A builder session mints one token, bound server-side to
 * `builder:<label>` and written into a file that is bind-mounted into the
 * container. Tokens normally survive a daemon restart (the registry is on
 * disk), and the daemon rewrites every mounted config with its new address when
 * it comes back — so an ordinary restart heals itself. What does NOT heal is a
 * daemon that comes back WITHOUT the record: the registry was moved by an
 * upgrade, cleared by a repair, or the label was evicted by the builder cap.
 * Then the mounted token authenticates against nothing, every lazy tool 401s
 * for the rest of the session, and the only documented remedy is to throw the
 * conversation away and relaunch.
 *
 * The fix is not to make tokens live longer. It is to have the party that OWNS
 * the session — this process, the one running `lazy builder` — notice the
 * daemon is a different instance than the one it handshook with, and ask for a
 * credential again for the SAME identity. What comes back is either the record
 * the daemon still has (a no-op rewrite) or a freshly minted token bound to
 * that one builder label. Either way:
 *
 *   - no long-lived or shared token: the credential is still per-session, still
 *     one identity, and is still revoked when this process exits;
 *   - no cross-identity reuse: re-issue asks for `{kind:'builder'}` under this
 *     session's own label, so it can never yield another session's or a task's
 *     identity;
 *   - no resurrection of a revoked credential: only a live owner asks, and the
 *     owner stops asking (and revokes) the moment the session ends. Nothing
 *     daemon-side re-mints on its own from a leftover config file.
 *
 * The daemon writes the new token into the SAME config path, in place, so the
 * running container sees it through its bind mount and the proxy's credential
 * refresh picks it up (see src/daemon/mcp-proxy.ts).
 */

import { checkDaemonHealth, type DaemonStatus } from '../daemon/lifecycle';
import { queryDaemonMcpConfig } from '../daemon/rpc-fallback';
import { logger } from '../utils/logger';

/** Default gap between daemon-identity probes. */
const DEFAULT_POLL_MS = 5_000;

export interface BuilderMcpReissueWatcher {
  /**
   * Stop probing, and resolve once any in-flight tick has settled.
   *
   * Awaiting matters: the caller revokes this session's token immediately
   * afterwards, and a re-issue still in flight could otherwise mint a fresh
   * token AFTER the revoke and leave a live credential behind a dead session.
   * Idempotent; safe to call after the daemon has gone away.
   */
  stop(): Promise<void>;
  /**
   * Run one probe now and resolve when it is done.
   * Exported for tests — production code lets the timer drive it.
   */
  tick(): Promise<void>;
}

export interface BuilderMcpReissueOptions {
  /** This builder session's MCP identity label (`builder-<ts>`). */
  name: string;
  /** Project root, for the daemon health probe. */
  projectRoot: string;
  /** Probe interval. Defaults to {@link DEFAULT_POLL_MS}. */
  pollMs?: number;
  /** Injectable for tests. Defaults to the real daemon health check. */
  status?: () => Promise<DaemonStatus>;
  /** Injectable for tests. Defaults to asking the daemon to (re)write our config. */
  reissue?: (name: string) => Promise<void>;
  /**
   * Where to report. Defaults to the log file only: this runs underneath an
   * interactive Claude Code TUI, and writing to the console would corrupt it.
   */
  log?: (message: string) => void;
}

/**
 * A string that changes exactly when the daemon we are talking to is a
 * different process than the one we last saw. pid alone is enough in practice;
 * build identity is included so an in-place replacement is caught too.
 */
function instanceKey(status: DaemonStatus): string {
  return `${status.pid ?? '?'}|${status.buildTime ?? ''}|${status.codeSha ?? ''}`;
}

/**
 * Watch for a restarted daemon and re-issue this builder's MCP credential when
 * one appears. Never throws: a failed probe or re-issue is logged and retried
 * on the next tick — a builder session must not die because housekeeping did.
 */
export function startBuilderMcpReissueWatcher(
  options: BuilderMcpReissueOptions,
): BuilderMcpReissueWatcher {
  const log = options.log ?? ((m: string) => logger.debug(m));
  const probeStatus = options.status ?? (() => checkDaemonHealth(options.projectRoot));
  const reissue = options.reissue
    // Re-issue carries the owner pid too: this watcher runs in the process that
    // owns the session, and a daemon that re-minted our record must learn who
    // owns it or the record goes back to being first in line for eviction.
    ?? (async (name: string) => { await queryDaemonMcpConfig({ name, ownerPid: process.pid }); });

  let known: string | null = null;
  let sawDown = false;
  let stopped = false;

  const runOnce = async (): Promise<void> => {
    if (stopped) return;
    {
      let status: DaemonStatus;
      try {
        status = await probeStatus();
      } catch (err) {
        // Treat an unanswerable probe exactly like a daemon that is down: it is
        // the same observation, and the next successful probe re-handshakes.
        log(`[builder-mcp] daemon status probe failed: ${err instanceof Error ? err.message : String(err)}`);
        sawDown = true;
        return;
      }

      if (!status.running) {
        sawDown = true;
        return;
      }

      const key = instanceKey(status);
      if (known === null) {
        // First observation — this is the instance that minted our credential.
        known = key;
        sawDown = false;
        return;
      }
      if (key === known && !sawDown) return;

      const reason = key === known
        ? 'the daemon was unreachable and is answering again'
        : 'a different daemon instance is answering';
      known = key;
      sawDown = false;

      try {
        await reissue(options.name);
        log(
          `[builder-mcp] ${reason} — re-issued this session's daemon MCP credential ` +
          `(${options.name}); the running builder picks it up on its next lazy tool call`,
        );
      } catch (err) {
        // Leave `known` updated: a daemon that cannot mint right now will not
        // mint on the next tick either just because we asked twice. The
        // container-side wait still covers the window, and a later restart
        // triggers a fresh attempt.
        log(
          `[builder-mcp] could not re-issue this session's daemon MCP credential ` +
          `(${options.name}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  };

  // Ticks are serialized: a slow probe across a restart must not stack
  // re-issues on top of each other, and a test that awaits tick() must never
  // silently get a dropped no-op because the constructor's handshake was still
  // in flight.
  let chain: Promise<void> = Promise.resolve();
  let inFlight = 0;
  const tick = (): Promise<void> => {
    if (stopped) return chain;
    inFlight++;
    chain = chain.then(runOnce).finally(() => { inFlight--; });
    return chain;
  };

  const timer = setInterval(() => { if (inFlight === 0) void tick(); }, options.pollMs ?? DEFAULT_POLL_MS);
  // Never hold the process open: the builder session's lifetime is the human's,
  // not this timer's.
  (timer as unknown as { unref?: () => void }).unref?.();

  // Handshake immediately so the first restart is measured against the instance
  // that actually minted our credential, not against whatever is up 5s later.
  void tick();

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await chain;
    },
    tick,
  };
}
