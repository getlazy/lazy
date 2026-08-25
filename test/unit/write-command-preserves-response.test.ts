/**
 * Unit tests pinning the invariant the supersession machinery rests on.
 *
 * INVARIANT: `writeCommand` NEVER destroys an unconsumed `response.json`. It
 * renames it to `superseded-response-*.json`, and `sweepSupersededResponses`
 * records it as a turn afterwards. This used to be an `unlinkSync` under a
 * silent `catch`, which is how a turn the agent actually finished could vanish
 * completely: no turn in the store, and — because `handleCompletedResponses` is
 * the only writer of both the turn record and `agent_session_id` — `lazy pair`
 * opening a fresh, empty session instead of the one that did the work.
 *
 * INVARIANT: because nothing else removes that file, its ABSENCE is a precise
 * signal, and `handleErrorResponse` reads it as "a newer command superseded this
 * report" before skipping its live-state mutations. That correctness argument
 * has exactly one premise — writeCommand renames rather than deletes — and this
 * file is its enforcement. A future change back to `unlink` must fail a test
 * here rather than silently resurrecting the bug in the reconciler.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, readdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  writeCommand,
  writeResponse,
  hasResponse,
  listSupersededResponses,
  consumeSupersededResponse,
} from '../../src/protocol';
import type { CompletedResponse, UnblockCommand } from '../../src/protocol';

const finishedTurn: CompletedResponse = {
  status: 'completed',
  result: 'The turn the human watched: everything I concluded, and what remains.',
  session_id: 'agent-session-that-did-the-work',
  usage: { input_tokens: 900, output_tokens: 210 },
};

const nextCommand: UnblockCommand = {
  type: 'unblock',
  task_id: 'task-under-test',
  goal: 'Do a thing',
  prompt: 'Carry on.',
};

describe('writeCommand and an unconsumed response', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lazy-proto-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('sets the response aside instead of deleting it', async () => {
    writeResponse(dir, finishedTurn);
    expect(hasResponse(dir)).toBe(true);

    writeCommand(dir, nextCommand);

    // Gone from its live location — the supervisor's next turn must not see it
    // and conclude it has already been answered...
    expect(hasResponse(dir)).toBe(false);

    // ...but preserved, in full, under a name the sweep will find.
    const setAside = (await readdir(dir)).filter(f => f.startsWith('superseded-response-'));
    expect(setAside).toHaveLength(1);

    const recovered = listSupersededResponses(dir);
    expect(recovered).toHaveLength(1);
    const response = recovered[0]!.response as CompletedResponse;
    expect(response.result).toBe(finishedTurn.result);
    expect(response.session_id).toBe(finishedTurn.session_id);
  });

  test('displacing twice preserves both turns, not just the last', () => {
    writeResponse(dir, finishedTurn);
    writeCommand(dir, nextCommand);

    const second: CompletedResponse = { ...finishedTurn, result: 'A second finished turn.' };
    writeResponse(dir, second);
    writeCommand(dir, nextCommand);

    const results = listSupersededResponses(dir)
      .map(r => (r.response as CompletedResponse).result)
      .sort();
    expect(results).toEqual(['A second finished turn.', finishedTurn.result].sort());
  });

  test('a consumed response leaves nothing behind to re-record', () => {
    // The ordinary path: the reconciler already recorded the turn, so there is
    // no response.json when the next command lands and nothing is set aside.
    writeCommand(dir, nextCommand);
    expect(listSupersededResponses(dir)).toHaveLength(0);
  });

  test('consuming a recovered response removes it, so it is recorded once', () => {
    writeResponse(dir, finishedTurn);
    writeCommand(dir, nextCommand);

    const [recovered] = listSupersededResponses(dir);
    consumeSupersededResponse(recovered!.path);

    expect(listSupersededResponses(dir)).toHaveLength(0);
  });
});
