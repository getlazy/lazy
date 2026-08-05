import { describe, test, expect } from 'bun:test';
import { unresolvedAuthRejection } from '../../src/proxy/auth-verdict';
import type { ProxyAuditRecord } from '../../src/storage/types';

function rec(ts: number, status: number | null, extra: Partial<ProxyAuditRecord> = {}): ProxyAuditRecord {
  return {
    id: `r${ts}`,
    seq: ts,
    ts,
    role: 'builder',
    taskId: null,
    backend: 'anthropic',
    upstream: 'https://api.anthropic.com',
    method: 'POST',
    path: '/v1/messages',
    endpoint: 'messages',
    model: 'claude-opus-5',
    tier: 'opus',
    stream: true,
    requestShape: null,
    toolUses: [],
    toolResults: [],
    status,
    usage: null,
    stopReason: null,
    error: null,
    durationMs: 10,
    reroute: null,
    ...extra,
  };
}

/**
 * The daemon credential gate checks PRESENCE, not validity, and documents that
 * the authoritative signal for "this credential does not work" is the upstream
 * 401 the audit proxy sees. Nothing read that signal, so an expired token looked
 * healthy on every surface while the builder was asking the human to /login.
 *
 * INVARIANT: the verdict is derived purely from the ORDER of statuses in the
 * audit trail — no stored flag, no cached state. That is what makes it
 * self-clearing: a good token produces a success newer than the rejection and
 * the warning disappears with nothing to reset.
 */
describe('unresolvedAuthRejection', () => {
  test('null when there is no evidence at all', () => {
    expect(unresolvedAuthRejection([])).toBeNull();
  });

  test('null while requests are succeeding', () => {
    expect(unresolvedAuthRejection([rec(1, 200), rec(2, 200)])).toBeNull();
  });

  test('reports a 401 that nothing has succeeded after', () => {
    const verdict = unresolvedAuthRejection([rec(1, 200), rec(2, 401, { error: 'expired' })]);
    expect(verdict).toMatchObject({ ts: 2, status: 401, role: 'builder', error: 'expired' });
  });

  test('403 counts as a rejection too', () => {
    expect(unresolvedAuthRejection([rec(1, 403)])?.status).toBe(403);
  });

  // Self-clearing: the user re-exported a good token and restarted the daemon.
  test('clears once a later request succeeds', () => {
    expect(unresolvedAuthRejection([rec(1, 401), rec(2, 200)])).toBeNull();
  });

  // INVARIANT: any ANSWERED non-auth status proves the request got past
  // authentication. Treating a 429 or a 500 as "still broken" would leave the
  // warning up through an unrelated outage and train the user to ignore it.
  test('a later 429 or 500 clears it — those got past auth', () => {
    expect(unresolvedAuthRejection([rec(1, 401), rec(2, 429)])).toBeNull();
    expect(unresolvedAuthRejection([rec(1, 401), rec(2, 500)])).toBeNull();
  });

  // INVARIANT: a request that never reached the upstream (status null — the
  // proxy could not connect) says nothing about the credential either way, so
  // it must neither raise nor clear the verdict.
  test('unreachable-upstream records are ignored entirely', () => {
    expect(unresolvedAuthRejection([rec(1, 401), rec(2, null)])?.status).toBe(401);
    expect(unresolvedAuthRejection([rec(1, null)])).toBeNull();
  });

  test('reports the most recent rejection when several are unresolved', () => {
    const verdict = unresolvedAuthRejection([rec(1, 401), rec(2, 401, { role: 'agent' })]);
    expect(verdict).toMatchObject({ ts: 2, role: 'agent' });
  });
});
