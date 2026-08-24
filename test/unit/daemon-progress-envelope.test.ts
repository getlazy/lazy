/**
 * Phase progress on the wire.
 *
 * The heartbeat envelope carries a third line kind — `{"progress": …}` — so a
 * long daemon operation can say WHAT it is doing, not merely that it is alive.
 * These tests pin that framing end to end (producer → NDJSON → reader) without
 * a server: `heartbeatEnvelopeResponse` returns a plain Response, and
 * `readHeartbeatEnvelope` consumes exactly what a real client would.
 */

import { describe, test, expect } from 'bun:test';
import {
  heartbeatEnvelopeResponse,
  readHeartbeatEnvelope,
  type EnvelopeResult,
} from '../../src/daemon/heartbeat';
import { PhaseReporter, ACCEPT_PHASES, type ProgressEvent } from '../../src/daemon/progress';

describe('progress lines in the heartbeat envelope', () => {
  test('phase events written by the handler reach the client in order', async () => {
    const response = heartbeatEnvelopeResponse(async emit => {
      const phases = new PhaseReporter(emit, 'accept');
      phases.announce([ACCEPT_PHASES.merge, ACCEPT_PHASES.cleanup], 'ab12cd34');
      phases.begin(ACCEPT_PHASES.merge);
      phases.end('merge committed');
      phases.skip(ACCEPT_PHASES.cleanup, 'nothing to clean');
      return { status: 200, body: { merged: true } } satisfies EnvelopeResult;
    }, { intervalMs: 60_000 }); // no heartbeats — this test is about progress

    const seen: ProgressEvent[] = [];
    const result = await readHeartbeatEnvelope(response, 'accept', undefined, e => seen.push(e));

    expect(result).toEqual({ status: 200, body: { merged: true } });
    // `kind !== 'phase'` rather than `kind === 'plan'`: ProgressEvent also
    // carries live 'activity' lines now, and this assertion is about phases.
    expect(seen.map(e => (e.kind !== 'phase' ? e.kind : `${e.id}:${e.state}`))).toEqual([
      'plan', 'merge:start', 'merge:done', 'cleanup:skipped',
    ]);
  });

  // INVARIANT: a progress line is BOTH narration and liveness — the daemon
  // wrote it because its handler is running right now. A client whose deadline
  // is reset by heartbeats must be reset by phase changes too, or a chatty
  // operation could still time out between heartbeat ticks.
  test('a progress line also feeds the heartbeat (liveness) callback', async () => {
    const response = heartbeatEnvelopeResponse(async emit => {
      new PhaseReporter(emit, 'accept').begin(ACCEPT_PHASES.merge);
      return { status: 200, body: {} };
    }, { intervalMs: 60_000 });

    const beats: number[] = [];
    await readHeartbeatEnvelope(response, 'accept', ms => beats.push(ms), () => {});
    // The preamble beat plus the progress-as-liveness beat.
    expect(beats.length).toBeGreaterThanOrEqual(2);
  });

  test('heartbeat lines carry the label of the phase in flight', async () => {
    const response = heartbeatEnvelopeResponse(async emit => {
      new PhaseReporter(emit, 'accept').begin(ACCEPT_PHASES.merge);
      await new Promise(resolve => setTimeout(resolve, 120));
      return { status: 200, body: {} };
    }, { intervalMs: 30 });

    const phases: (string | undefined)[] = [];
    await readHeartbeatEnvelope(response, 'accept', (_ms, phase) => phases.push(phase));
    expect(phases).toContain('Merge');
  });

  test('a closed phase clears the heartbeat label rather than reporting a stale one', async () => {
    const response = heartbeatEnvelopeResponse(async emit => {
      const phases = new PhaseReporter(emit, 'accept');
      phases.begin(ACCEPT_PHASES.merge);
      phases.end();
      await new Promise(resolve => setTimeout(resolve, 120));
      return { status: 200, body: {} };
    }, { intervalMs: 30 });

    const labels: (string | undefined)[] = [];
    await readHeartbeatEnvelope(response, 'accept', (ms, phase) => { if (ms > 0) labels.push(phase); });
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.every(l => l === undefined)).toBe(true);
  });

  // A client that does not care about narration must be unaffected: progress
  // lines are skipped, and the result line is still the payload.
  test('a client with no progress callback still gets the result', async () => {
    const response = heartbeatEnvelopeResponse(async emit => {
      new PhaseReporter(emit, 'accept').begin(ACCEPT_PHASES.merge);
      return { status: 409, body: { error: 'nope' } };
    }, { intervalMs: 60_000 });

    expect(await readHeartbeatEnvelope(response, 'accept')).toEqual({
      status: 409, body: { error: 'nope' },
    });
  });
});
