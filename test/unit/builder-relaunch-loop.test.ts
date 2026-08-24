/**
 * Unit tests: builder supervised relaunch loop.
 *
 * The loop wraps the builder child launch and, on an upgrade-induced exit (an
 * explicit resume intent in Storage), waits for the upgrade to finish and
 * re-launches --resume into the same terminal. See
 * docs/spikes/builder-upgrade-resume.md §3 and src/builder/relaunch.ts.
 *
 * These tests drive the loop with a fake launch + fake storage + scripted daemon
 * health so the docker-only control flow is exercised without Docker.
 */

import { describe, test, expect } from 'bun:test';
import {
  runBuilderRelaunchLoop,
  matchIntentForBuilder,
  isUpgradeComplete,
  builderRunName,
  formatWaited,
  type RelaunchStorage,
  type BuilderLaunchResult,
} from '../../src/builder/relaunch';
import type { BuilderResumeIntent, StoredConversation } from '../../src/storage/types';
import type { DaemonStatus } from '../../src/daemon/lifecycle';

/** In-memory RelaunchStorage backed by a Map, mirroring FileStorage semantics. */
function fakeStorage(initial: BuilderResumeIntent[] = [], conversations: StoredConversation[] = []): RelaunchStorage & { intents: Map<string, BuilderResumeIntent> } {
  const intents = new Map<string, BuilderResumeIntent>(initial.map(i => [i.builderId, i]));
  return {
    intents,
    async listBuilderResumeIntents(projectRoot?: string) {
      const all = [...intents.values()];
      return projectRoot ? all.filter(i => i.projectRoot === projectRoot) : all;
    },
    async takeBuilderResumeIntent(builderId: string) {
      const found = intents.get(builderId) ?? null;
      if (found) intents.delete(builderId);
      return found;
    },
    async listConversations() {
      return conversations;
    },
  };
}

const conv = (sessionId: string, endedAt: string | null): StoredConversation => ({
  sessionId,
  projectPath: 'p',
  cwd: null,
  version: null,
  gitBranch: null,
  startedAt: endedAt,
  endedAt,
  importedAt: 0,
  messages: [],
  stats: { userMessageCount: 0, assistantMessageCount: 0 },
} as unknown as StoredConversation);

const intent = (overrides: Partial<BuilderResumeIntent> = {}): BuilderResumeIntent => ({
  builderId: 'abcd1234',
  projectRoot: '/proj',
  sessionId: 'sess-resume',
  createdAt: '2026-05-31T00:00:00.000Z',
  ...overrides,
});

const noopSleep = async () => {};

/** Base deps with sane no-op defaults; tests override what they exercise. */
function baseDeps(over: Partial<Parameters<typeof runBuilderRelaunchLoop>[0]>) {
  return {
    initialResumeId: null,
    canRelaunch: true,
    projectRoot: '/proj',
    launch: async (): Promise<BuilderLaunchResult> => ({ exitCode: 0, sessionId: null, builderId: 'abcd1234' }),
    getStorage: async () => fakeStorage(),
    daemonStatus: async (): Promise<DaemonStatus> => ({ running: true, pid: 1, buildTime: 'b1', uptime: 100 }),
    ensureReady: async () => {},
    refreshProxyTarget: async () => {},
    log: () => {},
    errorOut: () => {},
    pollIntervalMs: 10,
    reassureAfterMs: 100,
    reassureIntervalMs: 50,
    // Default: no upgrade pid on the intent → liveness unknown → wait forever.
    // Tests that exercise the death path stamp a pid and script this.
    isProcessAlive: () => true,
    currentHost: () => 'test-host',
    sleep: noopSleep,
    ...over,
  };
}

describe('matchIntentForBuilder', () => {
  test('matches by short id', () => {
    const i = intent({ builderId: 'abcd1234' });
    expect(matchIntentForBuilder([i], 'abcd1234')).toBe(i);
  });

  // The intent's builderId may be written as the full run name by the upgrade
  // side; the wrapper holds the short id. Match both so a convention mismatch
  // can never silently drop a resume.
  test('matches when the intent is keyed by the full run name', () => {
    const i = intent({ builderId: 'lazy-builder-abcd1234' });
    expect(matchIntentForBuilder([i], 'abcd1234')).toBe(i);
  });

  test('returns null when no intent matches this builder', () => {
    expect(matchIntentForBuilder([intent({ builderId: 'other' })], 'abcd1234')).toBeNull();
  });

  test('builderRunName is idempotent', () => {
    expect(builderRunName('abcd1234')).toBe('lazy-builder-abcd1234');
    expect(builderRunName('lazy-builder-abcd1234')).toBe('lazy-builder-abcd1234');
  });
});

