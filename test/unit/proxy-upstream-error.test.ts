import { describe, expect, test } from 'bun:test';
import {
  UPSTREAM_ERROR_EXCERPT_MAX,
  credentialValuesIn,
  upstreamErrorExcerpt,
} from '../../src/proxy/upstream-error';
import { REDACTED } from '../../src/utils/redact';

describe('upstreamErrorExcerpt', () => {
  test('Anthropic error envelope → type and message', () => {
    const body = JSON.stringify({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'adaptive thinking is not supported on this model' },
    });
    expect(upstreamErrorExcerpt(body)).toBe(
      'upstream: invalid_request_error: adaptive thinking is not supported on this model',
    );
  });

  test('OpenAI envelope with a code and no type', () => {
    const body = JSON.stringify({ error: { code: 'model_not_found', message: 'no such model' } });
    expect(upstreamErrorExcerpt(body)).toBe('upstream: model_not_found: no such model');
  });

  test('non-JSON body falls back to the raw text, whitespace collapsed', () => {
    expect(upstreamErrorExcerpt('<html>\n  <b>Bad gateway</b>\n</html>')).toBe(
      'upstream: <html> <b>Bad gateway</b> </html>',
    );
  });

  test('empty body → null', () => {
    expect(upstreamErrorExcerpt('  ')).toBeNull();
  });

  // INVARIANT: the excerpt is bounded — the body is the upstream's, and a huge
  // error page must never land in the audit log whole.
  test('long bodies are truncated', () => {
    const out = upstreamErrorExcerpt('x'.repeat(10_000))!;
    expect(out.length).toBe(UPSTREAM_ERROR_EXCERPT_MAX + 1);
    expect(out.endsWith('…')).toBe(true);
  });

  // INVARIANT: a credential the request carried never survives into the
  // excerpt, even when the upstream echoes it back. A per-member secret is
  // not in the daemon's environment, so the audit log's own scrub cannot
  // catch it, and the live Watch stream sees the excerpt before that scrub.
  test('credential values are redacted, even past the truncation bound', () => {
    const secret = 'sk-ant-oat01-SECRETSECRETSECRET';
    const echo = JSON.stringify({ error: { type: 'authentication_error', message: `bad token ${secret}` } });
    expect(upstreamErrorExcerpt(echo, [secret])).toBe(`upstream: authentication_error: bad token ${REDACTED}`);
    // A secret straddling the bound must not leave a prefix behind.
    const long = `${'x'.repeat(UPSTREAM_ERROR_EXCERPT_MAX - 15)} ${secret}`;
    expect(upstreamErrorExcerpt(long, [secret])).not.toContain('sk-ant-oat01-SEC');
  });
});

describe('credentialValuesIn', () => {
  test('bearer token and api key, whole header before its token', () => {
    const tok = 'tok-0123456789abcdef';
    const key = 'key-0123456789abcdef';
    const h = new Headers({ authorization: `Bearer ${tok}`, 'x-api-key': key });
    const values = credentialValuesIn(h);
    expect(values[0]).toBe(`Bearer ${tok}`);
    expect(new Set(values)).toEqual(new Set([`Bearer ${tok}`, tok, key]));
  });

  // INVARIANT: the scrub set comes from the proxy's own credential-header
  // list, so every header the proxy treats as a credential is scrubbed —
  // a second list here once missed the Cursor and Azure-style keys.
  test('covers x-cursor-api-key and api-key', () => {
    const cur = 'cursor-0123456789abcdef';
    const az = 'azure-0123456789abcdef';
    const h = new Headers({ 'x-cursor-api-key': cur, 'api-key': az });
    expect(new Set(credentialValuesIn(h))).toEqual(new Set([cur, az]));
  });

  // INVARIANT: lazy's own dummy credential is not scrubbed, but any other value
  // is, however short. A local-backend launch
  // sends `Bearer ollama`; scrubbing it would redact every "ollama" in an
  // Ollama error — the local-model failure this excerpt exists to explain.
  test('the local-backend dummy is not scrubbed; a short real key is', () => {
    const dummy = credentialValuesIn(new Headers({ authorization: 'Bearer ollama' }));
    expect(dummy).toEqual([]);
    const body = JSON.stringify({ error: { type: 'not_found_error', message: 'model not found, try pulling it first with ollama pull' } });
    expect(upstreamErrorExcerpt(body, dummy)).toContain('ollama pull');
    const real = 'sk-1234';
    const echoed = JSON.stringify({ error: { message: `bad ${real}` } });
    expect(upstreamErrorExcerpt(echoed, credentialValuesIn(new Headers({ 'x-api-key': real })))).not.toContain(real);
  });

  test('no credential headers → empty', () => {
    expect(credentialValuesIn(new Headers())).toEqual([]);
  });
});
