/**
 * `waiting.json` — the protocol-dir marker readers fold into
 * `working(waiting on …)` (`src/protocol/waiting.ts`).
 *
 * Every case here is a "no trustworthy signal" case, and every one of them must
 * degrade to NO waits: the substate is purely observational, so being silent is
 * always better than reporting a wait that is not happening.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  writeWaitingFile,
  clearWaitingFile,
  readActiveWaits,
  WAITING_FILE,
  type WaitingEntry,
} from '../../src/protocol/waiting';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lazy-waiting-file-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const entry: WaitingEntry = {
  id: 'w1',
  tool: 'lazy_wait',
  targets: ['task-2'],
  labels: ['fix-foo'],
  started_at: '2026-08-04T10:00:00.000Z',
};

describe('waiting.json', () => {
  test('round-trips the in-flight wait set', async () => {
    await writeWaitingFile(dir, { version: 1, daemon_pid: process.pid, waits: [entry] });
    expect(await readActiveWaits(dir)).toEqual([entry]);
  });

  test('missing file → no waits', async () => {
    expect(await readActiveWaits(dir)).toEqual([]);
  });

  test('clear removes the marker and is idempotent', async () => {
    await writeWaitingFile(dir, { version: 1, daemon_pid: process.pid, waits: [entry] });
    await clearWaitingFile(dir);
    await clearWaitingFile(dir);
    expect(await readActiveWaits(dir)).toEqual([]);
  });

  // INVARIANT: a daemon that was SIGKILLed mid-wait cannot clear its markers, so
  // the writing pid is the tripwire — a dead writer means the file is a lie and
  // the reader falls back to the pre-existing `working(agent)`.
  test('a marker written by a dead daemon is disbelieved', async () => {
    await writeWaitingFile(dir, { version: 1, daemon_pid: 2 ** 31 - 1, waits: [entry] });
    expect(await readActiveWaits(dir)).toEqual([]);
  });

  test('a nonsense pid is disbelieved', async () => {
    await writeWaitingFile(dir, { version: 1, daemon_pid: 0, waits: [entry] });
    expect(await readActiveWaits(dir)).toEqual([]);
  });

  test('corrupt JSON degrades to no waits', async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, WAITING_FILE), '{ not json', 'utf-8');
    expect(await readActiveWaits(dir)).toEqual([]);
  });

  test('an empty wait list reads as no waits', async () => {
    await writeWaitingFile(dir, { version: 1, daemon_pid: process.pid, waits: [] });
    expect(await readActiveWaits(dir)).toEqual([]);
  });

  // Entries are shape-checked, not trusted: a malformed one must be dropped
  // rather than rendered as `waiting on undefined`.
  test('malformed entries are dropped, well-formed siblings survive', async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, WAITING_FILE),
      JSON.stringify({
        version: 1,
        daemon_pid: process.pid,
        waits: [{ id: 'bad' }, entry],
      }),
      'utf-8',
    );
    expect(await readActiveWaits(dir)).toEqual([entry]);
  });
});
