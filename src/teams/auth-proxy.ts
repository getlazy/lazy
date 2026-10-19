/**
 * Recognising an authenticating reverse proxy in front of a Lazy Teams install.
 *
 * A proxy that signs browsers in (ngrok's OAuth action, oauth2-proxy,
 * Cloudflare Access) answers a CLI's unauthenticated request with ITS OWN
 * sign-in page — HTML, often after a redirect, sometimes with a 200. The CLI's
 * address is right and the install is fine; the proxy simply never let the
 * request through. Telling that person to "check the address" sends them
 * hunting for a typo that is not there, so every place the CLI talks to Teams
 * asks {@link looksLikeAuthProxy} before blaming the address.
 *
 * This is a HEURISTIC on purpose, and only ever chooses between two error
 * messages: nothing is skipped, retried or authorized on its say-so.
 */

/** Where the operator is told how to let the CLI paths past the proxy. */
export const AUTH_PROXY_DOCS =
  'https://docs.getlazy.dev/self-hosting-lazy-teams#behind-an-authenticating-proxy';

/**
 * What a SIGN-IN page carries. Deliberately not bare "ngrok" or "oauth": ngrok
 * also serves non-auth pages (offline tunnel, upstream down, browser warning)
 * that mention both, and calling those "an authenticating proxy" would be as
 * misleading as blaming the address.
 */
const SIGN_IN_MARKERS = [
  /accounts\.google\.com/i,
  /sign[ -]?in with/i,
  /continue with (google|microsoft|github)/i,
  /cloudflare access/i,
  /oauth2[-_]proxy/i,
  /login\.microsoftonline\.com/i,
  /ERR_NGROK_30[1-9]/,
];

export interface ProxyEvidence {
  status: number;
  /** The final URL after redirects, when the fetch followed any. */
  redirected: boolean;
  finalUrl: string;
  contentType: string;
  /** A prefix of the body is enough to recognise a sign-in page. */
  body: string;
  headers: Headers;
}

/** Read the evidence from a response; consumes the body. */
export async function gatherProxyEvidence(response: Response): Promise<ProxyEvidence> {
  const body = (await response.text().catch(() => '')).slice(0, 4096);
  return {
    status: response.status,
    redirected: response.redirected,
    finalUrl: response.url,
    contentType: response.headers.get('content-type') ?? '',
    body,
    headers: response.headers,
  };
}

/**
 * Does this answer look like it came from a sign-in proxy rather than from Lazy
 * Teams? Lazy Teams answers the CLI surface in JSON, always — so a non-JSON
 * answer carrying a redirect, an ngrok header, a sign-in marker or a proxy
 * authentication challenge is the proxy's.
 */
export function looksLikeAuthProxy(evidence: ProxyEvidence, requestedUrl: string): boolean {
  const { headers, status } = evidence;
  const isJson = /json/i.test(evidence.contentType);
  if (isJson) return false;

  if (status === 407) return true;
  if (status >= 300 && status < 400 && headers.has('location')) return true;
  if (evidence.redirected && evidence.finalUrl && evidence.finalUrl !== requestedUrl) return true;
  // ngrok's own auth-related error codes (ERR_NGROK_302 and friends). Its
  // offline / upstream-down codes (3200, 8012…) are not a sign-in page.
  if (/^ERR_NGROK_30\d$/.test(headers.get('ngrok-error-code') ?? '')) return true;
  if (status === 401 && headers.has('www-authenticate')) return true;
  return SIGN_IN_MARKERS.some((marker) => marker.test(evidence.body));
}

/** The guidance for an operator whose authenticating proxy is in the way. */
const PROXY_GUIDANCE =
  `The address looks right: an authenticating proxy (ngrok OAuth, oauth2-proxy, Cloudflare Access) ` +
  `is in front of Teams and refused a request that carried no token it verifies. ` +
  `Ask whoever runs the install to set it up for the command line (it needs a policy that ` +
  `serves the install's login description and verifies Teams' CLI tokens). See ${AUTH_PROXY_DOCS}`;

/** Host only: a sign-in redirect URL can be kilobytes of query string and must never reach the terminal. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/** The one sentence the CLI says when it decides a proxy is in the way. */
export function authProxyMessage(requestedUrl: string, evidence: ProxyEvidence): string {
  const host = evidence.redirected && evidence.finalUrl ? hostOf(evidence.finalUrl) : null;
  const where = host ? ` (it was sent on to ${host})` : '';
  return `${requestedUrl} answered with a sign-in page${where} instead of Lazy Teams. ${PROXY_GUIDANCE}`;
}

/**
 * One line when the server answered with a redirect, else null. Lazy never
 * follows a redirect carrying a token. A redirect that only changes the scheme or
 * port of the same host is a wrong address (say where); any other redirect —
 * to another host, or to a sign-in path on this one — is a sign-in proxy, so
 * the address is right and the operator must fix the proxy. Only the
 * redirect's host is ever printed, never its URL.
 */
export function redirectMessage(requestedOrigin: string, response: Response): string | null {
  const location = response.headers.get('location');
  if (response.status < 300 || response.status >= 400 || !location) return null;
  let target: URL;
  try {
    target = new URL(location, requestedOrigin);
  } catch {
    return `${requestedOrigin} redirected somewhere that is not a usable address.`;
  }
  const from = new URL(requestedOrigin);
  if (target.hostname === from.hostname && target.origin !== from.origin) {
    return `${requestedOrigin} redirected to ${target.origin} — use that address.`;
  }
  return `${requestedOrigin} redirected to a sign-in page at ${target.host} instead of Lazy Teams. ${PROXY_GUIDANCE}`;
}
