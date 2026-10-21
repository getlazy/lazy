/**
 * The daemon's record of which command a mailbox's supervisor was last handed,
 * and the one question it answers: does this response belong to that command?
 *
 * A supervisor runs one command at a time, and a launch that finds the task's
 * run alive leaves its command for that supervisor to pick up next — so the
 * next response in the mailbox can be an EARLIER command's. The reconciler used
 * to read it as the queued turn's answer and park the task under it, where the
 * queued turn's agent could no longer write (src/utils/reconcile.ts).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, readdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  writeCommand,
  writeResponse,
  readDispatchedCommandId,
  answersLatestCommand,
  cleanProtocol,
} from '../../src/protocol';
import type { CompletedResponse, SyncCommand } from '../../src/protocol';

function syncCommand(commandId?: string): SyncCommand {
  return {
    type: 'sync',
    task_id: 'task-under-test',
    parent_branch: 'main',
    ...(commandId ? { command_id: commandId } : {}),
  } as SyncCommand;
}

function answer(commandId?: string): CompletedResponse {
  return {
    status: 'completed',
    result: 'done',
    session_id: 's',
    ...(commandId ? { command_id: commandId } : {}),
  };
}

describe('the dispatched-command record', () => {
  let base: string;
  let dir: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'lazy-proto-base-'));
    dir = join(base, 'task-under-test');
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  // INVARIANT: the record lives BESIDE the mailbox, never in it. The mailbox is
  // bind-mounted read-write into the task container; nothing in there may
  // decide which command the daemon believes is running.
  test('names the command just written, and sits outside the mounted mailbox', async () => {
    writeCommand(dir, syncCommand('cmd-1'));
    expect(readDispatchedCommandId(dir)).toBe('cmd-1');
    expect((await readdir(dir)).some(f => f.includes('dispatched'))).toBe(false);

    writeCommand(dir, syncCommand('cmd-2'));
    expect(readDispatchedCommandId(dir)).toBe('cmd-2');
  });

  // INVARIANT: an earlier command's answer does not answer the command queued
  // behind it — that is what keeps the queued turn from being parked under.
  test('a response to an earlier command is not the latest command\'s answer', () => {
    writeCommand(dir, syncCommand('cmd-1'));
    writeCommand(dir, syncCommand('cmd-2'));
    expect(answersLatestCommand(dir, answer('cmd-1'))).toBe(false);
    expect(answersLatestCommand(dir, answer('cmd-2'))).toBe(true);
  });

  // INVARIANT: only positive evidence sets a response aside. A response with no
  // id (an older supervisor, `lazy stop`'s own), or no record at all, is read as
  // the answer, as it was before the record existed.
  test('an uncorrelated response or an unrecorded mailbox reads as the answer', () => {
    expect(answersLatestCommand(dir, answer('cmd-1'))).toBe(true);
    writeCommand(dir, syncCommand('cmd-2'));
    expect(answersLatestCommand(dir, answer())).toBe(true);

    // A command with no id clears the record rather than leaving the previous one.
    writeCommand(dir, syncCommand());
    expect(readDispatchedCommandId(dir)).toBeNull();
    expect(answersLatestCommand(dir, answer('cmd-2'))).toBe(true);
  });

  test('cleaning the mailbox drops the record with the command', () => {
    writeCommand(dir, syncCommand('cmd-1'));
    cleanProtocol(dir);
    expect(readDispatchedCommandId(dir)).toBeNull();
  });

  // The record does not change what writeCommand already guarantees.
  test('writing a command still sets an unread response aside', async () => {
    writeCommand(dir, syncCommand('cmd-1'));
    writeResponse(dir, answer('cmd-1'));
    writeCommand(dir, syncCommand('cmd-2'));
    expect((await readdir(dir)).filter(f => f.startsWith('superseded-response-'))).toHaveLength(1);
  });
});
