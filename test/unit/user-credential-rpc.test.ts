/**
 * Who may administer per-user credentials over `/rpc/*`.
 *
 * INVARIANT: the credential RPCs are control-plane only. A user token's holder
 * is the SUBJECT of this data, not its administrator — letting one store a
 * credential would let a member redirect another member's billing, and letting
 * one read the list would leak the team roster to any member.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';
import {
  handlePutUserCredential,
  handleRevokeUserCredential,
  handleListUserCredentials,
} from '../../src/daemon/rpc-handlers';
import { clearUserCredentialCache, getUserCredential } from '../../src/daemon/user-credentials';
import { auditLogDir, auditLogPath } from '../../src/proxy/audit-log';
import type { ProxyAuditRecord } from '../../src/storage/types';

const CONTROL = { kind: 'control' } as const;
const USER = { kind: 'user', email: 'ada@example.com', name: 'Ada' } as const;

/** Minimal audit record: only the fields the auth verdict reads carry meaning. */
function auditRecord(ts: number, status: number | null, userId: string | null): ProxyAuditRecord {
  return {
    id: `r${ts}`,
    seq: ts,
    ts,
    role: 'agent',
    taskId: null,
    backend: 'anthropic',
    upstream: 'https://api.anthropic.com',
    method: 'POST',
    path: '/v1/messages',
    endpoint: 'messages',
    model: 'claude-opus-5',
    tier: 'opus',
    stream: true,
    requestShape: null,
    toolUses: [],
    toolResults: [],
    status,
    usage: null,
    stopReason: null,
    error: null,
    durationMs: 10,
    reroute: null,
    userId,
  };
}

