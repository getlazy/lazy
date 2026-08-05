/**
 * "Is lazy's credential actually accepted?" — read off the audit trail.
 *
 * The daemon credential gate checks PRESENCE, never validity, and says so at
 * length (see daemon/credential-gate.ts): a start-time API probe would tie
 * daemon startup to network reachability and would still say nothing about an
 * hour later. Its closing note is that the authoritative, always-current signal
 * is the upstream 401/403 the audit proxy already sees on every request.
 *
 * Nothing read that signal. So an expired or revoked token presented as: a
 * builder asking for /login while `lazy doctor` cheerfully reported "API auth
 * configured" (it saw an env var, which was indeed present and indeed dead).
 * This module turns the signal lazy already records into that answer, and
 * `lazy doctor` is where it surfaces — the single diagnosis surface, rather than
 * a bespoke warning bolted onto each command.
 */

import type { ProxyAuditRecord } from '../storage/types';

/** Upstream statuses that mean "your credential was rejected". */
const AUTH_REJECT_STATUSES = new Set([401, 403]);

export interface AuthRejection {
  /** When the rejection was recorded (unix ms). */
  ts: number;
  /** The upstream status (401 or 403). */
  status: number;
  /** Role whose traffic was rejected (builder|agent), when the header was set. */
  role: string | null;
  /** Upstream error text, when the proxy captured one. */
  error: string | null;
}

/**
 * The credential rejection that is still UNRESOLVED, or null when the most
 * recent evidence says the credential works.
 *
 * "Unresolved" means: a 401/403 with no successful call after it. That ordering
 * test is what makes the check self-clearing — the moment the user re-exports a
 * good token and restarts the daemon, the next successful call is newer than the
 * rejection and doctor goes quiet on its own, with no state to reset and no way
 * to leave a stale warning behind.
 *
 * @param records - Audit records in insertion order, oldest first (as
 *   `Storage.listAuditRecords` returns them)
 */
export function unresolvedAuthRejection(records: ProxyAuditRecord[]): AuthRejection | null {
  let rejection: AuthRejection | null = null;
  for (const r of records) {
    if (r.status === null) continue; // never reached the upstream — says nothing about auth
    if (AUTH_REJECT_STATUSES.has(r.status)) {
      rejection = { ts: r.ts, status: r.status, role: r.role, error: r.error };
      continue;
    }
    // Any other answered status proves the credential was accepted: a 400, 429
    // or 500 all mean the request got PAST authentication.
    rejection = null;
  }
  return rejection;
}
