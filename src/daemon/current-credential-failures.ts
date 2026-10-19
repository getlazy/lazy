/**
 * The failing credentials every usage-limits surface shows: the audit trail's
 * unresolved failures (src/proxy/credential-health.ts), minus any failure from
 * BEFORE the stored credential was last replaced — that one is about a secret
 * that no longer exists. One function, so the CLI/RPC view and the MCP view
 * cannot disagree about a credential somebody has already fixed.
 */

import type { ProxyAuditRecord } from '../storage/types';
import { unresolvedCredentialFailures, type CredentialFailure } from '../proxy/credential-health';
import { memberEndpointUsageKey } from '../proxy/usage-limits';
import { listUserCredentials } from './user-credentials';

/** The usage key a stored member credential's traffic is filed under. */
export function credentialUsageKey(credential: { userId: string; endpointId?: string }): string {
  return credential.endpointId
    ? memberEndpointUsageKey(credential.userId, credential.endpointId)
    : `user:${credential.userId}`;
}

/** True when `failure` predates the credential stored at `updatedAt`. */
export function failurePredatesCredential(failure: CredentialFailure, updatedAt: string | undefined): boolean {
  const storedAt = updatedAt ? Date.parse(updatedAt) : NaN;
  return !Number.isNaN(storedAt) && failure.failedAt < storedAt;
}

export async function currentCredentialFailures(
  projectRoot: string,
  records: readonly ProxyAuditRecord[],
): Promise<CredentialFailure[]> {
  const storedAt = new Map((await listUserCredentials(projectRoot)).map((c) => [credentialUsageKey(c), c.updatedAt]));
  return unresolvedCredentialFailures(records).filter((f) => !failurePredatesCredential(f, storedAt.get(f.credential)));
}
