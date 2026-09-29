/**
 * What an upstream SAID when it refused a request, reduced to one bounded line
 * for the audit record's `error` field.
 *
 * A status code alone is not diagnosable: Anthropic answers a model-feature
 * mismatch, an unavailable beta and a malformed body all with `400
 * invalid_request_error`, and only the message tells them apart ("This model
 * does not support the effort parameter.", "The long context beta is not yet
 * available for this subscription.", …). Before this, `lazy watch` showed a bare
 * `FAIL(400)` and the operator had nothing to go on.
 *
 * Bounded because the body is the upstream's, not ours: an HTML error page from
 * a misconfigured gateway must not land in the audit log whole. The body is
 * text a server we do not control chose, and it reaches the live Watch stream
 * before the audit log's own scrub runs — and that scrub only knows credentials
 * in the daemon's ENVIRONMENT, never a member's per-user secret. So the caller
 * passes the credential values this request actually carried, and they are
 * removed here, explicitly (same rule as `upstreamErrorText` in
 * `src/daemon/credential-check.ts`): an upstream that echoes the token back must
 * not be able to publish it through lazy.
 */
import { REDACTED, redactSecretValues } from '../utils/redact';
import { collectPresentedCredentials } from './inject';
import { LOCAL_BACKEND_CREDS } from '../utils/role-target';

/** Longest excerpt the audit record keeps. */
export const UPSTREAM_ERROR_EXCERPT_MAX = 300;

/**
 * Credential values lazy itself sends as DUMMIES — never secrets — so they are
 * not scrubbed: a local-backend launch carries `Bearer ollama`
 * (`LOCAL_BACKEND_CREDS`), and scrubbing it would redact every "ollama" in an
 * Ollama error. Exactly these values, not a length floor: a real short key
 * must still be redacted.
 */
const DUMMY_CREDENTIAL_VALUES: ReadonlySet<string> = new Set(
  LOCAL_BACKEND_CREDS.flatMap((c) => [c.value, `Bearer ${c.value}`]),
);

/**
 * The credential values a set of forwarded headers carries, for
 * {@link upstreamErrorExcerpt} to scrub.
 *
 * Read through the proxy's OWN list of credential headers
 * (`collectPresentedCredentials`), never a second list here: a copy missed
 * `x-cursor-api-key` and `api-key` the moment it was written. Both the framed
 * (`Bearer x`) and bare readings are returned, longest first, so a whole header
 * value is replaced before its token part.
 */
export function credentialValuesIn(headers: Headers): string[] {
  const out = new Set<string>();
  for (const p of collectPresentedCredentials(headers)) {
    out.add(p.raw);
    out.add(p.value);
  }
  return [...out].filter((v) => v && !DUMMY_CREDENTIAL_VALUES.has(v)).sort((a, b) => b.length - a.length);
}

/**
 * The most reusable line in an error body.
 *
 * Both wires put the human message at `error.message` (Anthropic prefixes it
 * with `error.type`, OpenAI with `error.type` or `error.code`); anything else —
 * non-JSON, an unexpected shape — falls back to the raw text, whitespace
 * collapsed. Returns null for an empty body.
 */
export function upstreamErrorExcerpt(bodyText: string, secrets: readonly string[] = []): string | null {
  const raw = bodyText.trim();
  if (!raw) return null;

  let line: string | null = null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    const err = (parsed as { error?: unknown } | null)?.error;
    if (err && typeof err === 'object') {
      const e = err as { type?: unknown; code?: unknown; message?: unknown };
      const kind = typeof e.type === 'string' ? e.type : typeof e.code === 'string' ? e.code : null;
      if (typeof e.message === 'string' && e.message.trim()) {
        line = kind ? `${kind}: ${e.message}` : e.message;
      }
    } else if (typeof err === 'string' && err.trim()) {
      line = err;
    }
  } catch {
    // Not JSON (an HTML page, plain text): the raw body is the best we have,
    // and it is used below — nothing is lost by not parsing it.
  }

  let text = `upstream: ${(line ?? raw).replace(/\s+/g, ' ').trim()}`;
  // Scrub BEFORE truncating, so a secret cut in half by the bound cannot survive.
  for (const secret of secrets) if (secret) text = text.split(secret).join(REDACTED);
  text = redactSecretValues(text);
  return text.length > UPSTREAM_ERROR_EXCERPT_MAX ? `${text.slice(0, UPSTREAM_ERROR_EXCERPT_MAX)}…` : text;
}
