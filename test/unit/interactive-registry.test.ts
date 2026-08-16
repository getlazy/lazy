/**
 * Unit tests: the interactive-session registry.
 *
 * `lazy pair` and `lazy chat` are host processes, so no runner discovery can see
 * them — which is why a live session used to survive `lazy upgrade` without so
 * much as a warning. This registry is how the daemon and `lazy upgrade`
 * enumerate them. See src/daemon/interactive-registry.ts.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, readdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { hostname } from 'os';
import {
  registerInteractiveSession,
  unregisterInteractiveSession,
  listInteractiveSessions,
  describeInteractiveSession,
  INTERACTIVE_SESSIONS_DIR,
  type InteractiveSessionEntry,
} from '../../src/daemon/interactive-registry';
import { getDaemonDir } from '../../src/daemon/paths';
import { makeDaemonBaseDir, removeDaemonBaseDir } from '../helpers/daemon-base-dir';

const PROJECT = '/tmp/interactive-registry-test-project';

let baseDir: string;
let previousBaseDir: string | undefined;

function entriesDir(): string {
  return join(getDaemonDir(PROJECT), INTERACTIVE_SESSIONS_DIR);
}

async function writeEntry(entry: Partial<InteractiveSessionEntry> & { pid: number }): Promise<void> {
  await mkdir(entriesDir(), { recursive: true });
  const full: InteractiveSessionEntry = {
    host: hostname(),
    startedAt: new Date().toISOString(),
    cwd: '/somewhere',
    ...entry,
  };
  await writeFile(join(entriesDir(), `${entry.pid}.json`), JSON.stringify(full));
}

beforeEach(async () => {
  previousBaseDir = process.env.LAZY_DAEMON_BASE_DIR;
  baseDir = await makeDaemonBaseDir();
  process.env.LAZY_DAEMON_BASE_DIR = baseDir;
});

afterEach(async () => {
  if (previousBaseDir === undefined) delete process.env.LAZY_DAEMON_BASE_DIR;
  else process.env.LAZY_DAEMON_BASE_DIR = previousBaseDir;
  await removeDaemonBaseDir(baseDir);
});

describe('interactive session registry', () => {
  test('an unregistered project lists nothing (no directory yet)', async () => {
    expect(await listInteractiveSessions(PROJECT)).toEqual([]);
  });

  test('register → list finds this process; unregister removes it', async () => {
    const entry = await registerInteractiveSession(PROJECT, { kind: 'pair', taskId: 'abcd1234', cwd: '/wt' });
    expect(entry.pid).toBe(process.pid);

    const listed = await listInteractiveSessions(PROJECT);
    expect(listed.length).toBe(1);
    expect(listed[0]!.pid).toBe(process.pid);
    expect(listed[0]!.taskId).toBe('abcd1234');
    expect(listed[0]!.cwd).toBe('/wt');

    await unregisterInteractiveSession(PROJECT);
    expect(await listInteractiveSessions(PROJECT)).toEqual([]);
  });

  test('unregistering a session that is already gone is not an error', async () => {
    await unregisterInteractiveSession(PROJECT, 999999);
    expect(await listInteractiveSessions(PROJECT)).toEqual([]);
  });

  test('a branchless session registers with no taskId', async () => {
    const entry = await registerInteractiveSession(PROJECT, { kind: 'pair', cwd: '/repo' });
    expect(entry.taskId).toBeUndefined();
    expect(describeInteractiveSession(entry)).toContain('branchless');
    await unregisterInteractiveSession(PROJECT);
  });

  // INVARIANT: the registry is self-healing. A pair session that is SIGKILLed
  // (or whose machine reboots) never unregisters itself, and a stale entry that
  // outlives its process would make `lazy upgrade` warn about a session that
  // does not exist — or worse, invite someone to signal a recycled pid.
  test('a dead pid is pruned from the listing and from disk', async () => {
    // pid 1 exists but was not started when we claim; holderStartedAt is the
    // identity that makes the mismatch detectable rather than a pid guess.
    await writeEntry({
      pid: 999998,
      startedAt: new Date().toISOString(),
      holderStartedAt: '1970-01-01T00:00:00.000Z',
      holderStartSource: 'proc',
    });
    expect(await listInteractiveSessions(PROJECT)).toEqual([]);
    expect(await readdir(entriesDir())).toEqual([]);
  });

  test('an unreadable/half-written entry is dropped rather than accumulating', async () => {
    await mkdir(entriesDir(), { recursive: true });
    await writeFile(join(entriesDir(), '12345.json'), '{ not json');
    expect(await listInteractiveSessions(PROJECT)).toEqual([]);
    expect(await readdir(entriesDir())).toEqual([]);
  });

  // INVARIANT: a pid stamped on another machine is meaningless here — both
  // "alive" and "dead" would be guesses — so such an entry is reported as-is and
  // NEVER pruned. Pruning it would silently delete a live session's record from
  // a shared store.
  test('an entry from another host is listed unverified and never pruned', async () => {
    await writeEntry({ pid: 999997, host: 'some-other-machine', cwd: '/elsewhere' });
    const listed = await listInteractiveSessions(PROJECT);
    expect(listed.length).toBe(1);
    expect(listed[0]!.host).toBe('some-other-machine');
    expect((await readdir(entriesDir())).length).toBe(1);
  });

  test('listing is ordered oldest-first', async () => {
    await writeEntry({ pid: 999996, host: 'other', startedAt: '2026-01-02T00:00:00.000Z' });
    await writeEntry({ pid: 999995, host: 'other', startedAt: '2026-01-01T00:00:00.000Z' });
    const listed = await listInteractiveSessions(PROJECT);
    expect(listed.map(e => e.pid)).toEqual([999995, 999996]);
  });

  test('describeInteractiveSession names the task and the directory', () => {
    const line = describeInteractiveSession({
      pid: 42,
      host: 'h',
      startedAt: '2026-01-01T00:00:00.000Z',
      kind: 'pair',
      taskId: 'abcd1234',
      cwd: '/work/tree',
    });
    expect(line).toContain('42');
    expect(line).toContain('abcd1234');
    expect(line).toContain('/work/tree');
    expect(line).toContain('lazy pair');
  });

  // The two surfaces share one registry, so the human-facing line has to say
  // WHICH one is running — a stored `kind`, not something inferred from the
  // entry's other fields (a chat and a pair session on the same task look
  // identical otherwise).
  test('a chat session is recorded and described as chat, not pair', async () => {
    const entry = await registerInteractiveSession(PROJECT, { kind: 'chat', taskId: 'beef5678', cwd: '/wt' });
    expect(entry.kind).toBe('chat');

    const listed = await listInteractiveSessions(PROJECT);
    expect(listed[0]!.kind).toBe('chat');
    expect(describeInteractiveSession(listed[0]!)).toContain('lazy chat');

    await unregisterInteractiveSession(PROJECT);
  });

  // Entries written by an older lazy have no `kind`. They are still live
  // sessions and must still be listed and describable — only `lazy pair`
  // existed then, so that is the honest fallback.
  test('an entry with no kind still describes as a pair session', () => {
    const line = describeInteractiveSession({
      pid: 43,
      host: 'h',
      startedAt: '2026-01-01T00:00:00.000Z',
      cwd: '/work/tree',
    });
    expect(line).toContain('lazy pair');
  });
});
