/**
 * Builder supervised relaunch loop (host-side).
 *
 * `lazy builder` is a foreground host process that owns the human's terminal and
 * blocks on a builder child (a docker/podman container) it does not control. A
 * `lazy upgrade` stops that container mid-session to rebuild the image — which
 * unblocks the host process. Without help, the interactive session is simply
 * gone and the human has to remember to `lazy builder --resume <id>` by hand.
 *
 * This loop wraps the single child launch: when the child exits, it checks
 * Storage for a durable builder-resume-intent written by `lazy upgrade` for THIS
 * builder. If — and ONLY if — such an intent exists, it waits for the upgrade to
 * finish (the daemon restarts healthy, which implies the new image is built),
 * resolves the Claude sessionId, and re-execs the launch with `--resume <id>`
 * into the same terminal. On a bare exit/crash/quit with no intent, it does
 * exactly what the command did before: returns so the caller prints the footer
 * and exits.
 *
 * Design constraints (see docs/spikes/builder-upgrade-resume.md §3):
 *   - Loop ONLY on an explicit intent — never on a bare exit (defaults are safe).
 *   - Consume the intent ONLY after committing to a relaunch, so a wrapper crash
 *     during the wait leaves the intent discoverable for manual recovery.
 *   - The wait is UNBOUNDED. A rebuild has no honest upper bound (`--no-cache`
 *     image builds, a slow network, a human answering a prompt in the upgrade's
 *     terminal), and abandoning a live session on a timer turns a recoverable
 *     wait into a dead builder for no gain. Instead the loop reassures
 *     periodically and offers the manual resume as an OPTION, never an exit.
 *   - It still ends on a real SIGNAL rather than a timer: the intent carries the
 *     upgrade process's pid/host, so an upgrade that dies without restarting the
 *     daemon is reported as a FAILED UPGRADE — which is actionable — instead of
 *     as "timed out", which is not.
 *   - On failure, surface an actionable error and print the manual
 *     `lazy builder --resume <id>` so nothing is silently lost.
 *   - Docker/podman only: host-process builders are not stopped by upgrade, so
 *     there is nothing to relaunch (callers pass canRelaunch=false there).
 */

import { hostname } from 'os';
import type { DaemonStatus } from '../daemon/lifecycle';
import type { BuilderResumeIntent, StoredConversation } from '../storage/types';

/** Result of launching the builder child once. */
export interface BuilderLaunchResult {
  exitCode: number;
  /** Claude sessionId if the host learned it (host-process mode). Docker → null. */
  sessionId: string | null;
  /** Per-builder id used to match a resume intent. Null when relaunch is N/A. */
  builderId: string | null;
}

/** The subset of Storage the loop needs. */
export interface RelaunchStorage {
  listBuilderResumeIntents(projectRoot?: string): Promise<BuilderResumeIntent[]>;
  takeBuilderResumeIntent(builderId: string): Promise<BuilderResumeIntent | null>;
  listConversations(): Promise<StoredConversation[]>;
}

