/**
 * Token counting with explicit fidelity tiers.
 *
 * WHY: every token figure lazy computed locally used the chars/4 heuristic.
 * That heuristic is uniform — it charges the same 0.25 tokens per character to
 * every character — while real BPE charges far less for the short, frequent
 * function words ("the", "of", "is") that compression experiments tend to drop.
 * Measuring such an experiment with chars/4 therefore systematically OVERSTATES
 * its saving. Anything claiming a token saving must use a real tokenizer.
 *
 * Anthropic does not publish its tokenizer, so there are three tiers and the
 * caller picks one deliberately:
 *
 *   'bpe'    (default) — a real BPE tokenizer (OpenAI's o200k/cl100k vocabularies
 *              via gpt-tokenizer, pure JS, no native modules). Offline, free,
 *              deterministic. It is an APPROXIMATION of Anthropic's tokenizer:
 *              it undercounts Claude by roughly 15-20% on ordinary prose and by
 *              more on code and non-English text. That bias is broadly uniform
 *              across a corpus, so ratios and A/B deltas — "did dropping
 *              function words actually help?" — survive it; absolute counts do
 *              not. Never publish an absolute Claude token count from this tier.
 *   'api'    — Anthropic's POST /v1/messages/count_tokens. Ground truth, free,
 *              but needs network and credentials, and counts are model-specific.
 *              Opt-in only: never a default, never a dependency of an offline
 *              bench. Use it to calibrate a figure before publishing it.
 *   'chars'  — the chars/4 heuristic, kept ONLY so tools can show what the old
 *              method would have claimed next to the real number. Do not use it
 *              to produce a figure.
 */

/** Which tokenizer produced a count. */
// The proxy's module is a leaf (no imports of its own), so taking the flag from
// there costs nothing and keeps one spelling.
import { ANTHROPIC_OAUTH_BETA } from '../proxy/target-credentials';

export type TokenCountMethod = 'bpe' | 'api' | 'chars';

/** BPE vocabularies available offline. */
export type BpeEncoding = 'o200k_base' | 'cl100k_base';

/** Default offline vocabulary — the newest OpenAI BPE, closest in spirit to current Claude tokenizers. */
export const DEFAULT_BPE_ENCODING: BpeEncoding = 'o200k_base';

/** Divisor of the legacy heuristic this module exists to replace. */
export const CHARS_PER_TOKEN_HEURISTIC = 4;

/** Model used when the API tier is asked for a count without one. Counts are model-specific. */
export const DEFAULT_COUNT_TOKENS_MODEL = 'claude-opus-5';

export interface TokenCountResult {
  /** Token count. */
  tokens: number;
  /** Tier that produced it. */
  method: TokenCountMethod;
  /** Vocabulary used, for the 'bpe' tier. */
  encoding?: BpeEncoding;
  /** Model the count is for, for the 'api' tier. */
  model?: string;
  /**
   * True when the number only approximates what Claude would charge. Only the
   * 'api' tier is exact; both offline tiers are approximations.
   */
  approximate: boolean;
}

export interface CountTokensOptions {
  /** Fidelity tier. Defaults to 'bpe' — offline, no credentials, no network. */
  method?: TokenCountMethod;
  /** Vocabulary for the 'bpe' tier. Defaults to o200k_base. */
  encoding?: BpeEncoding;
  /** Model for the 'api' tier. Defaults to claude-opus-5. */
  model?: string;
  /** Base URL for the 'api' tier. Defaults to $ANTHROPIC_BASE_URL or the public API. */
  baseUrl?: string;
  /** Credential for the 'api' tier. Defaults to $ANTHROPIC_API_KEY / $ANTHROPIC_AUTH_TOKEN. */
  apiKey?: string;
}

/**
 * The chars/4 heuristic, for side-by-side comparison only.
 *
 * Exported so tools can show what the old method would have claimed. It is not
 * a counting method anyone should choose for a real figure.
 */
export function estimateTokensByChars(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN_HEURISTIC);
}

/**
 * Count with a real BPE tokenizer, offline.
 *
 * The encoding tables are loaded on first use via dynamic import (each is a few
 * MB of rank data), so importing this module costs nothing until someone counts.
 */
export async function countTokensBpe(
  text: string,
  encoding: BpeEncoding = DEFAULT_BPE_ENCODING
): Promise<TokenCountResult> {
  const encode = await loadEncoder(encoding);
  return {
    tokens: encode(text).length,
    method: 'bpe',
    encoding,
    approximate: true,
  };
}

type Encoder = (text: string) => number[];
const encoderCache = new Map<BpeEncoding, Promise<Encoder>>();
/** Encoders whose rank tables have finished loading — the sync tier's backing store. */
const readyEncoders = new Map<BpeEncoding, Encoder>();