describe('isUpgradeComplete', () => {
  test('not complete while the daemon is down', () => {
    expect(isUpgradeComplete({ running: true, pid: 1 }, { running: false })).toBe(false);
  });

  test('complete when a previously-down daemon is healthy again', () => {
    expect(isUpgradeComplete({ running: false }, { running: true, pid: 9 })).toBe(true);
  });

  test('complete when buildTime changes (rebuilt + restarted)', () => {
    expect(isUpgradeComplete(
      { running: true, pid: 1, buildTime: 'old' },
      { running: true, pid: 1, buildTime: 'new' },
    )).toBe(true);
  });

  // In dev, buildTime is 'dev' and never changes — the pid change must still
  // detect the restart.
  test('complete on pid change when buildTime is unchanged (dev)', () => {
    expect(isUpgradeComplete(
      { running: true, pid: 1, buildTime: 'dev' },
      { running: true, pid: 2, buildTime: 'dev' },
    )).toBe(true);
  });

  test('not complete when the same daemon is still serving', () => {
    expect(isUpgradeComplete(
      { running: true, pid: 1, buildTime: 'b', uptime: 100 },
      { running: true, pid: 1, buildTime: 'b', uptime: 110 },
    )).toBe(false);
  });

  test('complete when uptime resets (restart without identity fields)', () => {
    expect(isUpgradeComplete(
      { running: true, uptime: 5000 },
      { running: true, uptime: 3 },
    )).toBe(true);
  });
});

describe('formatWaited', () => {
  test('renders sub-minute waits in seconds', () => {
    expect(formatWaited(30_000)).toBe('30s');
  });

  test('renders minutes', () => {
    expect(formatWaited(5 * 60_000)).toBe('5m');
  });

  test('renders hours and minutes for very long rebuilds', () => {
    expect(formatWaited(72 * 60_000)).toBe('1h 12m');
  });
});

