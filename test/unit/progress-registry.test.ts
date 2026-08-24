/**
 * Daemon progress registry (`src/daemon/progress-registry.ts`) — the bookkeeping
 * behind `lazy_update_progress`.
 *
 * INVARIANT under test throughout: this is ephemeral, latest-wins, observational
 * state. It keeps no history, it never touches Storage, and it must never be
 * able to break the call it observes.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { recordProgress, clearProgress, clearAllProgress } from '../../src/daemon/progress-registry';
import { protocolDir, readTaskProgress, MAX_PROGRESS_MESSAGE_LENGTH } from '../../src/protocol';

let protoBase: string;
let prevProtoBase: string | undefined;

const TASK = 'task-aaaaaaaa';
const OTHER = 'task-bbbbbbbb';

beforeEach(async () => {
  protoBase = await mkdtemp(join(tmpdir(), 'lazy-progressreg-proto-'));
  prevProtoBase = process.env.LAZY_PROTOCOL_BASE;
  process.env.LAZY_PROTOCOL_BASE = protoBase;
});

afterEach(async () => {
  await clearAllProgress();
  if (prevProtoBase === undefined) delete process.env.LAZY_PROTOCOL_BASE;
  else process.env.LAZY_PROTOCOL_BASE = prevProtoBase;
  await rm(protoBase, { recursive: true, force: true });
});

describe('progress registry', () => {
  test('records a line readers can see', async () => {
    const result = await recordProgress(TASK, 'reproducing the bug');
    expect(result).toEqual({ message: 'reproducing the bug', truncated: false });
    expect((await readTaskProgress(protocolDir(TASK)))?.message).toBe('reproducing the bug');
  });

  // LATEST-WINS is the whole contract: no history, ever.
  test('a later post replaces the earlier one', async () => {
    await recordProgress(TASK, 'reproducing the bug');
    await recordProgress(TASK, 'running the unit suite');
    expect((await readTaskProgress(protocolDir(TASK)))?.message).toBe('running the unit suite');
  });

  // Concurrent posts from one session are possible — latest-wins is only
  // meaningful if the writes serialize instead of interleaving.
  test('concurrent posts serialize and the last one wins', async () => {
    await Promise.all([1, 2, 3, 4, 5].map(n => recordProgress(TASK, `step ${n}`)));
    expect((await readTaskProgress(protocolDir(TASK)))?.message).toBe('step 5');
  });

  test('truncates rather than rejecting, and says so', async () => {
    const result = await recordProgress(TASK, 'q'.repeat(400));
    expect(result.truncated).toBe(true);
    expect(result.message?.length).toBe(MAX_PROGRESS_MESSAGE_LENGTH);
  });

  // A whitespace-only line has nothing to show, so it clears rather than
  // writing a blank marker that readers would have to special-case.
  test('a blank message clears the marker', async () => {
    await recordProgress(TASK, 'reproducing the bug');
    expect(await recordProgress(TASK, '   \n ')).toEqual({ message: null, truncated: false });
    expect(await readTaskProgress(protocolDir(TASK))).toBeNull();
  });

  test('clearProgress drops the marker and is idempotent', async () => {
    await recordProgress(TASK, 'reproducing the bug');
    await clearProgress(TASK);
    await clearProgress(TASK);
    expect(await readTaskProgress(protocolDir(TASK))).toBeNull();
  });

  test('tasks are independent', async () => {
    await recordProgress(TASK, 'task one');
    await recordProgress(OTHER, 'task two');
    await clearProgress(TASK);
    expect(await readTaskProgress(protocolDir(TASK))).toBeNull();
    expect((await readTaskProgress(protocolDir(OTHER)))?.message).toBe('task two');
  });

  // A clean daemon stop must not leave files behind that readers can only
  // disbelieve via the dead-pid tripwire.
  test('clearAllProgress clears every marker this process owns', async () => {
    await recordProgress(TASK, 'task one');
    await recordProgress(OTHER, 'task two');
    await clearAllProgress();
    expect(await readTaskProgress(protocolDir(TASK))).toBeNull();
    expect(await readTaskProgress(protocolDir(OTHER))).toBeNull();
  });
});
