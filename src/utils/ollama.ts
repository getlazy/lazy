/**
 * Ollama endpoint predicate.
 *
 * One rule, used by every surface that has to decide what an Ollama endpoint
 * costs: hosted Ollama bills a real key, local Ollama bills nobody. Sibling to
 * `isOpenRouterEndpoint` (./openai-compat.ts) and `isLocalEndpoint`
 * (./endpoint.ts) — see the header there for why hostname, not config, decides
 * which credential an upstream is paid with.
 *
 * This module used to also carry a reachability probe and a model-fallback
 * helper for the removed `[ollama]` config block. Both went with it: an Ollama
 * server is now just an `endpoint` on an agent profile, so reachability is
 * `checkTargetConnectivity` (src/utils/role-target.ts) like any other upstream,
 * and the model comes from the profile.
 */

/**
 * True when the endpoint is Ollama Cloud (ollama.com), which requires a real API
 * key. Local Ollama (localhost, LAN, Docker-internal aliases) ignores auth.
 */
export function isHostedOllamaEndpoint(endpoint: string): boolean {
  if (!endpoint.trim()) return false;
  try {
    const host = new URL(endpoint).hostname.toLowerCase();
    return host === 'ollama.com' || host.endsWith('.ollama.com');
  } catch {
    return false;
  }
}

/**
 * The local Ollama a `pi` profile talks to when it names no endpoint, and the
 * model it asks for. Together they are the built-in `pi` profile's whole
 * upstream — see HARNESS_DEFAULT_ENDPOINT in src/config/agent-profiles.ts for
 * why pi defaults local rather than to Anthropic.
 *
 * Ollama's default port, and the address from the HOST's perspective, because
 * the proxy is what dials it.
 */
export const DEFAULT_LOCAL_OLLAMA_ENDPOINT = 'http://localhost:11434';

/**
 * Chosen by the engineer (2026-09-13) and verified present on their machine.
 * `latest` rather than a pinned digest deliberately: it names whatever the user
 * pulled under that tag, which is how Ollama users refer to their own models.
 */
export const DEFAULT_LOCAL_OLLAMA_MODEL = 'qwen3.8:latest';
