/**
 * The proxy's forwarding-surface allowlist.
 *
 * This file encodes a SECURITY POSTURE, not merely current behavior: the proxy
 * is lazy's audit and policy plane for agent traffic, and a granted agent must
 * not be able to ride it to an upstream's administrative endpoints. Every test
 * below carries the invariant it protects — do not relax one to make a new
 * surface pass; add the surface to PROXY_ALLOWED_ROUTES with its reason instead.
 */

import { describe, test, expect } from 'bun:test';
import {
  decideProxyPath,
  pathRefusalMessage,
  pathRefusalBody,
  PROXY_ALLOWED_ROUTES,
} from '../../src/proxy/path-allowlist';

describe('decideProxyPath — the model API surface', () => {
  test('allows POST /v1/messages on both tiers', () => {
    expect(decideProxyPath('POST', '/v1/messages', 'primary')).toEqual({ allowed: true });
    expect(decideProxyPath('POST', '/v1/messages', 'role')).toEqual({ allowed: true });
  });

  test('allows POST /v1/messages/count_tokens on both tiers', () => {
    expect(decideProxyPath('POST', '/v1/messages/count_tokens', 'primary')).toEqual({ allowed: true });
    expect(decideProxyPath('POST', '/v1/messages/count_tokens', 'role')).toEqual({ allowed: true });
  });

  // INVARIANT: Claude Code probes ANTHROPIC_BASE_URL unauthenticated with
  // HEAD /api/hello. Refusing it would report the endpoint as DOWN — the same
  // failure mode the proxy's "never 401 an unauthenticated probe" rule exists
  // to avoid. It stays allowed on BOTH tiers.
  test('allows the HEAD /api/hello reachability probe on both tiers', () => {
    expect(decideProxyPath('HEAD', '/api/hello', 'primary')).toEqual({ allowed: true });
    expect(decideProxyPath('HEAD', '/api/hello', 'role')).toEqual({ allowed: true });
    expect(decideProxyPath('GET', '/api/hello', 'primary')).toEqual({ allowed: true });
  });

  test('allows read-only model discovery on the primary, including sub-paths', () => {
    expect(decideProxyPath('GET', '/v1/models', 'primary')).toEqual({ allowed: true });
    expect(decideProxyPath('GET', '/v1/models/claude-opus-5', 'primary')).toEqual({ allowed: true });
  });
});

describe('decideProxyPath — refusals', () => {
  // INVARIANT: the whole reason this allowlist exists. A role upstream can be a
  // local ollama server whose admin surface sits next to its inference surface;
  // a task agent holds a grant that routes there. These paths must never be
  // forwarded, on EITHER tier.
  test.each([
    ['POST', '/api/pull'],
    ['DELETE', '/api/delete'],
    ['POST', '/api/create'],
    ['GET', '/api/ps'],
    ['POST', '/api/push'],
    ['GET', '/api/tags'],
  ])('refuses ollama admin endpoint %s %s', (method, path) => {
    expect(decideProxyPath(method, path, 'role')).toEqual({
      allowed: false,
      reason: 'unlisted-path',
    });
    expect(decideProxyPath(method, path, 'primary')).toEqual({
      allowed: false,
      reason: 'unlisted-path',
    });
  });

  // INVARIANT: a role upstream gets INFERENCE AND NOTHING ELSE. Model discovery
  // is allowed against Anthropic (documented, read-only, an SDK resolves aliases
  // with it) but not against a user's local model server, where it is inventory
  // disclosure with no inference need behind it.
  test('refuses model discovery on a role upstream but allows it on the primary', () => {
    expect(decideProxyPath('GET', '/v1/models', 'role')).toEqual({
      allowed: false,
      reason: 'role-upstream-restricted',
    });
    expect(decideProxyPath('GET', '/v1/models', 'primary')).toEqual({ allowed: true });
  });

  // INVARIANT: the allowlist is (method, path), not path alone. A listed path
  // reached with an unlisted verb is a different operation on most servers.
  test('refuses an allowed path reached with a disallowed method', () => {
    expect(decideProxyPath('DELETE', '/v1/messages', 'primary')).toEqual({
      allowed: false,
      reason: 'method-not-allowed',
    });
    expect(decideProxyPath('GET', '/v1/messages', 'primary')).toEqual({
      allowed: false,
      reason: 'method-not-allowed',
    });
    expect(decideProxyPath('POST', '/v1/models', 'primary')).toEqual({
      allowed: false,
      reason: 'method-not-allowed',
    });
  });

  test('refuses an unrelated path outright', () => {
    expect(decideProxyPath('GET', '/', 'primary').allowed).toBe(false);
    expect(decideProxyPath('POST', '/v1/complete', 'primary').allowed).toBe(false);
    expect(decideProxyPath('GET', '/v1/organizations/usage_report', 'primary').allowed).toBe(false);
  });

  // INVARIANT: matching is on the NORMALISED pathname. `URL` collapses dot
  // segments before the server calls in, so a traversal that resolves to an
  // admin endpoint is judged as that endpoint — asserted here at the same seam
  // the server uses so a future refactor cannot reintroduce the bypass.
  test('a dot-segment traversal is judged by where it resolves', () => {
    const pathname = new URL('http://x/v1/messages/../../api/pull').pathname;
    expect(pathname).toBe('/api/pull');
    expect(decideProxyPath('POST', pathname, 'role').allowed).toBe(false);
  });

  test('a prefix entry does not leak to a sibling path', () => {
    // /v1/models is a prefix entry — it must not admit /v1/modelsomething.
    expect(decideProxyPath('GET', '/v1/modelsomething', 'primary').allowed).toBe(false);
  });
});

