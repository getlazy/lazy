/**
 * `progress.json` — the protocol-dir marker readers fold into
 * `working(agent: …)` (`src/protocol/progress.ts`).
 *
 * Same posture as `waiting.json`: every "no trustworthy signal" case must
 * degrade to NO progress. The line is purely observational, so reporting
 * nothing is always better than reporting a claim about a turn that is over.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  writeProgressFile,
  clearProgressFile,
  readTaskProgress,
  normalizeProgressMessage,
  PROGRESS_FILE,
  MAX_PROGRESS_MESSAGE_LENGTH,
  type ProgressFile,
} from '../../src/protocol/progress';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lazy-progress-file-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function file(overrides: Partial<ProgressFile> = {}): ProgressFile {
  return {
    version: 1,
    writer_pid: process.pid,
    message: 'running migration 3/7',
    recorded_at: '2026-08-19T10:00:00.000Z',
    ...overrides,
  };
}

describe('progress.json', () => {
  test('round-trips the current progress line', async () => {
    await writeProgressFile(dir, file());
    expect(await readTaskProgress(dir)).toEqual({
      message: 'running migration 3/7',
      recorded_at: '2026-08-19T10:00:00.000Z',
    });
  });

  test('missing file → no progress', async () => {
    expect(await readTaskProgress(dir)).toBeNull();
  });

  // LATEST-WINS: there is no history here, by design.
  test('a second write replaces the first', async () => {
    await writeProgressFile(dir, file());
    await writeProgressFile(dir, file({ message: 'running the unit suite' }));
    expect((await readTaskProgress(dir))?.message).toBe('running the unit suite');
  });

  test('clear removes the marker and is idempotent', async () => {
    await writeProgressFile(dir, file());
    await clearProgressFile(dir);
    await clearProgressFile(dir);
    expect(await readTaskProgress(dir)).toBeNull();
  });

  // INVARIANT: a daemon SIGKILLed mid-turn cannot clear its markers, so the
  // writing pid is the tripwire — a dead writer means the file is a lie and the
  // reader falls back to the pre-existing `working(agent)`.
  test('a marker written by a dead process is disbelieved', async () => {
    await writeProgressFile(dir, file({ writer_pid: 2 ** 31 - 1 }));
    expect(await readTaskProgress(dir)).toBeNull();
  });

  test('a nonsense pid is disbelieved', async () => {
    await writeProgressFile(dir, file({ writer_pid: 0 }));
    expect(await readTaskProgress(dir)).toBeNull();
  });

  test('corrupt JSON degrades to no progress', async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, PROGRESS_FILE), '{ not json', 'utf-8');
    expect(await readTaskProgress(dir)).toBeNull();
  });

  // A half-understood entry must degrade to "no progress" rather than render
  // `working(agent: undefined)`.
  test('malformed shapes degrade to no progress', async () => {
    await mkdir(dir, { recursive: true });
    for (const bad of [{}, { message: 42 }, { message: '   ' }, { message: 'x' }]) {
      await writeFile(
        join(dir, PROGRESS_FILE),
        JSON.stringify({ version: 1, writer_pid: process.pid, ...bad }),
        'utf-8',
      );
      expect(await readTaskProgress(dir)).toBeNull();
    }
  });

  // The cap is a display invariant, so it is enforced on read too: a file
  // written by another build must not be able to break a table cell.
  test('an over-length message from another writer is truncated on read', async () => {
    await writeProgressFile(dir, file({ message: 'x'.repeat(500) }));
    const read = await readTaskProgress(dir);
    expect(read?.message.length).toBe(MAX_PROGRESS_MESSAGE_LENGTH);
  });
});

describe('normalizeProgressMessage', () => {
  test('collapses whitespace so a multi-line paste stays one cell', () => {
    expect(normalizeProgressMessage('  running\n  migration\t3/7 ')).toEqual({
      message: 'running migration 3/7',
      truncated: false,
    });
  });

  // INVARIANT: over-length is TRUNCATED, never rejected. A progress post is
  // fire-and-forget; failing it over a display concern is the one way this
  // feature could cost an agent its turn.
  test('truncates with an ellipsis and reports it', () => {
    const { message, truncated } = normalizeProgressMessage('y'.repeat(400));
    expect(truncated).toBe(true);
    expect(message.length).toBe(MAX_PROGRESS_MESSAGE_LENGTH);
    expect(message.endsWith('…')).toBe(true);
  });

  test('a message exactly at the cap is left alone', () => {
    const exact = 'z'.repeat(MAX_PROGRESS_MESSAGE_LENGTH);
    expect(normalizeProgressMessage(exact)).toEqual({ message: exact, truncated: false });
  });

  test('whitespace-only normalizes to empty (callers clear instead of writing)', () => {
    expect(normalizeProgressMessage('  \n\t ').message).toBe('');
  });
});
