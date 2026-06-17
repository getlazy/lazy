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
 *   - On timeout / failure, surface an actionable error and print the manual
 *     `lazy builder --resume <id>` so nothing is silently lost.
 *   - Docker/podman only: host-process builders are not stopped by upgrade, so
 *     there is nothing to relaunch (callers pass canRelaunch=false there).
 */

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
  log: (msg: string) => void;
  errorOut: (msg: string) => void;
  /** Bounded wait for the upgrade to finish (default 5 min). */
  timeoutMs?: number;
  /** Poll cadence while awaiting the upgrade (default 2s). */
  pollIntervalMs?: number;
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

const DEFAULT_UPGRADE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 2000;

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

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

/** Poll until the upgrade completes or the bounded timeout elapses. */
async function waitForUpgradeComplete(opts: {
  baseline: DaemonStatus;
  daemonStatus: () => Promise<DaemonStatus>;
  timeoutMs: number;
  pollIntervalMs: number;
  sleep: (ms: number) => Promise<void>;
}): Promise<boolean> {
  const { baseline, daemonStatus, timeoutMs, pollIntervalMs, sleep } = opts;
  const maxIterations = Math.max(1, Math.ceil(timeoutMs / pollIntervalMs));
  for (let i = 0; i < maxIterations; i++) {
    if (isUpgradeComplete(baseline, await daemonStatus())) return true;
    await sleep(pollIntervalMs);
  }
  // One final check after the last sleep so the full timeout is honored.
  return isUpgradeComplete(baseline, await daemonStatus());
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
    log,
    errorOut,
    timeoutMs = DEFAULT_UPGRADE_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
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
    log('');
    log("Builder was stopped by 'lazy upgrade'. Waiting for the new version to finish building...");
    const baseline = await daemonStatus();
    const ready = await waitForUpgradeComplete({ baseline, daemonStatus, timeoutMs, pollIntervalMs, sleep });

    // Resolve which session to resume: prefer the id stamped on the intent, then
    // the child's own detection, then the id the child was actually launched with
    // (the explicit `--resume <id>` — unambiguous and known), then the newest
    // captured builder conversation. Keeping `resumeId` ahead of the global
    // newest-conversation fallback prevents resuming an unrelated session when
    // the stamp is missing.
    let resolvedId = intent.sessionId ?? result.sessionId ?? resumeId ?? null;
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
      if (!ready) {
        errorOut('');
        errorOut(`Timed out waiting for 'lazy upgrade' to finish (after ${Math.round(timeoutMs / 1000)}s).`);
      } else if (!postStorage) {
        errorOut('');
        errorOut('Could not reach storage to resume the builder after the upgrade.');
      } else {
        errorOut('');
        errorOut('Could not determine which builder session to resume after the upgrade.');
      }
      const hint = resolvedId ?? intent.sessionId ?? result.sessionId ?? null;
      if (hint) {
        errorOut(`Resume it manually once the upgrade completes:`);
        errorOut(`  lazy builder --resume ${hint}`);
      } else {
        errorOut(`Resume manually once the upgrade completes:  lazy builder --resume <id>`);
        errorOut(`  (find session ids with: lazy builder list)`);
      }
      // Suppress the normal footer — we already printed actionable guidance.
      return { exitCode: 1, sessionId: null };
    }

    // Commit to the relaunch: make sure the rebuilt image/binary is present,
    // then consume the intent (only now — earlier failures stay recoverable).
    await ensureReady();
    await postStorage.takeBuilderResumeIntent(intent.builderId);

    log(`Resuming builder session ${resolvedId.substring(0, 8)} after upgrade...`);
    resumeId = resolvedId;
    // Loop → relaunch the child with --resume into the same terminal.
  }
}
