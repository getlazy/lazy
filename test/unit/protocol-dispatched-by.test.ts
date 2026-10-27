/**
 * The daemon's record of which daemon PROCESS dispatched a mailbox's latest
 * command, and the one question it answers: did a daemon restart happen since
 * that turn launched? A turn whose daemon went away was killed by lazy, so the
 * reconciler resumes it instead of reading its commits as a finished turn.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { writeCommand, dispatchedByPreviousDaemon, cleanProtocol } from '../../src/protocol';
import type { SyncCommand } from '../../src/protocol';
import { setDaemonContext, clearDaemonContext } from '../../src/daemon/context';

const command = { type: 'sync', task_id: 'task-under-test', parent_branch: 'main', command_id: 'c1' } as SyncCommand;

describe('dispatching-daemon record', () => {
  let base: string;
  let dir: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'dispatched-by-'));
    dir = join(base, 'task-under-test');
  });

  afterEach(async () => {
    clearDaemonContext();
    await rm(base, { recursive: true, force: true });
  });

  // INVARIANT: only positive evidence counts. A command written outside a
  // daemon, or before the record existed, keeps stranded recovery's old answer.
  test('no record outside a daemon reads as not-a-restart', () => {
    writeCommand(dir, command);
    expect(dispatchedByPreviousDaemon(dir)).toBe(false);
  });

  // INVARIANT: a turn this daemon dispatched is not a restart victim, so a
  // genuine lost-finalize is still recovered as finished.
  test('a command this process dispatched is not from a previous daemon', () => {
    setDaemonContext({ webPort: 1, token: 't', bindHost: '127.0.0.1' } as never);
    writeCommand(dir, command);
    expect(dispatchedByPreviousDaemon(dir)).toBe(false);
  });

  // INVARIANT: a record naming another process means the daemon restarted
  // under the turn — its commits prove nothing about it finishing.
  test('a record naming another process is from a previous daemon', async () => {
    setDaemonContext({ webPort: 1, token: 't', bindHost: '127.0.0.1' } as never);
    writeCommand(dir, command);
    await writeFile(`${dir}.dispatched-by`, 'some-other-daemon-process');
    expect(dispatchedByPreviousDaemon(dir)).toBe(true);
  });

  test('an empty record is not evidence', async () => {
    await writeFile(`${dir}.dispatched-by`, '');
    expect(dispatchedByPreviousDaemon(dir)).toBe(false);
  });

  // INVARIANT: the record belongs to ONE command; the next command and a
  // protocol cleanup both drop it so it cannot speak for a later turn.
  test('the next command and cleanProtocol clear a stale record', async () => {
    writeCommand(dir, command);
    await writeFile(`${dir}.dispatched-by`, 'some-other-daemon-process');
    writeCommand(dir, command); // outside a daemon: clears, writes nothing
    expect(dispatchedByPreviousDaemon(dir)).toBe(false);
    await writeFile(`${dir}.dispatched-by`, 'some-other-daemon-process');
    cleanProtocol(dir);
    expect(dispatchedByPreviousDaemon(dir)).toBe(false);
  });
});
