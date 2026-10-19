/**
 * Is a freshly approved login really from the install the person TYPED?
 *
 * A look-alike install can relay a genuine approval: it answers
 * `/.well-known/lazy-teams` with "loopback" and redirects the approval page to
 * the real install (which then posts a real token to our listener), or it hands
 * out the real install's device-approval address and a code it got from there.
 * Either way the person approves a genuine page and the CLI would store and send
 * the token to the look-alike. So, after any login:
 *
 *   - a JWT's `iss` must be the typed origin (the install signs it, and a relay
 *     cannot change it without breaking the signature the real proxy checks —
 *     the CLI does not need to verify the signature to rely on that: a token
 *     whose claims were edited is useless to anyone holding it);
 *   - a device-flow `verification_uri` must be on the typed origin, checked
 *     BEFORE it is printed.
 *
 * Only the origin (scheme, host, port) is compared, never a path.
 */

import { TeamsRequestError } from './device-auth';

/** The payload of a JWT, unverified, or null when the string is not one. */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) return null;
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
    return payload && typeof payload === 'object' && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : null;
  } catch {
    // Three base64url segments that do not decode to JSON are not a JWT.
    return null;
  }
}

/** An http(s) origin, or null — anything else names no install lazy will talk to. */
function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.origin : null;
  } catch {
    // Not a URL at all: it names no origin, so it can match none.
    return null;
  }
}

/** The http(s) origin a JWT names as its issuer, or null (not a JWT, or no usable `iss`). */
export function jwtIssuerOrigin(token: string): string | null {
  const iss = decodeJwtPayload(token)?.iss;
  return typeof iss === 'string' ? originOf(iss) : null;
}

/**
 * Refuse a token that was not issued by `teamsUrl`. `requireJwt` is set for the
 * browser (loopback) login, which only ever hands out JWTs; a device-flow token
 * from an install without a proxy is a plain API token and is checked by its
 * `verification_uri` instead.
 */
export function assertTokenIssuedBy(token: string, teamsUrl: string, requireJwt: boolean): void {
  const payload = decodeJwtPayload(token);
  const typed = new URL(teamsUrl).origin;
  if (!payload) {
    if (!requireJwt) return;
    throw new TeamsRequestError(
      `${typed} handed back a login that is not a token it signed, so it was not kept.\n` +
      `  Check the address you typed is your Lazy Teams install.`,
    );
  }
  // Only a parsed http(s) origin is ever printed: `iss` comes from a token the
  // typed address handed back, and raw text from it could carry terminal escapes.
  const iss = jwtIssuerOrigin(token);
  if (iss !== typed) {
    const named = iss ?? 'an unknown issuer';
    throw new TeamsRequestError(
      `The login was approved by ${named}, not by ${typed}, the address you typed.\n` +
      `  The token was not kept and nothing was sent to ${typed}. ` +
      (iss ? `If ${iss} is your install, run \`lazy login ${iss}\`; otherwise ${typed} is impersonating it — ` : '') +
      `revoke the new token at Account settings → Git & CLI tokens on your install.`,
    );
  }
}

/** Refuse a device-approval address that is not on the typed origin, before it is shown. */
export function assertVerificationUriOn(verificationUri: string, teamsUrl: string): void {
  const typed = new URL(teamsUrl).origin;
  if (originOf(verificationUri) !== typed) {
    throw new TeamsRequestError(
      `${typed} asked you to approve this login at ${verificationUri}, which is a different address.\n` +
      `  lazy will not send you there: an install only ever asks for approval on its own address.`,
    );
  }
}