describe('runBuilderRelaunchLoop', () => {
  // INVARIANT: with no resume intent, the loop runs the child exactly once and
  // returns its exit code + sessionId for the footer — today's behavior. The
  // loop must NEVER relaunch on a bare exit/quit/crash (defaults are safe).
  test('no intent → single launch, returns exit code and sessionId for footer', async () => {
    let launches = 0;
    const result = await runBuilderRelaunchLoop(baseDeps({
      launch: async () => { launches++; return { exitCode: 3, sessionId: 'sid', builderId: 'abcd1234' }; },
      getStorage: async () => fakeStorage([]),
    }));
    expect(launches).toBe(1);
    expect(result).toEqual({ exitCode: 3, sessionId: 'sid' });
  });

  // INVARIANT: host-process mode never relaunches — builderId is null there and
  // upgrade does not stop host builders (spike §4). Even canRelaunch=false short
  // circuits before touching storage.
  test('host-process mode (canRelaunch=false) runs once and never checks storage', async () => {
    let storageChecked = false;
    let launches = 0;
    const result = await runBuilderRelaunchLoop(baseDeps({
      canRelaunch: false,
      launch: async () => { launches++; return { exitCode: 0, sessionId: 'hsid', builderId: null }; },
      getStorage: async () => { storageChecked = true; return fakeStorage([]); },
    }));
    expect(launches).toBe(1);
    expect(storageChecked).toBe(false);
    expect(result).toEqual({ exitCode: 0, sessionId: 'hsid' });
  });

  // The headline behavior: an intent triggers exactly one relaunch with the
  // resolved --resume id, then a clean exit, and the intent is consumed.
  test('intent → relaunches with --resume id, consumes intent, then exits', async () => {
    const storage = fakeStorage([intent({ sessionId: 'sess-resume' })]);
    const resumeIds: (string | null)[] = [];
    let call = 0;
    const result = await runBuilderRelaunchLoop(baseDeps({
      getStorage: async () => storage,
      launch: async (rid) => {
        resumeIds.push(rid);
        call++;
        // First exit looks like an upgrade stop; the relaunched child quits clean.
        if (call === 1) return { exitCode: 137, sessionId: null, builderId: 'abcd1234' };
        return { exitCode: 0, sessionId: 'sess-resume', builderId: 'abcd1234' };
      },
      // Simulate the daemon restarting: baseline pid 1 → healthy pid 2.
      daemonStatus: (() => {
        let n = 0;
        return async () => (n++ === 0
          ? { running: true, pid: 1, buildTime: 'dev' }
          : { running: true, pid: 2, buildTime: 'dev' });
      })(),
    }));
    expect(resumeIds).toEqual([null, 'sess-resume']);
    expect(result).toEqual({ exitCode: 0, sessionId: 'sess-resume' });
    // Intent consumed exactly once.
    expect(storage.intents.size).toBe(0);
  });

  // INVARIANT: the wait for an upgrade is UNBOUNDED. It previously gave up after
  // 300s and killed the session ("Timed out waiting... Resume it manually"), which
  // turned a slow-but-fine rebuild into a dead builder for no gain. A rebuild has
  // no honest upper bound, so the loop must keep waiting and reassure instead.
  // This drives the wait far past the old 5-minute budget and asserts it still
  // relaunches.
  test('waits well past the old 300s timeout and still relaunches', async () => {
    const storage = fakeStorage([intent({ sessionId: 'sess-resume' })]);
    const resumeIds: (string | null)[] = [];
    let polls = 0;
    // 10s poll interval × 200 polls = ~33 minutes of simulated waiting.
    const POLLS_BEFORE_RESTART = 200;
    let call = 0;
    const result = await runBuilderRelaunchLoop(baseDeps({
      getStorage: async () => storage,
      pollIntervalMs: 10_000,
      reassureAfterMs: 5 * 60_000,
      reassureIntervalMs: 2 * 60_000,
      launch: async (rid) => {
        resumeIds.push(rid);
        return ++call === 1
          ? { exitCode: 137, sessionId: null, builderId: 'abcd1234' }
          : { exitCode: 0, sessionId: 'sess-resume', builderId: 'abcd1234' };
      },
      daemonStatus: async () => (polls++ < POLLS_BEFORE_RESTART
        ? { running: true, pid: 1, buildTime: 'dev' }
        : { running: true, pid: 2, buildTime: 'dev' }),
    }));
    expect(resumeIds).toEqual([null, 'sess-resume']);
    expect(result).toEqual({ exitCode: 0, sessionId: 'sess-resume' });
    expect(storage.intents.size).toBe(0);
    expect(polls).toBeGreaterThan(POLLS_BEFORE_RESTART);
  });

  // The reassurance line is the replacement for the timeout: it must appear
  // periodically, name the manual resume as an OPTION, and never end the wait.
  test('prints periodic reassurance while waiting, offering (not forcing) manual resume', async () => {
    const storage = fakeStorage([intent({ sessionId: 'sess-resume' })]);
    const logs: string[] = [];
    let polls = 0;
    let call = 0;
    await runBuilderRelaunchLoop(baseDeps({
      getStorage: async () => storage,
      pollIntervalMs: 10_000,
      reassureAfterMs: 5 * 60_000,   // first line after 5 simulated minutes
      reassureIntervalMs: 2 * 60_000, // then every 2
      log: (m) => logs.push(m),
      launch: async () => (++call === 1
        ? { exitCode: 137, sessionId: null, builderId: 'abcd1234' }
        : { exitCode: 0, sessionId: 'sess-resume', builderId: 'abcd1234' }),
      // Restart after ~11 simulated minutes → 1 line at 5m, then 7m, 9m, 11m.
      daemonStatus: async () => (polls++ < 66
        ? { running: true, pid: 1, buildTime: 'dev' }
        : { running: true, pid: 2, buildTime: 'dev' }),
    }));
    const reassurances = logs.filter(l => l.includes('Still waiting'));
    expect(reassurances.length).toBeGreaterThanOrEqual(3);
    expect(reassurances[0]).toContain('5m');
    const all = logs.join('\n');
    expect(all).toContain('This is not stuck');
    expect(all).toContain('lazy builder --resume sess-resume');
    // Reassurance is NOT an exit: the loop went on to relaunch.
    expect(call).toBe(2);
  });

  // INVARIANT: the intent is consumed ONLY after committing to the relaunch.
  // The one non-success exit is a DETECTABLY DEAD upgrade — the process that
  // stopped this builder is gone and the daemon never came back with the new
  // version. That is a real failure (missing credential, failed image build),
  // so the loop reports THAT and leaves the intent in place for recovery.
  test('upgrade process dies without completing → actionable failure, intent preserved', async () => {
    const storage = fakeStorage([intent({ sessionId: 'sess-resume', upgradePid: 4242, upgradeHost: 'test-host' })]);
    const errors: string[] = [];
    let launches = 0;
    const result = await runBuilderRelaunchLoop(baseDeps({
      getStorage: async () => storage,
      launch: async () => { launches++; return { exitCode: 137, sessionId: null, builderId: 'abcd1234' }; },
      daemonStatus: async () => ({ running: true, pid: 1, buildTime: 'dev' }),
      isProcessAlive: () => false,
      errorOut: (m) => errors.push(m),
    }));
    expect(launches).toBe(1); // never relaunched
    expect(result.exitCode).toBe(1);
    expect(result.sessionId).toBeNull(); // footer suppressed
    expect(storage.intents.size).toBe(1); // preserved for manual recovery
    const text = errors.join('\n');
    expect(text).toContain('exited without completing the upgrade');
    // Never blames a timer — that was the misleading old message.
    expect(text).not.toContain('Timed out');
    expect(text).toContain('lazy builder --resume sess-resume');
  });

  // Race guard: `lazy upgrade` restarts the daemon and then exits, so "pid gone"
  // and "daemon back" land nearly together in an order we don't control. A
  // successful upgrade must NEVER be misreported as a dead one.
  test('dead pid does not defeat a completing upgrade (completion is checked first)', async () => {
    const storage = fakeStorage([intent({ sessionId: 'sess-resume', upgradePid: 4242, upgradeHost: 'test-host' })]);
    let polls = 0;
    let call = 0;
    const errors: string[] = [];
    const result = await runBuilderRelaunchLoop(baseDeps({
      getStorage: async () => storage,
      isProcessAlive: () => false, // upgrade already exited
      errorOut: (m) => errors.push(m),
      launch: async () => (++call === 1
        ? { exitCode: 137, sessionId: null, builderId: 'abcd1234' }
        : { exitCode: 0, sessionId: 'sess-resume', builderId: 'abcd1234' }),
      // baseline + one stale read, then the restarted daemon.
      daemonStatus: async () => (polls++ < 2
        ? { running: true, pid: 1, buildTime: 'dev' }
        : { running: true, pid: 2, buildTime: 'dev' }),
    }));
    expect(result).toEqual({ exitCode: 0, sessionId: 'sess-resume' });
    expect(errors).toEqual([]);
  });

  // A pid stamped on ANOTHER machine (shared/remote store) means nothing here —
  // it must be ignored rather than used to declare the upgrade dead.
  test('ignores an upgrade pid stamped on a different host', async () => {
    const storage = fakeStorage([intent({ sessionId: 'sess-resume', upgradePid: 4242, upgradeHost: 'other-host' })]);
    let polls = 0;
    let call = 0;
    let aliveChecked = false;
    const result = await runBuilderRelaunchLoop(baseDeps({
      getStorage: async () => storage,
      currentHost: () => 'test-host',
      isProcessAlive: () => { aliveChecked = true; return false; },
      launch: async () => (++call === 1
        ? { exitCode: 137, sessionId: null, builderId: 'abcd1234' }
        : { exitCode: 0, sessionId: 'sess-resume', builderId: 'abcd1234' }),
      daemonStatus: async () => (polls++ < 20
        ? { running: true, pid: 1, buildTime: 'dev' }
        : { running: true, pid: 2, buildTime: 'dev' }),
    }));
    expect(aliveChecked).toBe(false); // never probed a foreign-host pid
    expect(result).toEqual({ exitCode: 0, sessionId: 'sess-resume' });
  });

  // An intent written by an older lazy carries no pid. Liveness is then unknown,
  // and the safe default is to keep waiting — never to give up on a timer.
  test('intent without an upgrade pid keeps waiting instead of failing', async () => {
    const storage = fakeStorage([intent({ sessionId: 'sess-resume' })]);
    let polls = 0;
    let call = 0;
    const result = await runBuilderRelaunchLoop(baseDeps({
      getStorage: async () => storage,
      isProcessAlive: () => false, // would end the wait IF a pid were stamped
      launch: async () => (++call === 1
        ? { exitCode: 137, sessionId: null, builderId: 'abcd1234' }
        : { exitCode: 0, sessionId: 'sess-resume', builderId: 'abcd1234' }),
      daemonStatus: async () => (polls++ < 50
        ? { running: true, pid: 1, buildTime: 'dev' }
        : { running: true, pid: 2, buildTime: 'dev' }),
    }));
    expect(result).toEqual({ exitCode: 0, sessionId: 'sess-resume' });
    expect(polls).toBeGreaterThan(50);
  });

  // sessionId resolution falls back to the newest captured conversation when the
  // intent carries no sessionId and the child didn't report one (docker mode).
  test('resolves sessionId from newest conversation when intent has none', async () => {
    const storage = fakeStorage(
      [intent({ sessionId: undefined })],
      [conv('older', '2026-05-30T10:00:00.000Z'), conv('newest', '2026-05-31T10:00:00.000Z')],
    );
    const resumeIds: (string | null)[] = [];
    let call = 0;
    await runBuilderRelaunchLoop(baseDeps({
      getStorage: async () => storage,
      launch: async (rid) => {
        resumeIds.push(rid);
        return ++call === 1
          ? { exitCode: 137, sessionId: null, builderId: 'abcd1234' }
          : { exitCode: 0, sessionId: 'newest', builderId: 'abcd1234' };
      },
      daemonStatus: (() => {
        let n = 0;
        return async () => (n++ === 0
          ? { running: true, pid: 1 }
          : { running: true, pid: 2 });
      })(),
    }));
    expect(resumeIds).toEqual([null, 'newest']);
  });

  // REGRESSION: a builder launched with `--resume X` must relaunch X after an
  // upgrade — NOT some unrelated "newest" conversation. When the intent carries
  // no stamped sessionId and the child reported none (docker), the explicit
  // launch id is the authoritative source and must win over the global
  // newest-conversation fallback. Previously the loop ignored it and could
  // resume a 100%-wrong session.
  test('resolves to the explicit --resume id over newest conversation when intent has none', async () => {
    const storage = fakeStorage(
      [intent({ sessionId: undefined })],
      // A newer, unrelated conversation exists in the store — must NOT be chosen.
      [conv('unrelated-newest', '2026-05-31T23:00:00.000Z')],
    );
    const resumeIds: (string | null)[] = [];
    let call = 0;
    await runBuilderRelaunchLoop(baseDeps({
      initialResumeId: 'explicitly-resumed',
      getStorage: async () => storage,
      launch: async (rid) => {
        resumeIds.push(rid);
        return ++call === 1
          ? { exitCode: 137, sessionId: null, builderId: 'abcd1234' }
          : { exitCode: 0, sessionId: 'explicitly-resumed', builderId: 'abcd1234' };
      },
      daemonStatus: (() => {
        let n = 0;
        return async () => (n++ === 0
          ? { running: true, pid: 1 }
          : { running: true, pid: 2 });
      })(),
    }));
    expect(resumeIds).toEqual(['explicitly-resumed', 'explicitly-resumed']);
  });

  // REGRESSION (fix-upgrade-relaunch-resume): the KILLED-builder path. When the
  // container is SIGKILL'd, the in-container supervisor never runs its exit path,
  // so the intent carries NO stamped sessionId. The host now recovers the id
  // itself from the session JSONLs in the bind-mounted projects dir
  // (src/builder/session-detect.ts) and reports it as the launch's sessionId —
  // which the loop must prefer over the newest-conversation fallback, exactly as
  // it prefers an explicit --resume id.
  test('host-detected sessionId wins when the killed builder stamped nothing', async () => {
    const storage = fakeStorage(
      [intent({ sessionId: undefined })],
      // A newer conversation from an unrelated session — the fallback would have
      // resumed THIS, which is the bug ("relaunch does not resume").
      [conv('unrelated-newest', '2026-05-31T23:00:00.000Z')],
    );
    const resumeIds: (string | null)[] = [];
    let call = 0;
    await runBuilderRelaunchLoop(baseDeps({
      getStorage: async () => storage,
      launch: async (rid) => {
        resumeIds.push(rid);
        return ++call === 1
          // Killed by `docker kill` (137) — but the host detected the session it
          // was running from the JSONL mtimes.
          ? { exitCode: 137, sessionId: 'host-detected', builderId: 'abcd1234' }
          : { exitCode: 0, sessionId: 'host-detected', builderId: 'abcd1234' };
      },
      daemonStatus: (() => {
        let n = 0;
        return async () => (n++ === 0
          ? { running: true, pid: 1 }
          : { running: true, pid: 2 });
      })(),
    }));
    expect(resumeIds).toEqual([null, 'host-detected']);
  });

  // A storage hiccup during the peek must NOT turn a normal quit into an error:
  // a null storage handle is treated as "no intent" and the loop exits cleanly.
  test('null storage on peek → treated as no intent, clean single exit', async () => {
    let launches = 0;
    const result = await runBuilderRelaunchLoop(baseDeps({
      getStorage: async () => null,
      launch: async () => { launches++; return { exitCode: 0, sessionId: 'sid', builderId: 'abcd1234' }; },
    }));
    expect(launches).toBe(1);
    expect(result).toEqual({ exitCode: 0, sessionId: 'sid' });
  });

  /**
   * INVARIANT (upgrade → relaunch → proxy env): the relaunched builder must
   * resolve the proxy target AT RELAUNCH TIME, against the daemon that came
   * back — not reuse the one resolved when `lazy builder` started.
   *
   * The daemon's proxy port is OS-assigned, so a restart moves it. The runner
   * stamped the pre-upgrade address at createRunner time and nothing downstream
   * re-resolves it (an already-set proxyUrl is treated as authoritative), so
   * without this call the relaunched builder points ANTHROPIC_BASE_URL at a dead
   * port and every model call fails until the human relaunches by hand.
   *
   * Ordering is part of the invariant: the refresh happens AFTER the upgrade is
   * complete (so the new daemon is serving and the address is the live one) and
   * BEFORE the child is launched with it.
   */
  test('re-resolves the live proxy target before each post-upgrade relaunch', async () => {
    const events: string[] = [];
    let launches = 0;
    await runBuilderRelaunchLoop(baseDeps({
      launch: async () => {
        events.push('launch');
        return launches++ === 0
          ? { exitCode: 0, sessionId: null, builderId: 'abcd1234' }
          : { exitCode: 0, sessionId: 'sid2', builderId: 'other' };
      },
      refreshProxyTarget: async () => { events.push('refresh-proxy'); },
      ensureReady: async () => { events.push('ensure-ready'); },
      getStorage: async () => fakeStorage([intent()]),
      daemonStatus: (() => {
        let n = 0;
        return async () => (n++ === 0 ? { running: true, pid: 1 } : { running: true, pid: 2 });
      })(),
    }));
    // The first launch is the pre-upgrade child (its target was resolved by
    // createRunner); every relaunch is preceded by a fresh resolve.
    expect(events).toEqual(['launch', 'refresh-proxy', 'ensure-ready', 'launch']);
  });

  /**
   * INVARIANT: an unresolvable proxy at relaunch FAILS the relaunch — it never
   * relaunches with the stale address (dead endpoint) and never drops the proxy
   * (unaudited direct connection). The intent is left in place so the session
   * stays recoverable by hand, and the guidance says so.
   */
  test('proxy refresh failure → no relaunch, intent preserved, actionable error', async () => {
    const errors: string[] = [];
    let launches = 0;
    const storage = fakeStorage([intent()]);
    const result = await runBuilderRelaunchLoop(baseDeps({
      launch: async () => { launches++; return { exitCode: 0, sessionId: null, builderId: 'abcd1234' }; },
      refreshProxyTarget: async () => { throw new Error('lazy could not resolve the live proxy address.'); },
      ensureReady: async () => { throw new Error('ensureReady must not run after a failed proxy refresh'); },
      getStorage: async () => storage,
      errorOut: (m) => errors.push(m),
      daemonStatus: (() => {
        let n = 0;
        return async () => (n++ === 0 ? { running: true, pid: 1 } : { running: true, pid: 2 });
      })(),
    }));
    expect(launches).toBe(1);
    expect(result).toEqual({ exitCode: 1, sessionId: null });
    // Intent NOT consumed — the human can still resume manually.
    expect(storage.intents.has('abcd1234')).toBe(true);
    const text = errors.join('\n');
    expect(text).toContain('could not');
    expect(text).toContain('lazy could not resolve the live proxy address');
    expect(text).toContain('lazy builder --resume sess-resume');
  });

  // A normal quit must never touch the proxy: there is no relaunch to prepare.
  test('no intent → the proxy target is never re-resolved', async () => {
    let refreshes = 0;
    await runBuilderRelaunchLoop(baseDeps({
      refreshProxyTarget: async () => { refreshes++; },
      getStorage: async () => fakeStorage([]),
    }));
    expect(refreshes).toBe(0);
  });
});

