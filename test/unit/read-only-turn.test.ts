import { describe, test, expect } from 'bun:test';
import { isReadOnlyWorkTurn, READ_ONLY_TURN_KEY } from '../../src/task/read-only-turn';
import type { Session, Task, Turn } from '../../src/types';
import type { Storage } from '../../src/storage/interface';

const SESSION = { id: 'sess-1' } as Session;

function storageWith(turns: Partial<Turn>[]): Storage {
  return { getSessionTurns: async () => turns as Turn[] } as unknown as Storage;
}

function taskWith(marker: string | undefined): Task {
  return { id: 't1', status: 'working', metadata: marker === undefined ? {} : { [READ_ONLY_TURN_KEY]: marker } } as unknown as Task;
}

const marker = (seq: number, session = 'sess-1') =>
  JSON.stringify({ command_id: 'cmd-1', session_id: session, human_turn_sequence: seq });

describe('isReadOnlyWorkTurn', () => {
  // INVARIANT: the marker holds while the human turn it names is still the
  // session's latest work turn — that is the reflective turn running now.
  test('applies to the work turn it names', async () => {
    const storage = storageWith([{ role: 'human', sequence: 1 }, { role: 'agent', sequence: 2 }, { role: 'human', sequence: 3 }]);
    expect(await isReadOnlyWorkTurn(storage, taskWith(marker(3)), SESSION)).toBe(true);
  });

  // INVARIANT: a leftover marker is inert once a later work turn launches, so
  // no launch path has to remember to clear it and a normal turn keeps full tools.
  test('is ignored once a later work turn exists', async () => {
    const storage = storageWith([{ role: 'human', sequence: 3 }, { role: 'human', sequence: 5 }]);
    expect(await isReadOnlyWorkTurn(storage, taskWith(marker(3)), SESSION)).toBe(false);
  });

  // INVARIANT: turns recorded DURING a turn (sync, ask, nudge) do not end it,
  // so they do not make the marker inert.
  test('mid-turn sync, ask and nudge turns do not count as a later work turn', async () => {
    const storage = storageWith([
      { role: 'human', sequence: 3 },
      { role: 'human', sequence: 5, turn_type: 'sync' },
      { role: 'human', sequence: 7, turn_type: 'ask' },
      { role: 'human', sequence: 9, turn_type: 'nudge' },
    ]);
    expect(await isReadOnlyWorkTurn(storage, taskWith(marker(3)), SESSION)).toBe(true);
  });

  // INVARIANT: a marker from another session never applies.
  test('is ignored for a different session', async () => {
    const storage = storageWith([{ role: 'human', sequence: 3 }]);
    expect(await isReadOnlyWorkTurn(storage, taskWith(marker(3, 'old-sess')), SESSION)).toBe(false);
  });

  // INVARIANT: an absent, empty or unreadable marker means "not read-only".
  test('absent, empty or unparseable markers do not apply', async () => {
    const storage = storageWith([{ role: 'human', sequence: 3 }]);
    for (const m of [undefined, '', '{not json', JSON.stringify({ command_id: 'x' })]) {
      expect(await isReadOnlyWorkTurn(storage, taskWith(m), SESSION)).toBe(false);
    }
  });
});