async function loadEncoder(encoding: BpeEncoding): Promise<Encoder> {
  let pending = encoderCache.get(encoding);
  if (!pending) {
    // Static specifiers per branch: a bundler cannot follow `import(variable)`,
    // so a computed path would resolve at dev time and break in a compiled binary.
    pending = (
      encoding === 'cl100k_base'
        ? import('gpt-tokenizer/encoding/cl100k_base')
        : import('gpt-tokenizer/encoding/o200k_base')
    ).then(mod => {
      const encode = mod.encode as Encoder;
      readyEncoders.set(encoding, encode);
      return encode;
    });
    encoderCache.set(encoding, pending);
  }
  return pending;
}

/**
 * Load an encoding's rank table ahead of time, so {@link countTokensBpeSync}
 * can answer without awaiting.
 *
 * For a long-lived process that must count on a synchronous code path (the
 * proxy's request extractor): call this once at startup and let the sync
 * counter report "unknown" until it resolves. Idempotent — a second call joins
 * the first load rather than re-parsing the table.
 */
export async function warmBpeEncoder(
  encoding: BpeEncoding = DEFAULT_BPE_ENCODING
): Promise<void> {
  await loadEncoder(encoding);
}

/**
 * Count with the BPE tokenizer WITHOUT awaiting — null until the table is
 * loaded.
 *
 * Null is the honest answer, not zero: a caller on a sync path that has not
 * warmed the encoder has no count, and recording a 0 would read as "this text
 * was free". Warm it with {@link warmBpeEncoder} first. Same fidelity caveats
 * as {@link countTokensBpe}: an approximation of Claude's tokenizer, good for
 * ratios, not for an absolute bill.
 */
export function countTokensBpeSync(
  text: string,
  encoding: BpeEncoding = DEFAULT_BPE_ENCODING
): number | null {
  const encode = readyEncoders.get(encoding);
  if (!encode) return null;
  return encode(text).length;
}

/**
 * Count with Anthropic's count_tokens endpoint — ground truth for a given model.
 *
 * Requires network and credentials. Counts include the small per-message
 * overhead the API charges, so a very short string counts a few tokens higher
 * than a raw tokenizer would report; that overhead is constant and cancels out
 * when comparing two versions of the same text.
 */
export async function countTokensViaApi(
  text: string,
  options: Omit<CountTokensOptions, 'method' | 'encoding'> = {}
): Promise<TokenCountResult> {
  const model = options.model ?? DEFAULT_COUNT_TOKENS_MODEL;
  const baseUrl = (
    options.baseUrl ??
    process.env.ANTHROPIC_BASE_URL ??
    'https://api.anthropic.com'
  ).replace(/\/+$/, '');

  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
  const authToken = apiKey ? undefined : process.env.ANTHROPIC_AUTH_TOKEN;
  if (!apiKey && !authToken) {
    throw new Error(
      'Token counting via the Anthropic API needs a credential: set ANTHROPIC_API_KEY ' +
        '(or ANTHROPIC_AUTH_TOKEN for an OAuth token), or pass apiKey. ' +
        'Offline BPE counting needs no credential — omit the API method to use it.'
    );
  }

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
  };
  if (apiKey) {
    headers['x-api-key'] = apiKey;
  } else {
    // OAuth tokens go as a bearer plus the OAuth beta header, never as x-api-key.
    // The flag is the proxy's constant, so all three senders move together.
    headers.authorization = `Bearer ${authToken}`;
    headers['anthropic-beta'] = ANTHROPIC_OAUTH_BETA;
  }

  const body = JSON.stringify({
    model,
    messages: [{ role: 'user', content: text }],
  });

  const url = `${baseUrl}/v1/messages/count_tokens`;
  const maxAttempts = 3;
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url, { method: 'POST', headers, body });
    if (response.ok) {
      const json = (await response.json()) as { input_tokens?: number };
      if (typeof json.input_tokens !== 'number') {
        throw new Error(
          `count_tokens returned no input_tokens field (model ${model}); response was: ${JSON.stringify(json).slice(0, 200)}`
        );
      }
      return { tokens: json.input_tokens, method: 'api', model, approximate: false };
    }

    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === maxAttempts) {
      const detail = (await response.text().catch(() => '')).slice(0, 300);
      throw new Error(
        `count_tokens failed: HTTP ${response.status} from ${url} (model ${model})` +
          (detail ? `: ${detail}` : '')
      );
    }

    // Honour the server's own backoff when it sends one, else 2s then 4s.
    const retryAfter = Number(response.headers.get('retry-after'));
    const delayMs =
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : attempt * 2000;
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
}

/**
 * Count tokens in `text`. Offline BPE by default; the API tier is opt-in.
 */
export async function countTokens(
  text: string,
  options: CountTokensOptions = {}
): Promise<TokenCountResult> {
  switch (options.method ?? 'bpe') {
    case 'api':
      return countTokensViaApi(text, options);
    case 'chars':
      return { tokens: estimateTokensByChars(text), method: 'chars', approximate: true };
    case 'bpe':
      return countTokensBpe(text, options.encoding);
    default:
      throw new Error(
        `Unknown token counting method: ${String(options.method)} (expected 'bpe', 'api' or 'chars')`
      );
  }
}
