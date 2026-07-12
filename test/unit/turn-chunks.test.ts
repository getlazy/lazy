import { describe, test, expect } from 'bun:test';
import { groupTurnsIntoChunks, isChunkBoundary } from '../../src/utils/turn-chunks';
import type { Turn, Actor, TurnRole } from '../../src/types';

/**
 * Unit tests for review-chunk grouping.
 *
 * INVARIANT: a chunk starts at a genuine human/builder review intervention and
 * absorbs every following automation turn (agent work, supervisor nudge, system
 * auto-resume) until the next intervention. This is the whole point of the
 * feature — intermediate auto-turns must NOT be dropped or treated as their own
 * review boundary, because that is exactly how context gets lost today.
 */

let seq = 0;
function turn(role: TurnRole, opts: { actor?: Actor; auto?: boolean } = {}): Turn {
  return {
    id: `t${seq}`,
    session_id: 's',
    sequence: seq++,
    role,
    content: `turn ${seq}`,
    timestamp: seq,
    usage: null,
    start_sha: null,
    start_sha_work: null,
    end_sha_work: null,
    end_sha: null,
    ...(opts.actor !== undefined ? { actor: opts.actor } : {}),
    ...(opts.auto !== undefined ? { auto_triggered: opts.auto } : {}),
  };
}

describe('isChunkBoundary', () => {
  test('human-role turn authored by human/builder is a boundary', () => {
    expect(isChunkBoundary(turn('human', { actor: 'human' }))).toBe(true);
    expect(isChunkBoundary(turn('human', { actor: 'builder' }))).toBe(true);
  });

  // INVARIANT: legacy turns predate actor population; absent actor === human.
  test('human-role turn with no actor is a boundary (backward compat)', () => {
    expect(isChunkBoundary(turn('human'))).toBe(true);
  });

  // INVARIANT: supervisor nudges and system auto-resumes are automation, not
  // review boundaries — they must be absorbed so the reviewer sees them.
  test('supervisor and system human-role turns are NOT boundaries', () => {
    expect(isChunkBoundary(turn('human', { actor: 'supervisor' }))).toBe(false);
    expect(isChunkBoundary(turn('human', { actor: 'system' }))).toBe(false);
  });

  test('agent turns are never boundaries', () => {
    expect(isChunkBoundary(turn('agent'))).toBe(false);
  });

  // INVARIANT: auto_triggered is the backstop for legacy auto-turns whose actor
  // was never set — an auto-triggered human-role turn is automation.
  test('auto_triggered human-role turn is NOT a boundary even without actor', () => {
    expect(isChunkBoundary(turn('human', { auto: true }))).toBe(false);
  });
});

describe('groupTurnsIntoChunks', () => {
  test('empty input yields no chunks', () => {
    expect(groupTurnsIntoChunks([])).toEqual([]);
  });

  test('a human turn followed by agent work is one chunk', () => {
    seq = 0;
    const turns = [turn('human', { actor: 'human' }), turn('agent')];
    const chunks = groupTurnsIntoChunks(turns);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].turns).toHaveLength(2);
    expect(chunks[0].boundary?.sequence).toBe(0);
  });

  // The core scenario: a comment-driven auto-resume + supervisor nudge land
  // between two human turns. They must be absorbed into the first chunk, not
  // skipped and not promoted to their own boundary.
  test('absorbs system + supervisor + agent turns until the next human turn', () => {
    seq = 0;
    const turns = [
      turn('human', { actor: 'human' }),       // 0: chunk A boundary
      turn('agent'),                            // 1: A
      turn('human', { actor: 'system', auto: true }),    // 2: A (auto-resume)
      turn('agent'),                            // 3: A
      turn('human', { actor: 'supervisor', auto: true }), // 4: A (nudge)
      turn('agent'),                            // 5: A
      turn('human', { actor: 'human' }),       // 6: chunk B boundary
      turn('agent'),                            // 7: B
    ];
    const chunks = groupTurnsIntoChunks(turns);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].turns.map(t => t.sequence)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(chunks[1].turns.map(t => t.sequence)).toEqual([6, 7]);
    expect(chunks[0].index).toBe(0);
    expect(chunks[1].index).toBe(1);
  });

  // Leading automation/agent turns (e.g. an auto-resumed session before any
  // human turn) form a boundary-less chunk rather than being dropped.
  test('leading non-boundary turns form a chunk with null boundary', () => {
    seq = 0;
    const turns = [
      turn('human', { actor: 'system', auto: true }), // 0: leading auto-resume
      turn('agent'),                                   // 1
      turn('human', { actor: 'human' }),               // 2: real boundary
      turn('agent'),                                   // 3
    ];
    const chunks = groupTurnsIntoChunks(turns);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].boundary).toBeNull();
    expect(chunks[0].turns.map(t => t.sequence)).toEqual([0, 1]);
    expect(chunks[1].boundary?.sequence).toBe(2);
    expect(chunks[1].turns.map(t => t.sequence)).toEqual([2, 3]);
  });

  test('consecutive human turns each open their own chunk', () => {
    seq = 0;
    const turns = [
      turn('human', { actor: 'human' }),
      turn('human', { actor: 'builder' }),
    ];
    const chunks = groupTurnsIntoChunks(turns);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].turns).toHaveLength(1);
    expect(chunks[1].turns).toHaveLength(1);
  });
});
