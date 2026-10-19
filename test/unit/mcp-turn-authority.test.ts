/**
 * Which live turn a task's MCP token acts for, and as whom
 * (src/daemon/mcp-turn-authority.ts). The route-level behaviour is proven end to
 * end in test/e2e/mcp-turn-authority.test.ts; this covers the precedence a
 * real daemon cannot easily stage — a claim whose owner differs from the
 * session's — and the self-review phase.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { resolveMcpTurnAuthority, assertMcpCallAuthorised } from '../../src/daemon/mcp-turn-authority';
import type { InFlightTurn, Task } from '../../src/types';
import type { Storage } from '../../src/storage/interface';
import { markAcceptGateRunning, clearAcceptGateRunning } from '../../src/daemon/accept-gate-marker';

const TASK_ID = '11111111-2222-4333-8444-555555555555';

function storageWithSessionOwner(email: string | null): Storage {
  return {
    getSessionByTaskId: async () => ({ id: 'sess-1', turn_owner_email: email }),
    getTaskMetadata: async () => null,
  } as unknown as Storage;
}

function task(status: Task['status'], claim: Partial<InFlightTurn> | null = null): Task {
  return {
    id: TASK_ID,
    code: 'authority-task',
    status,
    in_flight_turn: claim
      ? {
        session_id: 'sess-1', owner: 'ask', turn_type: 'ask', turn_sequence: 2, human_turn_sequence: 1,
        restore_status: 'blocked', started_at: Date.now(), expires_at: Date.now() + 60_000, ...claim,
      } as InFlightTurn
      : null,
  } as unknown as Task;
}

describe('MCP turn authority', () => {
  let protoBase: string;
  let saved: string | undefined;

  beforeEach(async () => {
    protoBase = await mkdtemp(join(tmpdir(), 'lazy-authority-proto-'));
    saved = process.env.LAZY_PROTOCOL_BASE;
    process.env.LAZY_PROTOCOL_BASE = protoBase;
  });

  afterEach(async () => {
    if (saved === undefined) delete process.env.LAZY_PROTOCOL_BASE; else process.env.LAZY_PROTOCOL_BASE = saved;
    await rm(protoBase, { recursive: true, force: true });
  });

  // INVARIANT: during an ask/review claim the person is the one the CLAIM
  // captured at launch, never the session's current owner — the session may
  // already belong to a later turn by the time a call arrives.
  test("a live claim's captured owner wins over the session's", async () => {
    const authority = await resolveMcpTurnAuthority(
      storageWithSessionOwner('ivan@example.com'),
      task('working', { owner: 'review', turn_owner_email: 'pete@example.com', turn_owner_name: 'Pete' }),
    );
    expect(authority).toEqual({
      kind: 'turn', toolset: 'review', owner: { email: 'pete@example.com', name: 'Pete' }, turnLabel: 'review turn',
    });
  });

  // INVARIANT: a settled or expired claim is not a live turn.
  test('an expired claim on a parked task is no turn at all', async () => {
    const authority = await resolveMcpTurnAuthority(
      storageWithSessionOwner('ivan@example.com'),
      task('blocked', { expires_at: Date.now() - 1 }),
    );
    expect(authority.kind).toBe('none');
    expect(() => assertMcpCallAuthorised(task('blocked'), 'lazy_journal', authority)).toThrow('no turn running');
    expect(() => assertMcpCallAuthorised(task('blocked'), 'lazy_show', authority)).not.toThrow();
  });

  // INVARIANT: the low-high self-review is a read-only phase of a work turn,
  // and the daemon holds it to the read-only toolset like an ask.
  test('a work turn in its self-review phase gets only read tools', async () => {
    await mkdir(join(protoBase, TASK_ID), { recursive: true });
    await writeFile(join(protoBase, TASK_ID, 'status.json'), JSON.stringify({ phase: 'low_high_review' }));
    const authority = await resolveMcpTurnAuthority(storageWithSessionOwner('ivan@example.com'), task('working'));
    expect(authority).toMatchObject({ kind: 'turn', toolset: 'read', owner: { email: 'ivan@example.com' } });
    expect(() => assertMcpCallAuthorised(task('working'), 'lazy_start', authority)).toThrow('read-only');
  });

  // INVARIANT: an unclassified tool (the supervisor's internal git hatch,
  // lazy_image_build) is a write: it fails closed on a read-only turn.
  test('unclassified tools are refused on read-only turns', async () => {
    const authority = await resolveMcpTurnAuthority(storageWithSessionOwner(null), task('working', { owner: 'ask' }));
    expect(() => assertMcpCallAuthorised(task('working'), 'lazy_internal_git', authority)).toThrow('read-only');
    expect(() => assertMcpCallAuthorised(task('working'), 'lazy_raise', authority)).toThrow('read-only');
  });

  test('a plain work turn gets the full toolset as its session owner', async () => {
    const authority = await resolveMcpTurnAuthority(storageWithSessionOwner('ivan@example.com'), task('working'));
    expect(authority).toEqual({ kind: 'turn', toolset: 'full', owner: { email: 'ivan@example.com' }, turnLabel: 'work turn' });
    expect(() => assertMcpCallAuthorised(task('working'), 'lazy_start', authority)).not.toThrow();
  });

  // INVARIANT: the accept gate's `working` is not a turn. No agent runs, so
  // the task's token — reachable by anything left in its container — must not
  // get full authority for the gate's duration; once the gate ends, a real
  // work turn gets its authority back.
  test('the accept gate holds working but grants no turn', async () => {
    markAcceptGateRunning(TASK_ID);
    try {
      const gated = await resolveMcpTurnAuthority(storageWithSessionOwner('ivan@example.com'), task('working'));
      expect(gated.kind).toBe('none');
      expect(() => assertMcpCallAuthorised(task('working'), 'lazy_start', gated)).toThrow('no turn running');
    } finally {
      clearAcceptGateRunning(TASK_ID);
    }
    const after = await resolveMcpTurnAuthority(storageWithSessionOwner('ivan@example.com'), task('working'));
    expect(after).toMatchObject({ kind: 'turn', toolset: 'full' });
  });
});
