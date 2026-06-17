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
    log: () => {},
    errorOut: () => {},
    timeoutMs: 100,
    pollIntervalMs: 10,
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

  // INVARIANT: the intent is consumed ONLY after committing to the relaunch.
  // On timeout the loop must LEAVE the intent in place (recovery path) and print
  // an actionable manual-resume command.
  test('timeout → leaves intent, prints actionable fallback, suppresses footer', async () => {
    const storage = fakeStorage([intent({ sessionId: 'sess-resume' })]);
    const errors: string[] = [];
    let launches = 0;
    const result = await runBuilderRelaunchLoop(baseDeps({
      getStorage: async () => storage,
      launch: async () => { launches++; return { exitCode: 137, sessionId: null, builderId: 'abcd1234' }; },
      // Daemon never restarts → upgrade never completes → timeout.
      daemonStatus: async () => ({ running: true, pid: 1, buildTime: 'dev' }),
      errorOut: (m) => errors.push(m),
    }));
    expect(launches).toBe(1); // never relaunched
    expect(result.exitCode).toBe(1);
    expect(result.sessionId).toBeNull(); // footer suppressed
    // Intent preserved for manual recovery.
    expect(storage.intents.size).toBe(1);
    // Actionable fallback printed with the resolved id.
    expect(errors.join('\n')).toContain('lazy builder --resume sess-resume');
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
});
