import { describe, test, expect, afterEach } from 'bun:test';
import {
  countTokens,
  countTokensBpe,
  countTokensViaApi,
  estimateTokensByChars,
  CHARS_PER_TOKEN_HEURISTIC,
  DEFAULT_BPE_ENCODING,
  DEFAULT_COUNT_TOKENS_MODEL,
} from '../../src/utils/token-count';

describe('token-count: offline BPE tier', () => {
  // Known counts, produced by the o200k_base / cl100k_base vocabularies. They
  // pin the vocabulary as much as the arithmetic: a wrong encoding still returns
  // a plausible-looking number, and only fixtures where the two vocabularies
  // disagree (the Japanese one below) can catch that.
  const fixtures: Array<{ text: string; o200k: number; cl100k: number }> = [
    { text: '', o200k: 0, cl100k: 0 },
    { text: ' ', o200k: 1, cl100k: 1 },
    { text: 'hello world', o200k: 2, cl100k: 2 },
    { text: 'The quick brown fox jumps over the lazy dog.', o200k: 10, cl100k: 10 },
    { text: '日本語のテキスト', o200k: 6, cl100k: 8 },
    { text: 'function add(a: number, b: number) { return a + b; }', o200k: 17, cl100k: 17 },
  ];

  for (const fixture of fixtures) {
    test(`o200k_base counts ${JSON.stringify(fixture.text)} as ${fixture.o200k}`, async () => {
      const result = await countTokensBpe(fixture.text, 'o200k_base');
      expect(result.tokens).toBe(fixture.o200k);
      expect(result.method).toBe('bpe');
      expect(result.encoding).toBe('o200k_base');
    });

    test(`cl100k_base counts ${JSON.stringify(fixture.text)} as ${fixture.cl100k}`, async () => {
      const result = await countTokensBpe(fixture.text, 'cl100k_base');
      expect(result.tokens).toBe(fixture.cl100k);
      expect(result.encoding).toBe('cl100k_base');
    });
  }

  test('defaults to o200k_base', async () => {
    const result = await countTokensBpe('hello world');
    expect(result.encoding).toBe(DEFAULT_BPE_ENCODING);
    expect(DEFAULT_BPE_ENCODING).toBe('o200k_base');
  });

  // INVARIANT: no offline tier may claim to be exact. Anthropic does not publish
  // its tokenizer, so every locally computed count is an approximation and must
  // say so — a caller deciding whether a figure is publishable reads this flag.
  test('offline counts are always marked approximate', async () => {
    const bpe = await countTokens('hello world');
    const chars = await countTokens('hello world', { method: 'chars' });
    expect(bpe.approximate).toBe(true);
    expect(chars.approximate).toBe(true);
  });
});

describe('token-count: chars/4 heuristic', () => {
  test('is the legacy divide-by-four estimate, rounded up', () => {
    expect(CHARS_PER_TOKEN_HEURISTIC).toBe(4);
    expect(estimateTokensByChars('')).toBe(0);
    expect(estimateTokensByChars('abcd')).toBe(1);
    expect(estimateTokensByChars('abcde')).toBe(2);
  });

  // INVARIANT: this is WHY the module exists. chars/4 charges every character
  // the same, while BPE charges short frequent words far less — so on ordinary
  // English prose chars/4 reports more tokens than a real tokenizer does, and a
  // compression experiment measured with it overstates its own saving.
  test('overstates token count on function-word-heavy prose', async () => {
    const prose =
      'The report that we sent to the team on the day of the review was the one ' +
      'that they had asked for, and it was the same as the one in the file.';
    const bpe = await countTokensBpe(prose);
    expect(estimateTokensByChars(prose)).toBeGreaterThan(bpe.tokens);
  });
});

describe('token-count: dispatch', () => {
  test('defaults to the offline BPE tier — no network, no credentials', async () => {
    const result = await countTokens('hello world');
    expect(result.method).toBe('bpe');
  });

  test('rejects an unknown method by name', async () => {
    await expect(
      countTokens('hi', { method: 'magic' as unknown as 'bpe' })
    ).rejects.toThrow(/Unknown token counting method: magic/);
  });
});

describe('token-count: Anthropic API tier', () => {
  const realFetch = globalThis.fetch;
  const envKeys = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'] as const;
  const saved = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));

  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const key of envKeys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  function stubFetch(handler: (url: string, init: RequestInit) => Response): Request[] {
    const seen: Request[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, init } as unknown as Request);
      return handler(url, init);
    }) as unknown as typeof fetch;
    return seen;
  }

  test('posts the text to count_tokens and returns the exact count', async () => {
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_API_KEY = 'sk-test';

    const seen = stubFetch(() => new Response(JSON.stringify({ input_tokens: 42 })));
    const result = await countTokensViaApi('hello world');

    expect(result).toEqual({
      tokens: 42,
      method: 'api',
      model: DEFAULT_COUNT_TOKENS_MODEL,
      approximate: false,
    });

    const call = seen[0] as unknown as { url: string; init: RequestInit };
    expect(call.url).toBe('https://api.anthropic.com/v1/messages/count_tokens');
    const headers = call.init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers.authorization).toBeUndefined();
    expect(JSON.parse(call.init.body as string)).toEqual({
      model: DEFAULT_COUNT_TOKENS_MODEL,
      messages: [{ role: 'user', content: 'hello world' }],
    });
  });

  // An OAuth token is not an API key: it goes as a bearer with the OAuth beta
  // header. Sending it as x-api-key is rejected by the API.
  test('sends an OAuth token as a bearer with the OAuth beta header', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_AUTH_TOKEN = 'oauth-token';

    const seen = stubFetch(() => new Response(JSON.stringify({ input_tokens: 7 })));
    await countTokensViaApi('hi', { model: 'claude-sonnet-5' });

    const call = seen[0] as unknown as { init: RequestInit };
    const headers = call.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer oauth-token');
    expect(headers['anthropic-beta']).toBe('oauth-2025-04-20');
    expect(headers['x-api-key']).toBeUndefined();
  });

  test('fails with an actionable message when no credential is present', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    await expect(countTokensViaApi('hi')).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  // INVARIANT: a failed remote count fails. It must never silently fall back to
  // an offline estimate — a caller asked for ground truth precisely because an
  // approximation was not good enough.
  test('surfaces a non-retryable HTTP error instead of estimating', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    stubFetch(() => new Response('bad model', { status: 400 }));
    await expect(countTokensViaApi('hi')).rejects.toThrow(/HTTP 400.*bad model/s);
  });

  test('retries a 429 honouring retry-after, then succeeds', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    let calls = 0;
    stubFetch(() => {
      calls++;
      return calls === 1
        ? new Response('slow down', { status: 429, headers: { 'retry-after': '0' } })
        : new Response(JSON.stringify({ input_tokens: 5 }));
    });

    const result = await countTokensViaApi('hi');
    expect(result.tokens).toBe(5);
    expect(calls).toBe(2);
  });
});
