/**
 * Recognising, checking and swapping a session placeholder token at the proxy.
 *
 * The proxy's contract with the rest of per-user credentials
 * (docs/design/lazy-teams.md §3.2) is deliberately narrow, and this module is
 * all of it:
 *
 *   - It only ever looks at a credential lazy itself minted — a value carrying
 *     the `lazy-sess-` prefix. Everything else is somebody's real token and is
 *     forwarded byte-for-byte, which is what every single-user install sends.
 *   - It replaces the token VALUE inside the header the request ARRIVED with.
 *     It never moves a credential from one header to the other, never adds a
 *     header the client did not send, and never removes one.
 *   - When the inbound form and the owner's credential kind disagree, it
 *     refuses. An OAuth token in `x-api-key` (or an API key in
 *     `Authorization: Bearer`) is not something to fix up silently: the swap
 *     would produce a request shape the credential cannot satisfy, and the
 *     upstream's eventual 401 would point at the user rather than at the bug.
 *   - An unrecognised session token is a 401. Always. There is no unattributed
 *     bucket on this path.
 */

import type { UserCredentialKind } from '../daemon/user-credentials';

/** The two shapes a Claude Code request can carry a credential in. */
export type InboundCredentialForm = 'bearer' | 'x-api-key';

export interface InboundCredential {
  form: InboundCredentialForm;
  /** Header name the credential arrived in (lowercase). */
  header: 'authorization' | 'x-api-key';
  /** The bare token, with any `Bearer ` scheme prefix stripped. */
  token: string;
}

export type PlaceholderScan =
  /** No lazy placeholder present — forward verbatim (the default path). */
  | { kind: 'none' }
  | { kind: 'one'; credential: InboundCredential }
  /**
   * A placeholder in BOTH headers. Never guess which one the client meant:
   * whichever we picked, the other would go upstream unswapped.
   */
  | { kind: 'ambiguous' };

/** Why a request carrying a placeholder was refused. */
export type SessionAuthDenial = 'unknown_session_token' | 'auth_kind_mismatch' | 'session_token_wrong_origin';

/** What the daemon tells the proxy about a presented placeholder. */
export type SessionCredentialResolution =
  | { ok: true; userId: string; kind: UserCredentialKind; secret: string }
  /**
   * `wrong_origin`: the placeholder is live but pinned to a different network
   * address than the one this request came from — it leaked out of the
   * container it was minted for.
   */
  | { ok: false; reason?: 'wrong_origin'; detail?: string };

/** Where a request came from, as the proxy saw it. */
export interface SessionRequestContext {
  /** The peer's IP address (IPv4-mapped IPv6 unwrapped), or null when unknown. */
  peerAddress: string | null;
}

/** Resolve a placeholder to its owner's real credential. Injected by the daemon. */
export type SessionCredentialLookup = (
  token: string,
  context?: SessionRequestContext,
) => Promise<SessionCredentialResolution>;

/** `::ffff:172.30.0.2` → `172.30.0.2`; anything else unchanged. */
export function normalizePeerAddress(address: string | null | undefined): string | null {
  if (!address) return null;
  return address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
}

/** The header form a credential of this kind must arrive in. */
export function expectedFormFor(kind: UserCredentialKind): InboundCredentialForm {
  return kind === 'oauth' ? 'bearer' : 'x-api-key';
}

/** The env var whose presence produces this form, for error text. */
export function envVarForForm(form: InboundCredentialForm): string {
  return form === 'bearer' ? 'CLAUDE_CODE_OAUTH_TOKEN' : 'ANTHROPIC_API_KEY';
}

/**
 * Find a lazy placeholder among the request's credential headers.
 *
 * @param isPlaceholder predicate identifying a lazy-minted session token
 */
export function scanForPlaceholder(
  headers: Headers,
  isPlaceholder: (token: string) => boolean,
): PlaceholderScan {
  const found: InboundCredential[] = [];

  const auth = headers.get('authorization');
  if (auth) {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    const token = match ? match[1]!.trim() : auth.trim();
    if (isPlaceholder(token)) found.push({ form: 'bearer', header: 'authorization', token });
  }

  const apiKey = headers.get('x-api-key');
  if (apiKey && isPlaceholder(apiKey.trim())) {
    found.push({ form: 'x-api-key', header: 'x-api-key', token: apiKey.trim() });
  }

  if (found.length === 0) return { kind: 'none' };
  if (found.length > 1) return { kind: 'ambiguous' };
  return { kind: 'one', credential: found[0]! };
}

/**
 * Write the real secret into the header the placeholder arrived in, preserving
 * that header's shape (`Bearer ` scheme included).
 */
export function swapCredential(
  headers: Headers,
  credential: InboundCredential,
  secret: string,
): void {
  if (credential.header === 'authorization') {
    headers.set('authorization', `Bearer ${secret}`);
  } else {
    headers.set('x-api-key', secret);
  }
}

/** The message a refused caller sees. Never echoes a token. */
export function denialMessage(denial: SessionAuthDenial, detail?: string): string {
  switch (denial) {
    case 'unknown_session_token':
      return (
        'Unauthorized: this session token is not bound to any user. ' +
        'It was revoked when its turn ended, or it belongs to an older daemon. ' +
        'Requests lazy cannot attribute to a person are not forwarded.'
      );
    case 'auth_kind_mismatch':
      return (
        'Unauthorized: the credential form of this request does not match the ' +
        `stored credential of the user it is bound to${detail ? ` (${detail})` : ''}. ` +
        'lazy replaces the token value inside the header a request arrived with and ' +
        'never rewrites header shape, so this is refused rather than guessed. ' +
        'Restart the task so its container is relaunched with the matching credential env var.'
      );
    case 'session_token_wrong_origin':
      return (
        'Unauthorized: this session token is pinned to the container it was minted for, and this ' +
        `request did not come from it${detail ? ` (${detail})` : ''}. A token copied out of a ` +
        "member's terminal environment is not honoured anywhere else."
      );
  }
}
