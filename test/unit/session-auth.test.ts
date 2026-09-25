/**
 * The header-level rules behind the proxy swap, on their own.
 *
 * proxy-session-swap.test.ts covers the same rules end to end through a real
 * proxy; these pin the edges that are awkward to provoke over HTTP — odd
 * spacing, a lowercase scheme, a bare token with no scheme at all.
 */

import { describe, test, expect } from 'bun:test';
import {
  scanForPlaceholder,
  swapCredential,
  expectedFormFor,
  envVarForForm,
  denialMessage,
} from '../../src/proxy/session-auth';
import { SESSION_TOKEN_PREFIX } from '../../src/daemon/session-credentials';

const PLACEHOLDER = `${SESSION_TOKEN_PREFIX}abc123`;
const isPlaceholder = (t: string) => t.startsWith(SESSION_TOKEN_PREFIX);

describe('scanForPlaceholder', () => {
  test('finds a placeholder behind a Bearer scheme, however it is spelled', () => {
    for (const value of [`Bearer ${PLACEHOLDER}`, `bearer  ${PLACEHOLDER}`, ` Bearer ${PLACEHOLDER} `]) {
      const scan = scanForPlaceholder(new Headers({ authorization: value }), isPlaceholder);
      expect(scan.kind).toBe('one');
      expect(scan.kind === 'one' && scan.credential).toEqual({
        form: 'bearer', header: 'authorization', token: PLACEHOLDER,
      });
    }
  });

  test('finds a placeholder sent bare in Authorization, with no scheme', () => {
    const scan = scanForPlaceholder(new Headers({ authorization: PLACEHOLDER }), isPlaceholder);
    expect(scan.kind === 'one' && scan.credential.token).toBe(PLACEHOLDER);
  });

  test('finds a placeholder in x-api-key', () => {
    const scan = scanForPlaceholder(new Headers({ 'x-api-key': PLACEHOLDER }), isPlaceholder);
    expect(scan.kind === 'one' && scan.credential).toEqual({
      form: 'x-api-key', header: 'x-api-key', token: PLACEHOLDER,
    });
  });

  // INVARIANT: a real credential is not lazy's business. This is the branch
  // every single-user request takes.
  test('reports none for real credentials', () => {
    expect(scanForPlaceholder(new Headers({ authorization: 'Bearer sk-ant-oat-real' }), isPlaceholder).kind)
      .toBe('none');
    expect(scanForPlaceholder(new Headers({ 'x-api-key': 'sk-ant-api-real' }), isPlaceholder).kind)
      .toBe('none');
    expect(scanForPlaceholder(new Headers(), isPlaceholder).kind).toBe('none');
  });

  // INVARIANT: never guess. Swapping one would send the other upstream unswapped.
  test('reports ambiguous when both headers carry a placeholder', () => {
    const scan = scanForPlaceholder(
      new Headers({ authorization: `Bearer ${PLACEHOLDER}`, 'x-api-key': `${SESSION_TOKEN_PREFIX}other` }),
      isPlaceholder,
    );
    expect(scan.kind).toBe('ambiguous');
  });
});

describe('swapCredential', () => {
  // INVARIANT: the value changes, the header shape does not.
  test('rewrites only the value, keeping the Bearer scheme', () => {
    const headers = new Headers({ authorization: `Bearer ${PLACEHOLDER}`, 'anthropic-version': '2023-06-01' });
    swapCredential(headers, { form: 'bearer', header: 'authorization', token: PLACEHOLDER }, 'real-secret');
    expect(headers.get('authorization')).toBe('Bearer real-secret');
    expect(headers.get('x-api-key')).toBeNull();
    expect(headers.get('anthropic-version')).toBe('2023-06-01');
  });

  test('rewrites x-api-key without introducing an Authorization header', () => {
    const headers = new Headers({ 'x-api-key': PLACEHOLDER });
    swapCredential(headers, { form: 'x-api-key', header: 'x-api-key', token: PLACEHOLDER }, 'real-secret');
    expect(headers.get('x-api-key')).toBe('real-secret');
    expect(headers.get('authorization')).toBeNull();
  });
});

describe('kind ↔ form mapping', () => {
  // KIND MIRRORING, stated once: this pairing is what makes the swap possible.
  test('oauth is Bearer and api-key is x-api-key', () => {
    expect(expectedFormFor('oauth')).toBe('bearer');
    expect(expectedFormFor('api-key')).toBe('x-api-key');
    expect(envVarForForm('bearer')).toBe('CLAUDE_CODE_OAUTH_TOKEN');
    expect(envVarForForm('x-api-key')).toBe('ANTHROPIC_API_KEY');
  });
});

describe('denialMessage', () => {
  test('never echoes a token', () => {
    const messages = [
      denialMessage('unknown_session_token'),
      denialMessage('auth_kind_mismatch', `user alice holds an oauth credential`),
    ];
    for (const m of messages) expect(m).not.toContain(SESSION_TOKEN_PREFIX);
    expect(messages[1]).toContain('alice');
  });
});
