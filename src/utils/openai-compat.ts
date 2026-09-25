/**
 * OpenAI-compatible endpoint helpers.
 *
 * Two hosted services stand behind lazy's OpenAI-compatible plumbing, and they
 * are told apart by HOSTNAME, the same way hosted Ollama is recognised
 * (`isHostedOllamaEndpoint` in ./ollama.ts): openrouter.ai gets the
 * `openrouter` credential, everything else (api.openai.com, or a compatible
 * gateway the user pinned) gets the `openai` credential. Hostname-based rather
 * than a config key so a profile's spelling stays `harness` + `endpoint` with
 * no per-provider special syntax.
 */

/** Default upstream for an OpenAI-wire harness whose profile names no endpoint (codex). */
export const DEFAULT_OPENAI_UPSTREAM = 'https://api.openai.com';

/**
 * True when the endpoint is OpenRouter (openrouter.ai), which bills the user's
 * OpenRouter key rather than an OpenAI one.
 *
 * Used for BOTH wire formats: an OpenAI-wire profile (codex, pi) and an
 * Anthropic-wire profile pinned at OpenRouter's Messages endpoint (claude-code
 * at https://openrouter.ai/api) carry the same `openrouter` credential — the
 * wire format changes what travels, never who is billed. Which wire a harness
 * takes there is `knownEndpointWires` / `wireForProfile`'s decision
 * (src/config/agent-profiles.ts).
 */
export function isOpenRouterEndpoint(endpoint: string): boolean {
  if (!endpoint.trim()) return false;
  try {
    const host = new URL(endpoint).hostname.toLowerCase();
    return host === 'openrouter.ai' || host.endsWith('.openrouter.ai');
  } catch {
    return false;
  }
}

/**
 * Upstream that serves Codex on a ChatGPT Plus/Pro SUBSCRIPTION, as opposed to
 * a metered platform API key.
 *
 * This is the base the codex CLI's own ChatGPT mode dials, verified against
 * codex-cli 0.152.1 (see docs/codex-chatgpt-subscription.md): the provider path
 * is `<base>/responses`, not `<base>/v1/responses`, which is why a codex profile
 * pointed here writes a `base_url` with no `/v1` segment.
 */
export const CHATGPT_CODEX_UPSTREAM = 'https://chatgpt.com/backend-api/codex';

/**
 * True when the endpoint is the ChatGPT subscription backend, which bills the
 * user's ChatGPT plan rather than an OpenAI API key.
 *
 * Hostname-based like its siblings, and deliberately NOT path-based: any
 * `chatgpt.com` endpoint is the subscription surface, and a stricter match on
 * the `/backend-api/codex` path would silently fall back to the `openai`
 * credential — i.e. quietly bill a metered API key — for a spelling that is off
 * by a slash. Being wrong in the direction of "that is the subscription" costs
 * an actionable "no ChatGPT credential" error; being wrong the other way spends
 * the wrong key.
 */
export function isChatGptEndpoint(endpoint: string): boolean {
  if (!endpoint.trim()) return false;
  try {
    const host = new URL(endpoint).hostname.toLowerCase();
    return host === 'chatgpt.com' || host.endsWith('.chatgpt.com');
  } catch {
    return false;
  }
}
