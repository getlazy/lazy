/**
 * "Is this credential working?" — for EVERY credential lazy bills, not only
 * Anthropic's, read off the audit trail.
 *
 * The usage-limit view lists a credential only once an upstream answered it
 * with rate-limit headers, so a credential that has stopped working never
 * appears there at all: on 2026-10-16 a ChatGPT subscription whose refresh
 * token had been spent (`refresh_token_reused`) failed every turn for fourteen
 * hours while `lazy_usage_limits` listed only the Anthropic credential.
 *
 * Two kinds of record are evidence of a broken credential: the proxy's OWN
 * refusal when it cannot resolve a usable credential (a refresh the token
 * endpoint refused, a credential that is missing or unparseable — written with
 * the credential's key by the proxy's refusal path), and an upstream 401/403.
 * The same self-clearing rule as src/proxy/auth-verdict.ts applies, per
 * credential key: any later answered request on that credential that is not a
 * rejection proves it works again. Nothing is stored, so nothing goes stale.
 */

import type { ProxyAuditRecord } from '../storage/types';
import { CREDENTIAL_REFUSED_PREFIX, CREDENTIAL_UNAVAILABLE_PREFIX } from './activity';

/** One credential that is currently failing. */
export interface CredentialFailure {
  /** The credential's key, as usage readings name it (`usageLimitCredentialKey`). */
  credential: string;
  /** Member it belongs to, when it is a member's. */
  userId: string | null;
  /** Agent profile it was connected for, when it was. */
  profile: string | null;
  /** Upstream the failing request was for. */
  upstream: string;
  /** When the latest failure happened (unix ms). */
  failedAt: number;
  /** HTTP status of the failure (the proxy's own refusal is a 401). */
  status: number;
  /** What failed — the proxy's reason or the upstream's error text. */
  error: string | null;
  /** True when lazy itself could not produce a usable credential (vs an upstream rejection). */
  unusable: boolean;
}

const REJECT = new Set([401, 403]);

function originOf(upstream: string): string {
  try {
    return new URL(upstream).origin;
  } catch {
    // Not a URL (a test double, a misconfigured upstream): compare it raw.
    return upstream;
  }
}

/**
 * Every credential whose latest evidence is a failure, newest first.
 *
 * A failure is cleared by a later ANSWERED, non-rejected request on the same
 * credential key — and a proxy REFUSAL also, because it and the success path do not
 * always spell the key alike (solo mode: `upstream:<origin>` when nothing could
 * be resolved, `credential:<label>` once something is), on the same person
 * (`userId`, null for the daemon's own credentials) at the same upstream origin.
 *
 * @param records - audit records oldest first (as `readAuditRecords` returns them)
 */
export function unresolvedCredentialFailures(records: readonly ProxyAuditRecord[]): CredentialFailure[] {
  const failing = new Map<string, CredentialFailure>();
  // Failures that came from the proxy's own refusal — the only ones whose key
  // can be spelled differently from the success path's.
  const refusals = new Set<string>();
  for (const r of records) {
    const refused = r.refusedCredential;
    if (refused) {
      failing.set(refused.key, {
        credential: refused.key,
        userId: refused.userId,
        profile: refused.profile,
        upstream: r.upstream,
        failedAt: r.ts,
        status: r.status ?? 401,
        error: r.error,
        unusable: true,
      });
      refusals.add(refused.key);
      continue;
    }
    if (r.status === null) continue; // never answered: says nothing either way
    // lazy could not resolve the credential RIGHT NOW (a 503 the proxy wrote
    // itself): no upstream answered, so it is no evidence either way.
    if ((r.error ?? '').startsWith(CREDENTIAL_UNAVAILABLE_PREFIX)) continue;
    if (REJECT.has(r.status)) {
      if (!r.credential) continue;
      refusals.delete(r.credential);
      failing.set(r.credential, {
        credential: r.credential,
        userId: r.userId ?? null,
        profile: r.credentialProfile ?? null,
        upstream: r.upstream,
        failedAt: r.ts,
        status: r.status,
        error: r.error,
        unusable: (r.error ?? '').startsWith(CREDENTIAL_REFUSED_PREFIX),
      });
      continue;
    }
    if (r.credential) failing.delete(r.credential);
    const who = r.userId ?? null;
    const where = originOf(r.upstream);
    for (const key of refusals) {
      // Only a refusal that NAMED no credential (`upstream:<origin>`: solo mode,
      // nothing resolved) may be cleared by a success spelled another way. A
      // refusal naming a credential is cleared by that credential's own success
      // alone (the exact-key delete above): with two accounts at one origin,
      // Y working says nothing about X.
      if (!key.startsWith('upstream:')) continue;
      const f = failing.get(key);
      if (f && f.userId === who && originOf(f.upstream) === where) {
        failing.delete(key);
        refusals.delete(key);
      }
    }
  }
  return [...failing.values()].sort((a, b) => b.failedAt - a.failedAt);
}