/**
 * A resume intent written by a DAEMON RESTART, not by `lazy upgrade`.
 *
 * The two look identical to the wrapper apart from `reason`, and the difference
 * is load-bearing: upgrade writes its intent BEFORE restarting the daemon, so
 * there is a restart still to wait for; a daemon restart writes it FROM the
 * daemon that has already come up, so there is nothing left to wait for. Running
 * the upgrade wait on a daemon-restart intent compares a baseline taken after
 * the restart against the very daemon that caused it, and never returns.
 */
describe('runBuilderRelaunchLoop — daemon-restart intent', () => {
  test('relaunches immediately without waiting for a daemon restart', async () => {
    const storage = fakeStorage([intent({ reason: 'daemon-restart', sessionId: 'sess-dr' })]);
    const resumeIds: (string | null)[] = [];
    let statusCalls = 0;
    let call = 0;
    const result = await runBuilderRelaunchLoop(baseDeps({
      getStorage: async () => storage,
      // Same healthy daemon on every poll: an upgrade-style wait would spin here
      // forever, so finishing at all proves the wait was skipped.
      daemonStatus: async (): Promise<DaemonStatus> => {
        statusCalls++;
        return { running: true, pid: 1, buildTime: 'b1', uptime: 100, instanceId: 'gen-2' };
      },
      launch: async (rid) => {
        resumeIds.push(rid);
        call++;
        return { exitCode: 0, sessionId: null, builderId: 'abcd1234' };
      },
    }));
    expect(call).toBe(2);
    expect(resumeIds).toEqual([null, 'sess-dr']);
    expect(storage.intents.size).toBe(0);
    // One readiness probe, not a poll loop.
    expect(statusCalls).toBe(1);
    expect(result.exitCode).toBe(0);
  });

  // The daemon that stopped the builder is gone again: relaunching would point
  // the child at nothing. Fail with the resume command, and LEAVE the intent so
  // the session stays recoverable.
  test('daemon unreachable → does not relaunch, keeps the intent, prints manual resume', async () => {
    const storage = fakeStorage([intent({ reason: 'daemon-restart', sessionId: 'sess-dr' })]);
    const errors: string[] = [];
    let call = 0;
    const result = await runBuilderRelaunchLoop(baseDeps({
      getStorage: async () => storage,
      daemonStatus: async (): Promise<DaemonStatus> => ({ running: false }),
      launch: async () => { call++; return { exitCode: 0, sessionId: null, builderId: 'abcd1234' }; },
      errorOut: (m) => errors.push(m),
    }));
    expect(call).toBe(1);
    expect(result).toEqual({ exitCode: 1, sessionId: null });
    expect(storage.intents.size).toBe(1);
    const joined = errors.join('\n');
    expect(joined).toContain('lazy builder --resume sess-dr');
    // Must NOT blame an upgrade that never ran.
    expect(joined).not.toContain("'lazy upgrade' process exited");
  });

  // An absent `reason` is an upgrade intent (every intent written before this
  // existed). Back-compat matters: those are durable records on disk.
  test('intent without a reason still takes the upgrade wait path', async () => {
    const storage = fakeStorage([intent({ sessionId: 'sess-up' })]);
    const seen: DaemonStatus[] = [];
    let call = 0;
    const result = await runBuilderRelaunchLoop(baseDeps({
      getStorage: async () => storage,
      daemonStatus: async (): Promise<DaemonStatus> => {
        // First call is the wait's baseline; the next reports a restart.
        const status: DaemonStatus = seen.length === 0
          ? { running: true, pid: 1, buildTime: 'old' }
          : { running: true, pid: 2, buildTime: 'new' };
        seen.push(status);
        return status;
      },
      launch: async () => { call++; return { exitCode: 0, sessionId: null, builderId: 'abcd1234' }; },
    }));
    expect(call).toBe(2);
    // A baseline plus at least one poll — i.e. it really waited.
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(result.exitCode).toBe(0);
  });
});
