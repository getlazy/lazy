import { describe, expect, test } from 'bun:test';
import { assertTokenIssuedBy } from '../../src/teams/token-origin';

function jwt(iss: string): string {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'RS256' })}.${enc({ iss, tok: 'x' })}.sig`;
}

function refusal(token: string, typed: string): string {
  try {
    assertTokenIssuedBy(token, typed, true);
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('expected a refusal');
}

describe('assertTokenIssuedBy', () => {
  test('accepts a token issued by the typed address', () => {
    expect(() => assertTokenIssuedBy(jwt('https://r.example.dev'), 'https://r.example.dev', true)).not.toThrow();
  });

  test('a scheme-only mismatch names APP_PROTOCOL=https and never advises http', () => {
    // INVARIANT: an install behind a TLS-terminating proxy that calls itself http
    // is still refused (the check stays strict), and the remedy is the operator's
    // setting — lazy never tells a person to log in over plain http.
    const message = refusal(jwt('http://r.example.dev'), 'https://r.example.dev');
    expect(message).toContain('public address is set to http');
    expect(message).toContain('APP_PROTOCOL=https');
    expect(message).not.toContain('lazy login http://');
    expect(message).not.toContain('impersonating');
  });

  test('typed http against an https issuer points at the https address', () => {
    const message = refusal(jwt('https://r.example.dev'), 'http://r.example.dev');
    expect(message).toContain('lazy login https://r.example.dev');
    expect(message).not.toContain('APP_PROTOCOL=http');
  });

  test('a different host is still refused as possible impersonation', () => {
    // INVARIANT: the issuer check refuses any other origin; the scheme-only
    // message must never apply to a different host or port.
    expect(refusal(jwt('https://evil.example'), 'https://r.example.dev')).toContain('impersonating');
    expect(refusal(jwt('http://r.example.dev:8080'), 'https://r.example.dev')).toContain('impersonating');
  });
});