describe('decideProxyPath — matching details', () => {
  test('is case-insensitive on the method only', () => {
    expect(decideProxyPath('post', '/v1/messages', 'primary')).toEqual({ allowed: true });
    // Paths are case-SENSITIVE: upstreams treat them that way, and folding case
    // here would admit spellings the upstream routes differently.
    expect(decideProxyPath('POST', '/V1/Messages', 'primary').allowed).toBe(false);
  });

  test('tolerates a trailing slash', () => {
    expect(decideProxyPath('POST', '/v1/messages/', 'primary')).toEqual({ allowed: true });
  });
});

describe('refusal surfacing', () => {
  // CLAUDE.md: errors are for humans — say what happened, with the actual values.
  test('the message names the refused method, path, and the rule', () => {
    const msg = pathRefusalMessage('POST', '/api/pull', 'role', 'unlisted-path');
    expect(msg).toContain('POST /api/pull');
    expect(msg).toContain('model API');
    expect(msg).toContain('/api/pull');
    // Points at the remedy: the list is source, not a config knob.
    expect(msg).toContain('PROXY_ALLOWED_ROUTES');
    expect(msg).toContain('src/proxy/path-allowlist.ts');
  });

  test('the message lists only the routes that tier actually forwards', () => {
    // Read the "Forwarded to …" section, not the whole message: the refused
    // path itself is quoted in the first line by design.
    const listOf = (msg: string) => msg.split('Forwarded to')[1]!.split('\n\n')[0]!;
    const roleMsg = pathRefusalMessage('GET', '/v1/models', 'role', 'role-upstream-restricted');
    expect(listOf(roleMsg)).toContain('POST /v1/messages');
    expect(listOf(roleMsg)).not.toContain('GET /v1/models');
    const primaryMsg = pathRefusalMessage('POST', '/api/pull', 'primary', 'unlisted-path');
    expect(listOf(primaryMsg)).toContain('GET /v1/models');
  });

  test('the body is an Anthropic-shaped permission error', () => {
    const parsed = JSON.parse(pathRefusalBody('nope')) as Record<string, unknown>;
    expect(parsed.type).toBe('error');
    expect(parsed.error).toEqual({ type: 'permission_error', message: 'nope' });
  });
});

// INVARIANT: the allowlist is DATA with a stated reason per entry. A drive-by
// addition is meant to be a visible, reviewable diff — this test fails when the
// surface grows, which is the point: growing it should require saying so.
test('the forwarding surface is exactly the reviewed set', () => {
  expect(
    PROXY_ALLOWED_ROUTES.map((r) => `${r.methods.join('/')} ${r.path}${r.prefix ? '/*' : ''}${r.onRoleUpstream ? ' [role]' : ''}`),
  ).toEqual([
    'POST /v1/messages [role]',
    'POST /v1/messages/count_tokens [role]',
    'HEAD/GET /api/hello [role]',
    'GET /v1/models/*',
  ]);
});