export interface RelaunchLoopDeps {
  /** sessionId to resume on the FIRST launch (from --resume), or null. */
  initialResumeId: string | null;
  /**
   * Whether this runner's builders can be stopped+relaunched across an upgrade.
   * True for docker/podman, false for host-process (nothing to relaunch).
   */
  canRelaunch: boolean;
  /** Absolute project root — scopes intents and conversation lookup. */
  projectRoot: string;
  /** Launch the builder child once with the given resume id. Blocks until exit. */
  launch: (resumeId: string | null) => Promise<BuilderLaunchResult>;
  /**
   * Obtain a Storage handle, or null if currently unavailable (e.g. daemon
   * momentarily down). Re-resolved per access so a fresh daemon token is used
   * after the upgrade restarts the daemon.
   */
  getStorage: () => Promise<RelaunchStorage | null>;
  /** Current daemon health/identity — used to detect the upgrade restart. */
  daemonStatus: () => Promise<DaemonStatus>;
  /** Ensure the (rebuilt) image/binary is present before relaunching. */
  ensureReady: () => Promise<void>;
  /**
   * Re-resolve the live proxy target against the RESTARTED daemon, immediately
   * before relaunching.
   *
   * The launch environment is not frozen-safe across an upgrade: the daemon's
   * proxy port is OS-assigned, so the new daemon serves the proxy somewhere else
   * and the address resolved when `lazy builder` started is dead. Everything
   * else the child needs is already re-resolved per launch (the credential and
   * the MCP config are fetched from the daemon at launch time, storage is
   * re-resolved per access) — the proxy address was the one value stamped once
   * and reused, which is why the relaunched builder came back unable to reach
   * the API.
   *
   * MUST throw rather than degrade when the live address cannot be resolved
   * (`ProxyUnavailableError` semantics): a builder pointed at a dead proxy is
   * worse than one that says why it did not relaunch. The loop calls this
   * BEFORE consuming the resume intent, so a failure here leaves the session
   * recoverable.
   */
  refreshProxyTarget: () => Promise<void>;
  log: (msg: string) => void;
  errorOut: (msg: string) => void;
  /** Poll cadence while awaiting the upgrade (default 2s). */
  pollIntervalMs?: number;
  /**
   * How long to wait quietly before the first reassurance line (default 5 min).
   * This is NOT a timeout — nothing is abandoned when it elapses.
   */
  reassureAfterMs?: number;
  /** Cadence of subsequent reassurance lines (default 2 min). */
  reassureIntervalMs?: number;
  /**
   * Is the `lazy upgrade` process still alive? Injectable for tests; the default
   * uses a signal-0 probe. Only consulted when the intent carries a pid stamped
   * on THIS host.
   */
  isProcessAlive?: (pid: number) => boolean;
  /** Hostname of the machine this wrapper runs on (injectable for tests). */
  currentHost?: () => string;
  /** Sleep impl (injectable for tests). */
  sleep?: (ms: number) => Promise<void>;
}

export interface RelaunchLoopResult {
  exitCode: number;
  /**
   * sessionId for the caller's "Session/Resume" footer on a normal exit, or null
   * to suppress it (e.g. after the loop already printed an actionable fallback).
   */
  sessionId: string | null;
}

const DEFAULT_REASSURE_AFTER_MS = 5 * 60 * 1000;
const DEFAULT_REASSURE_INTERVAL_MS = 2 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 2000;

/**
 * How many consecutive polls a dead upgrade pid must be observed — while the
 * upgrade still hasn't completed — before we call it failed.
 *
 * `lazy upgrade` restarts the daemon and then exits promptly, so "pid gone" and
 * "daemon healthy again" land almost simultaneously and in an order we do not
 * control (the daemon is spawned detached). Requiring the dead pid to persist
 * across a few polls, each of which re-checks completion first, keeps a normal
 * successful upgrade from ever being misreported as a crash.
 */
const UPGRADE_DEATH_CONFIRM_POLLS = 3;

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Signal-0 liveness probe: no signal delivered, just an existence/permission check. */
function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process (the answer we want). EPERM = alive but owned by
    // another user — still alive. Anything else is unexpected; treat it as
    // alive, because the safe default is to keep waiting rather than to declare
    // a healthy upgrade dead and abandon the human's session.
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Outcome of waiting for `lazy upgrade` to finish. There is no timeout case. */
export type UpgradeWaitOutcome =
  /** The daemon came back with the new version — the upgrade finished. */
  | 'complete'
  /** The upgrade process is gone and the daemon never came back — it failed. */
  | 'upgrade-died';

