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
 *   `ProxyAuditLog.list` returns them)
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

/**
 * The same verdict, asked per credential OWNER rather than per daemon.
 *
 * `unresolvedAuthRejection` answers "is LAZY's credential dead", which is the
 * right question for a single-user install where the daemon's own env holds the
 * one credential. In team mode there is no such thing as "lazy's credential":
 * each request carries a placeholder the proxy swapped for one member's real
 * token (docs/per-user-credentials.md), so a 401 condemns exactly that member's
 * token and says nothing about anyone else's. Rolling them together would send
 * a whole team to re-authorize because one person's setup-token expired.
 *
 * Records with no `userId` are ignored rather than bucketed: they are the
 * daemon-env path, whose verdict `lazy doctor` already reports.
 *
 * @param records - Audit records in insertion order, oldest first (as
 *   `ProxyAuditLog.list` returns them)
 * @returns owner user id → their still-unresolved rejection. Absent means the
 *   most recent evidence for that owner says their token works.
 */
export function unresolvedAuthRejectionsByUser(
  records: ProxyAuditRecord[],
): Map<string, AuthRejection> {
  const rejections = new Map<string, AuthRejection>();
  for (const r of records) {
    if (r.status === null) continue; // never reached the upstream — says nothing about auth
    const userId = r.userId;
    if (!userId) continue; // daemon-env traffic: not attributable to a member

    if (AUTH_REJECT_STATUSES.has(r.status)) {
      rejections.set(userId, { ts: r.ts, status: r.status, role: r.role, error: r.error });
    } else {
      // Same self-clearing rule as above, scoped to this owner: any answered
      // status other than 401/403 proves THEIR token got past authentication.
      rejections.delete(userId);
    }
  }
  return rejections;
}

/**
 * Is this rejection evidence about the credential the owner holds NOW?
 *
 * A rejection condemns the token that was presented, not the person. Once that
 * token has been replaced, the 401 it earned is evidence about a secret that no
 * longer exists anywhere — and reporting it against the new one tells somebody
 * their working credential is dead.
 *
 * That is not hypothetical. The one remedy every surface offers for a dead
 * token is "paste a new one", and until this rule existed, pasting a new one
 * changed nothing: the verdict is derived from the audit log, the audit log is
 * append-only, and only a LATER successful request cleared it. So a member
 * re-authorized, returned to the credential page, and was told again — by the
 * same banner, quoting the same 401 — to re-authorize. The prompt outlived the
 * problem, which is the one thing a self-clearing verdict must never do.
 *
 * The comparison is against the store's own `updatedAt`, so it needs no new
 * state: replacing a credential is exactly what moves that timestamp.
 *
 * Boundary is deliberately inclusive (`ts >= updatedAt` still counts): a
 * request already in flight when the replacement lands can be answered a few
 * milliseconds after it, and the honest reading of an unattributable
 * near-simultaneous 401 is "possibly still true". It self-clears on the owner's
 * next successful request, or on an explicit credential check.
 *
 * @param rejection - the owner's unresolved rejection, or null
 * @param credentialUpdatedAt - ISO timestamp from the credential store
 * @returns the rejection when it postdates the stored credential, else null
 */
export function rejectionAgainstCurrentCredential(
  rejection: AuthRejection | null | undefined,
  credentialUpdatedAt: string | undefined,
): AuthRejection | null {
  if (!rejection) return null;
  if (!credentialUpdatedAt) return rejection;

  const storedAt = Date.parse(credentialUpdatedAt);
  // An unparseable timestamp is a store we cannot reason about; report the
  // rejection rather than silently suppressing a real dead-token warning.
  if (Number.isNaN(storedAt)) return rejection;

  return rejection.ts >= storedAt ? rejection : null;
}
