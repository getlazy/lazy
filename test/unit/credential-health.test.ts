/**
 * INVARIANT (fix-fatal-failure-silent-park): every credential lazy bills has a
 * visible health, not only one that ever produced a usage reading. A ChatGPT
 * session whose refresh was refused fails every request inside the proxy and
 * never reaches an upstream, so it never produced a reading and appeared
 * nowhere. Failures self-clear on the next answered request on that credential.
 */
import { describe, test, expect } from 'bun:test';
import { unresolvedCredentialFailures } from '../../src/proxy/credential-health';
import type { ProxyAuditRecord } from '../../src/storage/types';
import { unresolvedAuthRejectionsByUser } from '../../src/proxy/auth-verdict';

function rec(over: Partial<ProxyAuditRecord>): ProxyAuditRecord {
  return { id: 'x', seq: 0, ts: 1, role: 'agent', taskId: 't', backend: 'proxy', upstream: 'https://chatgpt.com',
    method: 'POST', path: '/', endpoint: 'other', model: null, tier: null, stream: null, requestShape: null,
    toolUses: [], toolResults: [], status: 200, usage: null, stopReason: null, error: null, durationMs: 1,
    reroute: null, enforcement: null, ...over } as ProxyAuditRecord;
}

describe('unresolvedCredentialFailures', () => {
  test('a proxy refusal marks the credential unusable; a later success clears it', () => {
    const refused = rec({ ts: 10, status: 401, error: 'credential refused: refresh_token_reused',
      refusedCredential: { key: 'k1', userId: 'a@x', profile: 'builtin:chatgpt' } });
    expect(unresolvedCredentialFailures([refused])).toEqual([expect.objectContaining({
      credential: 'k1', userId: 'a@x', profile: 'builtin:chatgpt', unusable: true, failedAt: 10,
    })]);
    expect(unresolvedCredentialFailures([refused, rec({ ts: 20, credential: 'k1', status: 429 })])).toEqual([]);
  });

  test('one credential failing says nothing about another, and unanswered records are no evidence', () => {
    const out = unresolvedCredentialFailures([
      rec({ credential: 'k1', status: 403, error: 'forbidden' }),
      rec({ credential: 'k2', status: 200 }),
      rec({ credential: 'k1', status: null }),
    ]);
    expect(out.map(f => [f.credential, f.unusable])).toEqual([['k1', false]]);
  });

  // INVARIANT: a proxy refusal is never read as a member's Claude-token
  // rejection (it names the credential only in its own field).
  test('a refusal does not count as a Claude-token rejection', () => {
    const refused = rec({ ts: 10, status: 401, error: 'credential refused: no binding',
      refusedCredential: { key: 'user:a@x', userId: 'a@x', profile: null } });
    expect(unresolvedAuthRejectionsByUser([refused]).size).toBe(0);
  });

  test('solo mode: a success keyed by label clears a refusal keyed by upstream', () => {
    const refused = rec({ ts: 10, status: 401, upstream: 'https://chatgpt.com/backend-api/codex', error: 'credential refused: x',
      refusedCredential: { key: 'upstream:https://chatgpt.com', userId: null, profile: null } });
    const ok = rec({ ts: 20, status: 200, upstream: 'https://chatgpt.com/backend-api/codex', credential: 'credential:ChatGPT subscription' });
    expect(unresolvedCredentialFailures([refused])).toHaveLength(1);
    expect(unresolvedCredentialFailures([refused, ok])).toEqual([]);
  });
});

describe('a refusal is cleared only by its own credential', () => {
  // INVARIANT: a refusal that NAMES a credential is cleared by that credential's
  // own success, never by another account's at the same upstream origin: with
  // two accounts at one origin, Y working says nothing about X.
  test('another credential\'s success for the same user and origin does not clear it', () => {
    const refused = rec({ ts: 10, status: 401, error: 'credential refused: x', userId: 'a@x',
      refusedCredential: { key: 'credential:member-endpoint:X', userId: 'a@x', profile: 'codex-x' } });
    const otherOk = rec({ ts: 20, status: 200, userId: 'a@x', credential: 'credential:member-endpoint:Y' });
    expect(unresolvedCredentialFailures([refused, otherOk]).map(f => f.credential)).toEqual(['credential:member-endpoint:X']);
    const sameOk = rec({ ts: 30, status: 200, userId: 'a@x', credential: 'credential:member-endpoint:X' });
    expect(unresolvedCredentialFailures([refused, otherOk, sameOk])).toEqual([]);
  });
});

describe('a transient 503 is no evidence', () => {
  // INVARIANT: the proxy's own 503 for a credential it could not resolve right
  // now was never answered by an upstream, so it neither marks nor clears a
  // failure — otherwise a token-server blip would hide a still-broken session.
  test('a 503 credential-unavailable record does not clear a standing refusal', () => {
    const refused = rec({ ts: 10, status: 401, upstream: 'https://chatgpt.com/backend-api/codex', error: 'credential refused: refresh_token_reused',
      refusedCredential: { key: 'upstream:https://chatgpt.com', userId: null, profile: null } });
    const blip = rec({ ts: 20, status: 503, upstream: 'https://chatgpt.com/backend-api/codex', error: 'credential unavailable: timed out' });
    expect(unresolvedCredentialFailures([refused, blip]).map(f => f.credential)).toEqual(['upstream:https://chatgpt.com']);
  });
});
