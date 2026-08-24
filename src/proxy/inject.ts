/**
 * Placeholder detection and just-in-time credential injection — the pure part.
 *
 * Kept out of the server so the substitution rules can be tested directly, with
 * no socket and no upstream: this is the code that decides whether the human's
 * real credential goes on a wire, so "it looked right in an integration test"
 * is not good enough evidence.
 *
 * DETECTION IS BY LOOKUP, NOT BY SHAPE. `collectPresentedCredentials` pulls
 * every plausible credential value out of the request headers and the caller
 * asks the broker about each one. Nothing here parses a prefix or a token
 * format — Cursor's auth wire form is not documented in any contract lazy can
 * rely on, and a shape rule that drifted would fail by silently forwarding a
 * placeholder upstream (an unauthenticated request that looks fine in the log).
 */

/** Headers whose value may carry a credential the client was given. */
const CREDENTIAL_HEADERS = ['x-api-key', 'authorization', 'x-cursor-api-key', 'api-key'] as const;

/** One credential value found on the request, and where it was found. */
export interface PresentedCredential {
  /** Lower-case header name. */
  header: string;
  /** The full header value, e.g. `Bearer sk-…`. */
  raw: string;
  /** The bare credential — the value with any `Bearer ` framing removed. */
  value: string;
}

/**
 * Every credential-shaped value on this request, most specific first.
 *
 * Both the framed (`Bearer x`) and bare (`x`) readings of a header are
 * returned, because a client may put a raw token in `Authorization` with no
 * scheme and the broker is the only thing that can say which reading is real.
 */
export function collectPresentedCredentials(headers: Headers): PresentedCredential[] {
  const found: PresentedCredential[] = [];
  for (const header of CREDENTIAL_HEADERS) {
    const raw = headers.get(header);
    if (!raw) continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const bearer = /^Bearer\s+(.+)$/i.exec(trimmed);
    if (bearer) found.push({ header, raw: trimmed, value: bearer[1]!.trim() });
    // The un-framed reading is always offered too: a header lazy did not frame
    // itself may carry the token bare.
    found.push({ header, raw: trimmed, value: trimmed });
  }
  return found;
}

/**
 * Remove every trace of the presented placeholder from the forward headers.
 *
 * A placeholder must NEVER reach a real upstream: it authenticates nothing
 * there, so the request would fail with an upstream auth error that names
 * lazy's placeholder — leaking the fact and the value while looking like the
 * user's credential was wrong.
 */
export function stripPresentedCredential(
  headers: Headers,
  presented: PresentedCredential[],
  token: string,
): void {
  for (const p of presented) {
    if (p.value !== token && !p.raw.includes(token)) continue;
    headers.delete(p.header);
  }
}

/**
 * Swap the placeholder for the real credential, in the form the target needs.
 *
 * `headers` is the forward-header set (already stripped of lazy-internal
 * headers) and is mutated in place.
 *
 * - `header` placement: every header that carried the placeholder is deleted
 *   and the credential's own canonical header is set. This is what makes a
 *   reroute correct — the target's credential form wins over the slot the
 *   placeholder happened to arrive in.
 * - `in-place` placement: the placeholder substring is replaced wherever it
 *   appeared, so the client's own framing (whatever it was) is preserved.
 */
export function applyCredential(
  headers: Headers,
  presented: PresentedCredential[],
  token: string,
  placement: { kind: 'header'; header: string; value: string } | { kind: 'in-place'; value: string },
): void {
  if (placement.kind === 'in-place') {
    // Collect first: mutating while iterating the same header repeatedly would
    // re-read an already-substituted value.
    const rewrites = new Map<string, string>();
    for (const p of presented) {
      if (!p.raw.includes(token)) continue;
      const current = rewrites.get(p.header) ?? p.raw;
      rewrites.set(p.header, current.split(token).join(placement.value));
    }
    for (const [header, value] of rewrites) headers.set(header, value);
    return;
  }

  stripPresentedCredential(headers, presented, token);
  headers.set(placement.header, placement.value);
}

/**
 * The 401 body the proxy answers with when a presented placeholder does not
 * verify, or when its target's credential cannot be resolved.
 *
 * Shaped like an Anthropic API error so a client surfaces it as an auth failure
 * rather than as a malformed response — the message inside is lazy's, and names
 * the remedy (CLAUDE.md: errors are actionable).
 */
export function credentialErrorBody(message: string): string {
  return JSON.stringify({
    type: 'error',
    error: { type: 'authentication_error', message },
  });
}

/** The message for a placeholder the broker does not recognise. */
export function unknownPlaceholderMessage(): string {
  return (
    'lazy proxy: the credential this request presented is not a placeholder this daemon minted.\n' +
    'Agent containers are credential-free by design — they carry a per-task placeholder that the\n' +
    'proxy exchanges for the real credential. An unrecognised one means the launch that created\n' +
    'this process is gone (its task was accepted, rejected or closed, so its placeholder was\n' +
    'revoked), or a real credential was presented directly.\n\n' +
    'What to do:\n' +
    '  - Resume the task so it relaunches with a fresh placeholder: lazy unblock <task>\n' +
    '  - Check the daemon is the one that minted it: lazy daemon status'
  );
}

/** The message for a target whose real credential lazy cannot resolve. */
export function missingCredentialMessage(upstream: string, reason: string): string {
  return (
    `lazy proxy: no usable credential for ${upstream}.\n` +
    `Reason: ${reason}\n\n` +
    `Every turn bills the acting user's own credential, so lazy refuses rather than fall back to\n` +
    `another one. Restore the credential and the next request succeeds — nothing needs restarting\n` +
    `on the container side.`
  );
}
