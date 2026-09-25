/**
 * Codex launch-side wiring for lazy's OpenAI-compatible proxy routing.
 *
 * The proxy side (OpenAI-wire upstream kind, credential swap, usage
 * extraction, path-allowlist tier) is the `proxy-openai-upstreams` work — this
 * module only decides what a CODEX LAUNCH is told about it:
 *
 * WHERE CODEX DIALS: the proxy's ROOT. There is no path prefix (unlike
 * `/_lazy/cursor`): OpenAI-wire routing is decided per CALLER, from the grant
 * behind the Bearer placeholder the request presents — codex's provider block
 * declares `env_key = "OPENAI_API_KEY"`, that env var holds the launch's
 * minted placeholder, and codex sends it as `Authorization: Bearer …` on every
 * provider request (verified against codex-cli 0.152.1). The proxy resolves
 * the placeholder to its grant, routes to the OpenAI-compatible upstream, and
 * swaps in the real key. Attribution is therefore evidence, not a claim.
 *
 * WHY AN ENV VAR AND NOT OPENAI_BASE_URL: codex 0.152.1 IGNORES the
 * OPENAI_BASE_URL environment variable for its built-in provider (verified —
 * it went straight to api.openai.com). The only working override is the
 * `model_providers` block in ~/.codex/config.toml, which lazy rewrites every
 * turn (src/agent/codex-config.ts). That write happens inside the supervisor,
 * which learns the proxy address from this env var, set at launch where the
 * surface (container vs host) is known.
 */

import type { RunnerType } from '../config/types';
import { isChatGptEndpoint } from '../utils/openai-compat';
import { proxyBaseUrlForRunner } from '../utils/role-target';

/**
 * Env var carrying the COMPLETE `base_url` into the supervisor, which writes it
 * verbatim into ~/.codex/config.toml each turn. Read by lazy's own code only —
 * codex never sees it.
 *
 * Complete, rather than a root the supervisor appends `/v1` to, because the
 * right suffix depends on the UPSTREAM and only the launch knows which one this
 * profile forwards to: api.openai.com serves the Responses API at `/v1/responses`
 * while the ChatGPT subscription backend serves it at `<base>/responses`. The
 * proxy forwards a path unchanged, so getting the suffix wrong lands the request
 * on a 404 upstream. One value, decided where the answer is known.
 */
export const CODEX_ENDPOINT_ENV = 'LAZY_CODEX_API_BASE';

/**
 * Path prefix codex's `base_url` carries for a given upstream.
 *
 * VERIFIED against codex-cli 0.152.1: codex appends its API paths directly to
 * `base_url`, so this prefix is what decides whether it requests `/v1/responses`
 * or `/responses` — and the proxy hands that path to the upstream as it stands.
 * `/v1` is what api.openai.com and every OpenAI-compatible gateway expect; the
 * ChatGPT subscription base already ends in `/backend-api/codex` and takes the
 * bare path.
 */
export function codexBaseUrlPrefix(endpoint: string): string {
  return isChatGptEndpoint(endpoint) ? '' : '/v1';
}

/**
 * Build the codex endpoint env var for a launch, or fail loud.
 *
 * Same contract as cursorProxyEnvVars: the audit plane has no off switch, so a
 * codex launch that cannot resolve the live proxy address FAILS rather than
 * letting the turn dial api.openai.com directly with nothing recorded.
 */
export function codexProxyEnvVars(
  proxyBaseUrl: string | undefined,
  endpoint: string = '',
): Array<{ key: string; value: string }> {
  if (!proxyBaseUrl) {
    throw new Error(
      `lazy could not resolve the live proxy address for a codex turn.\n` +
      `All codex API traffic routes through lazy's local audit proxy, always. Continuing\n` +
      `without it would talk straight to OpenAI's servers with no audit record, so lazy\n` +
      `refuses rather than silently degrade. There is no way to turn the proxy off.\n\n` +
      `What to do:\n` +
      `  - Check the daemon:    lazy daemon status\n` +
      `  - Start / restart it:  lazy daemon start   (or: lazy daemon restart)\n` +
      `  - Still failing? Its startup log says why the proxy did not bind: lazy daemon logs`,
    );
  }
  return [{
    key: CODEX_ENDPOINT_ENV,
    value: proxyBaseUrl.replace(/\/$/, '') + codexBaseUrlPrefix(endpoint),
  }];
}

/**
 * The launch-time env for a codex agent about to run, given the surface it
 * runs on. ONE decision point for both launch surfaces, same as
 * cursorLaunchEnvVars — see that function for why this is not inlined at each
 * site. Returns [] for every non-codex agent.
 *
 * Keyed on the HARNESS, not on the task's `agent`: that names a PROFILE
 * (`[agents.<name>]`), so `[agents.work-codex] harness = "codex"` would fail an
 * `=== 'codex'` comparison and launch with no `LAZY_CODEX_API_BASE` — codex
 * would then dial api.openai.com directly, unaudited. The caller resolves the
 * profile (src/capture/claude.ts) and passes the harness it runs.
 */
export function codexLaunchEnvVars(opts: {
  harness: string | undefined;
  runnerType: RunnerType;
  /** Live proxy port, or undefined when the daemon context has no proxy. */
  proxyPort: number | undefined;
  bind: string;
  /**
   * The profile's upstream — where the proxy forwards this turn. Only the path
   * SHAPE is taken from it (see {@link codexBaseUrlPrefix}); the agent still
   * dials the proxy and never this address.
   */
  endpoint?: string;
}): Array<{ key: string; value: string }> {
  if (opts.harness !== 'codex') return [];
  const proxyBaseUrl = opts.proxyPort
    ? proxyBaseUrlForRunner(opts.runnerType, opts.proxyPort, opts.bind)
    : undefined;
  return codexProxyEnvVars(proxyBaseUrl, opts.endpoint ?? '');
}
