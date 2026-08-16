/**
 * Unit tests: process identity — the decision table that tells a lock's real
 * holder apart from a process that merely inherited its pid.
 *
 * judgeHolder() is pure (it takes the OS answer rather than fetching it), so
 * every branch is testable without spawning anything.
 */

import { describe, test, expect } from 'bun:test';
import {
  judgeHolder,
  looksLikeLazyProcess,
  parsePsIdentityLine,
  parseProcStat,
  readProcessIdentity,
  readProcessIdentitySync,
  selfIdentity,
  isZombieState,
  type ProcessIdentity,
} from '../../src/utils/process-identity';

function identity(over: Partial<ProcessIdentity> = {}): ProcessIdentity {
  return { state: 'S', started: '1000', startedSource: 'proc', command: '/usr/bin/lazy daemon', ...over };
}

describe('parsePsIdentityLine', () => {
  test('splits state, lstart and command', () => {
    const parsed = parsePsIdentityLine('S    Thu Aug  6 20:26:07 2026 /usr/local/bin/lazy daemon start');
    expect(parsed).toEqual({
      state: 'S',
      started: 'Thu Aug 6 20:26:07 2026',
      startedSource: 'ps',
      command: '/usr/local/bin/lazy daemon start',
    });
  });

  test('returns null when the line is not the expected shape', () => {
    // A `ps` without lstart support must fall back, never be mis-parsed —
    // a bogus start time would read as pid reuse and steal a live lock.
    expect(parsePsIdentityLine('')).toBeNull();
    expect(parsePsIdentityLine('S')).toBeNull();
    expect(parsePsIdentityLine('S 12345 /usr/bin/lazy')).toBeNull();
  });
});

describe('parseProcStat', () => {
  const stat =
    '1433 (my prog) S 1 1433 1433 0 -1 4194560 904 0 0 0 0 0 0 0 20 0 1 0 36473448 884736 89 ' +
    '18446744073709551615 4194304 4733535 281474155610448 0 0 0 0 3145728 0 1 0 0 17 7 0 0 0 0 0';

  test('reads state and starttime past a comm containing spaces and parens', () => {
    const parsed = parseProcStat(stat, '/usr/bin/lazy daemon');
    expect(parsed).toEqual({
      state: 'S',
      started: '36473448',
      startedSource: 'proc',
      command: '/usr/bin/lazy daemon',
    });
  });

  test('returns null on a truncated stat line', () => {
    expect(parseProcStat('1 (init) S 0 1', null)).toBeNull();
    expect(parseProcStat('nonsense', null)).toBeNull();
  });
});

describe('judgeHolder', () => {
  test('unknown identity counts as alive (never steal from a possible holder)', () => {
    expect(judgeHolder({ pid: 5, started: '1000', startedSource: 'proc' }, null)).toEqual({ alive: true });
  });

  test('zombie counts as dead', () => {
    // INVARIANT: a defunct (terminated, unreaped) process still answers
    // kill(0) but will NEVER release a lock. Observed in the wild: an unreaped
    // `lazy pair` child wedged every storage write in the daemon.
    const verdict = judgeHolder({ pid: 5, started: '1000', startedSource: 'proc' }, identity({ state: 'Z+' }));
    expect(verdict).toEqual({ alive: false, reason: 'zombie' });
  });

  test('matching recorded start time counts as alive', () => {
    expect(judgeHolder({ pid: 5, started: '1000', startedSource: 'proc' }, identity())).toEqual({ alive: true });
  });

  test('different start time at the same pid is pid reuse', () => {
    const verdict = judgeHolder(
      { pid: 5, started: '1000', startedSource: 'proc' },
      identity({ started: '9999' }),
    );
    expect(verdict).toEqual({ alive: false, reason: 'pid-reused' });
  });

  test('start times from different sources are not compared', () => {
    // procfs reports ticks since boot, ps an absolute timestamp. Comparing
    // across sources would report every such lock as reused and steal it.
    const verdict = judgeHolder(
      { pid: 5, started: '1000', startedSource: 'proc' },
      identity({ started: 'Thu Aug 6 20:26:07 2026', startedSource: 'ps', command: '/usr/bin/lazy daemon' }),
    );
    expect(verdict).toEqual({ alive: true });
  });

  describe('legacy locks with no recorded identity', () => {
    test('a holder that started after the lock was taken is pid reuse', () => {
      const verdict = judgeHolder(
        { pid: 5, acquiredAt: '2026-08-06T20:00:00.000Z' },
        identity({
          started: new Date('2026-08-06T21:00:00.000Z').toString(),
          startedSource: 'ps',
        }),
      );
      expect(verdict).toEqual({ alive: false, reason: 'pid-reused' });
    });

    test('a holder that cannot be a lazy process is pid reuse', () => {
      const verdict = judgeHolder(
        { pid: 5, acquiredAt: new Date().toISOString() },
        identity({ started: null, startedSource: null, command: '/System/Library/…/postersyncd' }),
      );
      expect(verdict).toEqual({ alive: false, reason: 'implausible-holder' });
    });

    test('a plausible lazy holder is left alone', () => {
      const verdict = judgeHolder(
        { pid: 5, acquiredAt: new Date().toISOString() },
        identity({ started: null, startedSource: null, command: 'bun run ./src/index.ts daemon start' }),
      );
      expect(verdict).toEqual({ alive: true });
    });
  });
});

describe('looksLikeLazyProcess', () => {
  test('accepts lazy binaries and JS runtimes', () => {
    expect(looksLikeLazyProcess('/usr/local/bin/lazy daemon start')).toBe(true);
    expect(looksLikeLazyProcess('lazy-agent --one-shot')).toBe(true);
    expect(looksLikeLazyProcess('bun run ./src/index.ts list')).toBe(true);
    expect(looksLikeLazyProcess('/usr/bin/node /opt/x/cli.js')).toBe(true);
  });

  test('rejects unrelated system daemons', () => {
    expect(looksLikeLazyProcess('/System/Library/Frameworks/Contacts.framework/Support/postersyncd')).toBe(false);
    expect(looksLikeLazyProcess('/usr/sbin/cupsd -l')).toBe(false);
  });

  test('an empty command line is treated as possibly ours', () => {
    // Kernel threads report no command line; refusing to judge is the safe side.
    expect(looksLikeLazyProcess('')).toBe(true);
  });
});

describe('reading real processes', () => {
  test('reports this process with a usable start time', async () => {
    const self = await selfIdentity();
    expect(self).not.toBeNull();
    expect(isZombieState(self!.state)).toBe(false);
    expect(self!.started).toBeTruthy();
    expect(['proc', 'ps']).toContain(self!.startedSource ?? '');
  });

  test('sync and async readers agree', () => {
    const sync = readProcessIdentitySync(process.pid);
    expect(sync).not.toBeNull();
    return readProcessIdentity(process.pid).then(async => {
      expect(async!.started).toEqual(sync!.started);
      expect(async!.startedSource).toEqual(sync!.startedSource);
    });
  });

  test('reports nothing for a pid that cannot exist', async () => {
    expect(await readProcessIdentity(2_000_000)).toBeNull();
  });
});
