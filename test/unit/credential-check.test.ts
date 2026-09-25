/**
 * The ACTIVE credential check: "test this credential now", as opposed to the
 * passive verdict read off the audit trail.
 *
 * INVARIANT: a rejected credential is an ANSWER, not an error. Every outcome
 * here — accepted, refused, nothing stored, upstream unreachable — comes back
 * as a result a human can act on. Collapsing "we asked and the answer is no"
 * into "we could not ask" is the exact confusion this check exists to remove:
 * telling somebody their token is dead because the network was down is worse
 * than saying nothing.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';
import { checkUserCredential } from '../../src/daemon/credential-check';
import {
  handleCheckUserCredential,
  handleListUserCredentials,
} from '../../src/daemon/rpc-handlers';
import { clearUserCredentialCache, putUserCredential } from '../../src/daemon/user-credentials';

const CONTROL = { kind: 'control' } as const;
const USER = { kind: 'user', email: 'ada@example.com', name: 'Ada' } as const;

const SECRET = 'sk-ant-oat-super-secret';

/** A fetch that answers with one canned status, and records what it was sent. */
function stubFetch(status: number, body = '{}') {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return new Response(body, { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** A fetch that cannot reach anything. */
function failingFetch(message: string) {
  return (async () => {
    throw new Error(message);
  }) as unknown as typeof fetch;
}

describe('checkUserCredential', () => {
  let root: string;
  let base: string;
  let unpin: () => void;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-credcheck-'));
    base = await mkdtemp(join(tmpdir(), 'lzd-credcheck-'));
    unpin = pinDaemonBaseDir(base);
    clearUserCredentialCache();
  });

  afterEach(async () => {
    unpin();
    clearUserCredentialCache();
    await rm(root, { recursive: true, force: true });
    await rm(base, { recursive: true, force: true });
  });

  async function store(kind: 'oauth' | 'api-key', token = SECRET): Promise<void> {
    await putUserCredential(root, { userId: 'ada', kind, token, label: 'ada@example.com' });
  }

  // Nothing stored is a distinct answer from a stored token that was refused:
  // one is fixed by pasting a token, the other by pasting a DIFFERENT token.
  test('reports no-credential without asking the upstream anything', async () => {
    const { impl, calls } = stubFetch(200);

    const result = await checkUserCredential(root, 'ada', { fetchImpl: impl });

    expect(result.outcome).toBe('no-credential');
    expect(result.ok).toBe(false);
    expect(result.status).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test('a credential the upstream accepts comes back ok', async () => {
    await store('api-key');
    const { impl, calls } = stubFetch(200);

    const result = await checkUserCredential(root, 'ada', { fetchImpl: impl });

    expect(result.outcome).toBe('ok');
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.kind).toBe('api-key');
    // Model listing: auth-only, no model name, nothing billed.
    expect(calls[0]!.url).toContain('/v1/models');
    expect(calls[0]!.headers['x-api-key']).toBe(SECRET);
  });

  test('OAuth probes count_tokens because setup-tokens are model-requests-only', async () => {
    await store('oauth');
    const { impl, calls } = stubFetch(200);

    const result = await checkUserCredential(root, 'ada', { fetchImpl: impl });

    expect(result.outcome).toBe('ok');
    expect(calls[0]!.url).toContain('/v1/messages/count_tokens');
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${SECRET}`);
  });

  test('a refused credential is a result, not a thrown error', async () => {
    await store('oauth');
    const { impl } = stubFetch(401, '{"error":{"message":"invalid bearer token"}}');

    const result = await checkUserCredential(root, 'ada', { fetchImpl: impl });

    expect(result.outcome).toBe('rejected');
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    // Actionable, and quoting what the upstream actually said.
    expect(result.detail).toContain('invalid bearer token');
    expect(result.detail).toMatch(/replace it/i);
    // Also offered on its own, for a caller that phrases the sentence itself.
    expect(result.upstreamError).toContain('invalid bearer token');
  });

  test('403 is a rejection too', async () => {
    await store('api-key');
    const { impl } = stubFetch(403);
    expect((await checkUserCredential(root, 'ada', { fetchImpl: impl })).outcome).toBe('rejected');
  });

  // INVARIANT: an unreachable upstream is never reported as a bad credential.
  test('an unreachable upstream says so, and says it proves nothing', async () => {
    await store('oauth');

    const result = await checkUserCredential(root, 'ada', {
      fetchImpl: failingFetch('connect ECONNREFUSED'),
    });

    expect(result.outcome).toBe('unreachable');
    expect(result.status).toBeNull();
    expect(result.detail).toContain('connect ECONNREFUSED');
    expect(result.detail).toMatch(/says nothing about whether the credential is valid/i);
  });

  // A 429 got PAST authentication — a pass for the question asked, not an error.
  test('an answered non-auth status is a successful credential check', async () => {
    await store('api-key');
    const { impl } = stubFetch(429);

    const result = await checkUserCredential(root, 'ada', { fetchImpl: impl });

    expect(result.outcome).toBe('ok');
    expect(result.ok).toBe(true);
    expect(result.status).toBe(429);
    expect(result.detail).toMatch(/not an authentication failure/i);
  });

  // INVARIANT: a retired probe model must not look like a bad credential.
  test('a model not_found_error is ok with a probe-outdated caveat', async () => {
    await store('oauth');
    const body =
      '{"type":"error","error":{"type":"not_found_error","message":"model: claude-3-5-haiku-20241022"}}';
    const { impl } = stubFetch(404, body);

    const result = await checkUserCredential(root, 'ada', { fetchImpl: impl });

    expect(result.outcome).toBe('ok');
    expect(result.ok).toBe(true);
    expect(result.status).toBe(404);
    expect(result.detail).toMatch(/probe model is outdated/i);
    expect(result.upstreamError).toContain('not_found_error');
  });

  /**
   * The kind decides the header shape, and a mismatch is answered by a 401 that
   * looks exactly like an expired token. The probe must present the credential
   * the same way a real turn does, or a passing check proves nothing.
   */
  describe('header shape mirrors the credential kind', () => {
    test('an API key goes as x-api-key', async () => {
      await store('api-key');
      const { impl, calls } = stubFetch(200);

      await checkUserCredential(root, 'ada', { fetchImpl: impl });

      expect(calls[0]!.headers['x-api-key']).toBe(SECRET);
      expect(calls[0]!.headers.authorization).toBeUndefined();
    });

    test('an OAuth setup-token goes as a bearer with the OAuth beta header', async () => {
      await store('oauth');
      const { impl, calls } = stubFetch(200);

      await checkUserCredential(root, 'ada', { fetchImpl: impl });

      expect(calls[0]!.headers.authorization).toBe(`Bearer ${SECRET}`);
      expect(calls[0]!.headers['anthropic-beta']).toContain('oauth');
      expect(calls[0]!.headers['x-api-key']).toBeUndefined();
    });
  });

  test('the result never carries the secret', async () => {
    await store('oauth');
    const { impl } = stubFetch(401, `refused ${SECRET}`);

    const result = await checkUserCredential(root, 'ada', { fetchImpl: impl });

    expect(JSON.stringify(result)).not.toContain(SECRET);
    // Including the field a UI is most likely to render on its own.
    expect(result.upstreamError).not.toContain(SECRET);
  });

  /**
   * The active check and the passive verdict must not contradict each other.
   * A check IS an upstream request made on that owner's credential, so it is
   * recorded on the same audit trail the verdict is derived from — one source
   * of truth, self-clearing by the ordinary rule rather than by a reset.
   */
  describe('agrees with the passive per-owner verdict', () => {
    test('a passing check clears a standing rejection', async () => {
      await store('api-key');
      // A turn of theirs was refused after the credential was stored, so the
      // listing condemns it — this is the case the timestamp rule cannot fix.
      await checkUserCredential(root, 'ada', { fetchImpl: stubFetch(401).impl });
      const condemned = await handleListUserCredentials(root, CONTROL);
      expect(condemned.credentials[0]!.rejection).toMatchObject({ status: 401 });

      await checkUserCredential(root, 'ada', { fetchImpl: stubFetch(200).impl });

      const cleared = await handleListUserCredentials(root, CONTROL);
      expect(cleared.credentials[0]!.rejection).toBeNull();
    });

    test('a probe-rot 404 clears a standing rejection too', async () => {
      await store('oauth');
      await checkUserCredential(root, 'ada', { fetchImpl: stubFetch(401).impl });
      expect((await handleListUserCredentials(root, CONTROL)).credentials[0]!.rejection).not.toBeNull();

      const body =
        '{"type":"error","error":{"type":"not_found_error","message":"model: claude-3-5-haiku-20241022"}}';
      await checkUserCredential(root, 'ada', { fetchImpl: stubFetch(404, body).impl });

      expect((await handleListUserCredentials(root, CONTROL)).credentials[0]!.rejection).toBeNull();
    });

    // An unreachable upstream must not condemn anyone — same rule the proxy
    // applies to a request that never got an answer.
    test('an unreachable check raises no rejection', async () => {
      await store('api-key');

      await checkUserCredential(root, 'ada', { fetchImpl: failingFetch('ETIMEDOUT') });

      const listed = await handleListUserCredentials(root, CONTROL);
      expect(listed.credentials[0]!.rejection).toBeNull();
    });
  });

  /**
   * INVARIANT: credential RPCs are control-plane only. The answer names whose
   * credential it is, and a user token's holder is the subject of this data
   * rather than its administrator.
   */
  test('the RPC refuses a user token', async () => {
    await store('oauth');
    await expect(handleCheckUserCredential(root, { userId: 'ada' }, USER)).rejects.toThrow(
      /control-plane/i,
    );
  });

  test('the RPC needs a userId', async () => {
    await expect(handleCheckUserCredential(root, {}, CONTROL)).rejects.toThrow(/userId/i);
  });
});
