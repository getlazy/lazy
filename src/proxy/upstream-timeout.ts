/**
 * How long the proxy waits for an upstream, and how it says so when it gives up.
 *
 * WHY THIS EXISTS: Bun's `fetch` carries a DEFAULT timeout that lazy never
 * chose and cannot see. Verified on Bun 1.4.2 (2026-09-16): a bare `fetch` to an
 * upstream that never answers rejects with `TimeoutError: The operation timed
 * out.` — at ~360s here, and at 255–298s on the machine where this was found.
 * The proxy turned that into its ordinary "upstream unreachable" 502, so a local
 * Ollama that was merely slow (a 27B model queued behind other sessions,
 * prefilling a 360 KB prompt) looked exactly like an upstream that was down, and
 * every Pi turn on a local model died four to six minutes in.
 *
 * `timeout: false` disables that default (still honoured at runtime on 1.4.2,
 * though it is absent from bun-types' `BunFetchRequestInit`), and lazy's own
 * `AbortSignal.timeout` supplies the bound instead — explicit, configurable, and
 * named in the error when it fires. The two compose: with `timeout: false` the
 * abort lands at exactly the requested time and not at Bun's hidden one.
 */

// The default itself lives in the constants-only leaf module, because
// src/config/loader.ts needs it at module-init time. Re-exported here so the
// proxy's own call sites have one import for the whole concern.
export { DEFAULT_UPSTREAM_TIMEOUT_SECONDS } from './upstream-defaults';

/** True for the rejection Bun raises when a fetch timer (ours or its own) fires. */
export function isUpstreamTimeout(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'TimeoutError' || err.message.toLowerCase().includes('operation timed out');
}

/**
 * Fetch options every outgoing upstream request must carry.
 *
 * `timeoutSeconds <= 0` means no ceiling at all: Bun's default is still
 * disabled, and only the client going away ends the request.
 */
export function upstreamFetchOptions(timeoutSeconds: number): Record<string, unknown> {
  // `timeout` is a Bun-only fetch extension and is not in the published types.
  const options: Record<string, unknown> = { timeout: false };
  if (timeoutSeconds > 0) {
    options.signal = AbortSignal.timeout(timeoutSeconds * 1000);
  }
  return options;
}

/**
 * The error text a failed upstream request is audited and reported with.
 *
 * A timeout is called a timeout, with the ceiling that fired and the knob that
 * changes it — "The operation timed out." on its own sent an engineer looking
 * for a network fault when the model was simply still loading.
 */
export function describeUpstreamFailure(
  err: unknown,
  upstream: string,
  timeoutSeconds: number,
): string {
  const message = err instanceof Error ? err.message : String(err);
  if (!isUpstreamTimeout(err)) return message;
  if (timeoutSeconds <= 0) {
    // No ceiling configured, so this is Bun's own hidden timer — a lazy bug if
    // it ever fires, and worth saying so rather than blaming the upstream.
    return (
      `${upstream} did not respond, and the request timed out even though lazy set no ceiling ` +
      `(this is a lazy bug — please report it): ${message}`
    );
  }
  return (
    `no response from ${upstream} within ${timeoutSeconds}s. A local model can legitimately take ` +
    `longer when it is loading, queued behind other requests, or prefilling a very large prompt — ` +
    `raise [proxy] upstream_timeout in lazy.toml if this upstream is genuinely that slow, or check ` +
    `that it is serving the requested model.`
  );
}