/** Render a duration as a human-friendly "5m" / "1h 12m". */
export function formatWaited(ms: number): string {
  const totalMinutes = Math.floor(ms / 60000);
  if (totalMinutes < 1) return `${Math.max(1, Math.round(ms / 1000))}s`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${totalMinutes}m`;
}

/** The `lazy-builder-<id>` container name for a builder short id. */
export function builderRunName(id: string): string {
  return id.startsWith('lazy-builder-') ? id : `lazy-builder-${id}`;
}

/**
 * Find the resume intent for a given builder. The intent's `builderId` may be
 * written either as the short id (`a1b2c3d4`) or as the full container run name
 * (`lazy-builder-a1b2c3d4`) depending on which side wrote it — match both so a
 * convention mismatch between `lazy upgrade` and the wrapper can never silently
 * drop a resume (the headline feature would just break with no error).
 */
export function matchIntentForBuilder(
  intents: BuilderResumeIntent[],
  builderId: string,
): BuilderResumeIntent | null {
  const runName = builderRunName(builderId);
  return intents.find(i => i.builderId === builderId || i.builderId === runName) ?? null;
}

/**
 * Has the upgrade finished restarting the daemon? `lazy upgrade` restarts the
 * daemon as its LAST step (after rebuilding the image+binary), so a daemon that
 * is healthy again with a changed identity means the whole upgrade completed —
 * and therefore the new image exists.
 *
 * `baseline` is captured the moment we detect the intent (the pre-restart
 * daemon). Completion = healthy now AND (it was down before, or its build
 * identity changed). buildTime is 'dev' from source so it won't change in dev —
 * we also compare pid and a reset uptime to catch the restart there.
 */
export function isUpgradeComplete(baseline: DaemonStatus, current: DaemonStatus): boolean {
  if (!current.running) return false;
  // Daemon was down when we started waiting → any healthy daemon is the restart.
  if (!baseline.running) return true;
  const buildTimeChanged =
    !!baseline.buildTime && !!current.buildTime && current.buildTime !== baseline.buildTime;
  const pidChanged = !!baseline.pid && !!current.pid && current.pid !== baseline.pid;
  const uptimeReset =
    typeof baseline.uptime === 'number' &&
    typeof current.uptime === 'number' &&
    current.uptime < baseline.uptime;
  return buildTimeChanged || pidChanged || uptimeReset;
}

/** Newest captured builder conversation's sessionId, or null if none. */
async function newestBuilderSessionId(storage: RelaunchStorage): Promise<string | null> {
  const convs = await storage.listConversations();
  if (convs.length === 0) return null;
  const ts = (c: StoredConversation): number => {
    const stamp = c.endedAt ?? c.startedAt;
    const parsed = stamp ? Date.parse(stamp) : NaN;
    return Number.isNaN(parsed) ? 0 : parsed;
  };
  return [...convs].sort((a, b) => ts(b) - ts(a))[0]?.sessionId ?? null;
}

/**
 * Poll until the upgrade completes, or until the upgrade process is confirmed
 * dead without having completed.
 *
 * There is deliberately NO timeout. Waiting costs nothing but patience; giving
 * up costs the human their live session, which is exactly the outcome the wait
 * exists to prevent. The only way out other than success is a real signal that
 * the upgrade will never finish.
 *
 * Elapsed time is accumulated from the poll interval rather than a wall clock so
 * the reassurance cadence is deterministic under an injected `sleep` in tests.
 */
export async function waitForUpgradeComplete(opts: {
  baseline: DaemonStatus;
  daemonStatus: () => Promise<DaemonStatus>;
  pollIntervalMs: number;
  sleep: (ms: number) => Promise<void>;
  /** Liveness of the upgrade process, or null when it cannot be determined. */
  upgradeAlive: (() => boolean) | null;
  reassureAfterMs: number;
  reassureIntervalMs: number;
  /** Called with the elapsed wait each time a reassurance line is due. */
  onReassure: (elapsedMs: number) => void;
}): Promise<UpgradeWaitOutcome> {
  const {
    baseline, daemonStatus, pollIntervalMs, sleep, upgradeAlive,
    reassureAfterMs, reassureIntervalMs, onReassure,
  } = opts;

  let elapsedMs = 0;
  let nextReassureAtMs = reassureAfterMs;
  let deadPolls = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Completion is always checked FIRST, so a successful upgrade wins every
    // race against its own process exiting.
    if (isUpgradeComplete(baseline, await daemonStatus())) return 'complete';

    if (upgradeAlive) {
      if (upgradeAlive()) {
        deadPolls = 0;
      } else if (++deadPolls >= UPGRADE_DEATH_CONFIRM_POLLS) {
        return 'upgrade-died';
      }
    }

    await sleep(pollIntervalMs);
    elapsedMs += pollIntervalMs;

    if (elapsedMs >= nextReassureAtMs) {
      onReassure(elapsedMs);
      nextReassureAtMs = elapsedMs + reassureIntervalMs;
    }
  }
}

/**
 * Run the supervised relaunch loop. Returns the exit code to use and the
 * sessionId for the caller's footer (null to suppress it).
 */
export async function runBuilderRelaunchLoop(deps: RelaunchLoopDeps): Promise<RelaunchLoopResult> {
  const {
    canRelaunch,
    projectRoot,
    launch,
    getStorage,
    daemonStatus,
    ensureReady,
    refreshProxyTarget,
    log,
    errorOut,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    reassureAfterMs = DEFAULT_REASSURE_AFTER_MS,
    reassureIntervalMs = DEFAULT_REASSURE_INTERVAL_MS,
    isProcessAlive = defaultIsProcessAlive,
    currentHost = hostname,
    sleep = defaultSleep,
  } = deps;

  let resumeId = deps.initialResumeId;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result = await launch(resumeId);

    // Host-process builders are never stopped by upgrade — nothing to relaunch.
    if (!canRelaunch || !result.builderId) {
      return { exitCode: result.exitCode, sessionId: result.sessionId };
    }

    // PEEK (don't consume): if the wrapper crashes during the wait below, the
    // intent must stay discoverable. Tolerate storage being briefly unavailable
    // — a normal quit must NOT turn into an error just because the daemon is
    // down, so a null/empty peek is treated as "no intent → ordinary exit".
    let intent: BuilderResumeIntent | null = null;
    const peekStorage = await getStorage();
    if (peekStorage) {
      try {
        const intents = await peekStorage.listBuilderResumeIntents(projectRoot);
        intent = matchIntentForBuilder(intents, result.builderId);
      } catch (err) {
        // Surface, don't swallow: an upgrade-stopped builder with an unreadable
        // store is worth a warning, but we still fall through to a normal exit.
        const msg = err instanceof Error ? err.message : String(err);
        errorOut(`Warning: could not check for a builder resume intent: ${msg}`);
      }
    }

    if (!intent) {
      // Ordinary quit/crash — today's behavior: caller prints footer and exits.
      return { exitCode: result.exitCode, sessionId: result.sessionId };
    }

    // An upgrade stopped this builder. Wait for it to finish rebuilding.
    // Best-known session id, available before the wait so the reassurance line
    // can offer a concrete manual-resume command.
    const hintId = intent.sessionId ?? result.sessionId ?? resumeId ?? null;

    // What to call the thing that stopped this builder, in copy shared by both
    // paths. Telling a human to "wait for the upgrade to complete" when no
    // upgrade ever ran sends them looking for a terminal that does not exist.
    const stopCause = intent.reason === 'daemon-restart' ? 'daemon restart' : 'upgrade';

    // WHY the builder was stopped decides whether there is anything to wait for.
    //
    // An UPGRADE writes its intent BEFORE rebuilding, so the daemon restart the
    // wait watches for is still ahead of us. A DAEMON RESTART writes its intent
    // from the daemon that has ALREADY come up, so the restart is behind us —
    // running the same wait would compare a baseline taken after the restart
    // against the very daemon that caused it and never return. Nothing to wait
    // for; go straight to relaunching against the daemon that is already there.
    let ready: boolean;
    if (intent.reason === 'daemon-restart') {
      log('');
      log("The lazy daemon restarted, which invalidated this builder's connection to its");
      log('audit proxy, so lazy stopped it rather than let every model call fail.');
      log('This session is not lost — resuming it against the new daemon.');
      ready = (await daemonStatus()).running;
      if (!ready) {
        errorOut('');
        errorOut('The daemon that stopped this builder is no longer reachable, so it was not');
        errorOut('relaunched — a new session would have no audit plane to talk to.');
      }
    } else {
      log('');
      log("Builder was stopped by 'lazy upgrade'. Waiting for the new version to finish building...");
      log('This session is not lost — it resumes here automatically when the upgrade completes.');
      const baseline = await daemonStatus();

      // Only trust a pid stamped on THIS host: with a shared store the intent may
      // have been written on a different machine, where the pid is meaningless
      // (and might even name an unrelated live process). No usable pid → the wait
      // simply never ends on its own, which is the safe default.
      const upgradeAlive =
        intent.upgradePid != null && (!intent.upgradeHost || intent.upgradeHost === currentHost())
          ? () => isProcessAlive(intent.upgradePid as number)
          : null;

      const outcome = await waitForUpgradeComplete({
        baseline,
        daemonStatus,
        pollIntervalMs,
        sleep,
        upgradeAlive,
        reassureAfterMs,
        reassureIntervalMs,
        onReassure: (elapsedMs) => {
          log('');
          log(`Still waiting for 'lazy upgrade' to finish (${formatWaited(elapsedMs)} so far). This is not stuck —`);
          log('a full rebuild can take a while. Your builder session will resume here on its own.');
          if (hintId) {
            log(`If you would rather not wait, ctrl-c and resume later with:  lazy builder --resume ${hintId}`);
          } else {
            log('If you would rather not wait, ctrl-c and resume later with:  lazy builder --resume <id>');
            log('  (find session ids with: lazy builder list)');
          }
        },
      });
      ready = outcome === 'complete';
    }

    // Resolve which session to resume: prefer the id stamped on the intent, then
    // the child's own detection, then the id the child was actually launched with
    // (the explicit `--resume <id>` — unambiguous and known), then the newest
    // captured builder conversation. Keeping `resumeId` ahead of the global
    // newest-conversation fallback prevents resuming an unrelated session when
    // the stamp is missing.
    let resolvedId = hintId;
    const postStorage = ready ? await getStorage() : null;
    if (!resolvedId && postStorage) {
      try {
        resolvedId = await newestBuilderSessionId(postStorage);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errorOut(`Warning: could not resolve the latest builder session: ${msg}`);
      }
    }

    if (!ready || !resolvedId || !postStorage) {
      // Fail hard and actionable; LEAVE the intent in place so it's discoverable
      // and the human can resume manually once the upgrade settles.
      if (!ready && intent.reason === 'daemon-restart') {
        // Already explained above (the daemon went away again) — adding the
        // upgrade copy here would blame an upgrade that never ran.
      } else if (!ready) {
        // The ONLY non-success exit from the wait: the upgrade process is gone
        // and the daemon never came back with the new version. Say that — it
        // points at a real, fixable failure (a missing credential, a failed
        // image build) — rather than blaming a timer.
        errorOut('');
        errorOut(`The 'lazy upgrade' process exited without completing the upgrade.`);
        errorOut('The daemon never came back with the new version, so this builder was not relaunched.');
        errorOut('Check the terminal you ran the upgrade in for the failure (a missing model');
        errorOut('credential and a failed image build are the usual causes), then re-run `lazy upgrade`.');
      } else if (!postStorage) {
        errorOut('');
        errorOut(`Could not reach storage to resume the builder after the ${stopCause}.`);
      } else {
        errorOut('');
        errorOut(`Could not determine which builder session to resume after the ${stopCause}.`);
      }
      const hint = resolvedId ?? hintId;
      if (hint) {
        errorOut(`Resume it manually once the daemon is healthy again:`);
        errorOut(`  lazy builder --resume ${hint}`);
      } else {
        errorOut(`Resume manually once the daemon is healthy again:  lazy builder --resume <id>`);
        errorOut(`  (find session ids with: lazy builder list)`);
      }
      // Suppress the normal footer — we already printed actionable guidance.
      return { exitCode: 1, sessionId: null };
    }

    // Re-resolve the live proxy address against the daemon that came back.
    // The wait above returned only once the NEW daemon was serving, so this is
    // the first moment the correct address exists — and the last moment before
    // the child is launched with it. Done BEFORE ensureReady (fail fast, ahead
    // of a possible image build) and before the intent is consumed, so a
    // failure leaves the session recoverable by hand.
    try {
      await refreshProxyTarget();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errorOut('');
      errorOut(`The ${stopCause} finished, but the builder was NOT relaunched: lazy could not`);
      errorOut("resolve the restarted daemon's proxy address for the new session.");
      errorOut('');
      errorOut(msg);
      errorOut('');
      errorOut('Relaunching anyway would point the builder at a dead endpoint and every');
      errorOut('model call would fail, so lazy stopped instead.');
      // resolvedId is known non-null here (the guard above returned otherwise).
      errorOut(`Resume it once the daemon is healthy:`);
      errorOut(`  lazy builder --resume ${resolvedId}`);
      return { exitCode: 1, sessionId: null };
    }

    // Commit to the relaunch: make sure the rebuilt image/binary is present,
    // then consume the intent (only now — earlier failures stay recoverable).
    await ensureReady();
    await postStorage.takeBuilderResumeIntent(intent.builderId);

    log(`Resuming builder session ${resolvedId.substring(0, 8)} after the ${stopCause}...`);
    resumeId = resolvedId;
    // Loop → relaunch the child with --resume into the same terminal.
  }
}