/** Write proxy audit records where the daemon's default data dir will find them. */
async function writeAuditLog(projectRoot: string, records: ProxyAuditRecord[]): Promise<void> {
  const dataDir = join(projectRoot, '.lazy');
  await mkdir(auditLogDir(dataDir), { recursive: true });
  await writeFile(auditLogPath(dataDir), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

describe('user credential RPCs', () => {
  let root: string;
  let base: string;
  let unpin: () => void;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-credrpc-'));
    base = await mkdtemp(join(tmpdir(), 'lzd-credrpc-'));
    unpin = pinDaemonBaseDir(base);
    clearUserCredentialCache();
  });

  afterEach(async () => {
    unpin();
    clearUserCredentialCache();
    await rm(root, { recursive: true, force: true });
    await rm(base, { recursive: true, force: true });
  });

  test('a control-plane caller can store, list and revoke', async () => {
    const summary = await handlePutUserCredential(
      root,
      { userId: 'alice', kind: 'oauth', token: 'sk-ant-oat-alice', label: 'Alice' },
      CONTROL,
    );
    expect(summary.userId).toBe('alice');
    expect(JSON.stringify(summary)).not.toContain('sk-ant-oat-alice');

    const listed = await handleListUserCredentials(root, CONTROL);
    expect(listed.credentials.map((c) => c.userId)).toEqual(['alice']);
    expect(JSON.stringify(listed)).not.toContain('sk-ant-oat-alice');

    expect(await handleRevokeUserCredential(root, { userId: 'alice' }, CONTROL)).toEqual({ revoked: true });
    expect(await getUserCredential(root, 'alice')).toBeNull();
  });

  // INVARIANT: the credential registry keys a person by the SAME canonical
  // address the token registry mints under (canonicalPersonEmail). A turn is
  // billed to whatever address the caller's token carries, so if only one side
  // folded case, a token minted for 'Ada@Example.com' would hold
  // 'ada@example.com' while the credential sat under the original spelling,
  // unreachable — and that member would be refused with the no-credential
  // marker on their first turn, from a source nobody would suspect.
  test('a credential is reachable however the address was typed', async () => {
    await handlePutUserCredential(
      root,
      { userId: '  Ada.Lovelace@Example.COM ', kind: 'oauth', token: 'sk-ant-oat-ada' },
      CONTROL,
    );

    // Filed under the canonical form, which is what a minted token carries.
    const listed = await handleListUserCredentials(root, CONTROL);
    expect(listed.credentials.map((c) => c.userId)).toEqual(['ada.lovelace@example.com']);

    // And reachable by it — this is the lookup a turn actually performs.
    expect(await getUserCredential(root, 'ada.lovelace@example.com')).not.toBeNull();
    // Still reachable by the spelling the operator used, so neither direction
    // depends on the caller remembering to normalise.
    expect(await getUserCredential(root, 'ADA.Lovelace@example.com')).not.toBeNull();

    // Re-putting under another spelling REPLACES rather than accumulating a
    // second credential for one person.
    await handlePutUserCredential(
      root,
      { userId: 'ADA.LOVELACE@EXAMPLE.COM', kind: 'api-key', token: 'sk-ant-api-ada' },
      CONTROL,
    );
    const afterRePut = await handleListUserCredentials(root, CONTROL);
    expect(afterRePut.credentials).toHaveLength(1);
    expect(afterRePut.credentials[0]!.kind).toBe('api-key');

    // And a revoke naming any spelling reaches it.
    expect(await handleRevokeUserCredential(root, { userId: 'ada.LOVELACE@example.com' }, CONTROL))
      .toEqual({ revoked: true });
    expect(await getUserCredential(root, 'ada.lovelace@example.com')).toBeNull();
  });

  // The guard on the other side of that fold: a key that is NOT an address is
  // left exactly as given. The daemon's own reserved key and the opaque
  // control-plane form (still admitted until the re-put under emails lands) may
  // legitimately be case-sensitive, and folding one would make an existing
  // credential unreachable — the very failure the fold exists to prevent.
  test('a non-email key keeps its case', async () => {
    await handlePutUserCredential(
      root,
      { userId: 'User-12', kind: 'oauth', token: 'sk-ant-oat-legacy' },
      CONTROL,
    );

    const listed = await handleListUserCredentials(root, CONTROL);
    expect(listed.credentials.map((c) => c.userId)).toEqual(['User-12']);
    expect(await getUserCredential(root, 'User-12')).not.toBeNull();
    expect(await getUserCredential(root, 'user-12')).toBeNull();
  });

  test('a user token is refused on all three, including for itself', async () => {
    await expect(
      handlePutUserCredential(root, { userId: 'u-ada', kind: 'oauth', token: 't' }, USER),
    ).rejects.toThrow(/control-plane/i);
    await expect(handleRevokeUserCredential(root, { userId: 'u-ada' }, USER)).rejects.toThrow(/control-plane/i);
    await expect(handleListUserCredentials(root, USER)).rejects.toThrow(/control-plane/i);

    // And nothing was written on the way to being refused.
    expect(await getUserCredential(root, 'u-ada')).toBeNull();
  });

  // The kind cannot be inferred: it decides which env var the placeholder is
  // injected into, and a wrong guess produces a refused request, not a working one.
  test('the credential kind must be stated, and must be one lazy can send', async () => {
    await expect(
      handlePutUserCredential(root, { userId: 'alice', token: 't' }, CONTROL),
    ).rejects.toThrow(/kind/i);
    await expect(
      handlePutUserCredential(root, { userId: 'alice', kind: 'bearer', token: 't' }, CONTROL),
    ).rejects.toThrow(/oauth/);
  });

  /**
   * lazy does no token refresh, so an expired setup-token presents as every one
   * of that member's turns failing while the credential store cheerfully reports
   * one stored. The listing carries the proxy's own 401 verdict per owner so a
   * control plane can prompt exactly that member to re-authorize.
   */
  describe('dead-token verdict', () => {
    /**
     * Audit timestamps in these tests are relative to when the credentials were
     * stored, and must be: a rejection is only reported against the credential
     * the store holds NOW, so evidence that predates it is evidence about a
     * token that has since been replaced. `stored + n` reads as "n ms after the
     * credential the verdict is about was written".
     */
    let stored: number;

    beforeEach(async () => {
      await handlePutUserCredential(
        root,
        { userId: 'alice', kind: 'oauth', token: 'sk-ant-oat-alice' },
        CONTROL,
      );
      await handlePutUserCredential(
        root,
        { userId: 'bob', kind: 'api-key', token: 'sk-ant-api-bob' },
        CONTROL,
      );
      stored = Date.now();
    });

    // A project that has never proxied a request has no audit log at all. That
    // must read as "no evidence of trouble", not as an error or a warning.
    test('no audit log means no rejection reported', async () => {
      const listed = await handleListUserCredentials(root, CONTROL);
      expect(listed.credentials.map((c) => c.rejection)).toEqual([null, null]);
    });

    // INVARIANT: the verdict is per owner. Reporting Bob's expired token against
    // Alice would send the whole team to re-authorize over one person's failure.
    test('surfaces a rejection against its own owner only', async () => {
      await writeAuditLog(root, [
        auditRecord(stored + 1, 200, 'alice'),
        auditRecord(stored + 2, 401, 'bob'),
      ]);

      const listed = await handleListUserCredentials(root, CONTROL);
      const byUser = new Map(listed.credentials.map((c) => [c.userId, c.rejection]));
      expect(byUser.get('alice')).toBeNull();
      expect(byUser.get('bob')).toMatchObject({ status: 401, ts: stored + 2 });
    });

    // Self-clearing: the next request of theirs that gets past authentication
    // resolves the prompt, with no state to reset.
    test('clears once that owner succeeds again', async () => {
      await writeAuditLog(root, [
        auditRecord(stored + 1, 401, 'bob'),
        auditRecord(stored + 2, 200, 'bob'),
      ]);

      const listed = await handleListUserCredentials(root, CONTROL);
      expect(listed.credentials.every((c) => c.rejection === null)).toBe(true);
    });

    /**
     * INVARIANT: a rejection is evidence about the token that was presented, not
     * about the person. Replacing the credential is the one remedy every surface
     * offers ("paste a new one"), so a verdict that survives the replacement
     * tells a member their WORKING token is dead — with no action left that
     * would clear it short of running a turn.
     *
     * Regression test for exactly that: the credentials page reported an error
     * on a freshly pasted, valid credential.
     */
    test('a rejection earned by a REPLACED token is not reported against the new one', async () => {
      await writeAuditLog(root, [auditRecord(stored + 1, 401, 'bob')]);

      // Precondition: with bob's old token still stored, the verdict stands.
      const before = await handleListUserCredentials(root, CONTROL);
      expect(before.credentials.find((c) => c.userId === 'bob')?.rejection).toMatchObject({
        status: 401,
      });

      // Bob does what the prompt told him to do, and pastes a new token. The
      // wait is only so the store's millisecond `updatedAt` lands strictly after
      // the rejection — in life these are minutes apart.
      await new Promise((resolve) => setTimeout(resolve, 10));
      await handlePutUserCredential(
        root,
        { userId: 'bob', kind: 'api-key', token: 'sk-ant-api-bob-fresh' },
        CONTROL,
      );

      const after = await handleListUserCredentials(root, CONTROL);
      expect(after.credentials.find((c) => c.userId === 'bob')?.rejection).toBeNull();
      // And nobody else's verdict moved as a side effect.
      expect(after.credentials.find((c) => c.userId === 'alice')?.rejection).toBeNull();
    });

    // INVARIANT: replacement clears the verdict on the audit trail itself, not
    // only via a timestamp comparison — a 401 and the put can land in the same
    // millisecond and the banner must still reset.
    test('putUserCredential clears a standing rejection without waiting', async () => {
      const ts = stored + 1;
      await writeAuditLog(root, [auditRecord(ts, 401, 'bob')]);

      await handlePutUserCredential(
        root,
        { userId: 'bob', kind: 'api-key', token: 'sk-ant-api-bob-fresh' },
        CONTROL,
      );

      const listed = await handleListUserCredentials(root, CONTROL);
      expect(listed.credentials.find((c) => c.userId === 'bob')?.rejection).toBeNull();
    });

    // The flip side, and why the rule is a timestamp comparison rather than a
    // reset: a token that is rejected AFTER it was stored is genuinely dead, and
    // storing it is not what makes it good.
    test('a rejection earned by the CURRENT token is still reported', async () => {
      await handlePutUserCredential(
        root,
        { userId: 'bob', kind: 'api-key', token: 'sk-ant-api-bob-fresh' },
        CONTROL,
      );
      await writeAuditLog(root, [auditRecord(Date.now() + 1000, 401, 'bob')]);

      const listed = await handleListUserCredentials(root, CONTROL);
      expect(listed.credentials.find((c) => c.userId === 'bob')?.rejection).toMatchObject({
        status: 401,
      });
    });

    // Adding the verdict must not turn the listing into a way to read secrets.
    test('still never returns a secret', async () => {
      await writeAuditLog(root, [auditRecord(stored + 1, 401, 'bob')]);

      const listed = await handleListUserCredentials(root, CONTROL);
      expect(JSON.stringify(listed)).not.toContain('sk-ant-oat-alice');
      expect(JSON.stringify(listed)).not.toContain('sk-ant-api-bob');
    });
  });
});
