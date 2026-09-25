/**
 * Whose credential a memory compact's model run spends.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';
import { withCompactCredential } from '../../src/daemon/rpc-memory';
import { putUserCredential, clearUserCredentialCache } from '../../src/daemon/user-credentials';
import {
  clearSessionCredentialCache,
  getTaskSessionBinding,
  lookupSessionBinding,
} from '../../src/daemon/session-credentials';
import { getTurnOwner, planTurnCredential } from '../../src/daemon/turn-credentials';
import { runAsTurnOwnerRequest } from '../../src/daemon/turn-owner';

const ALICE = { role: 'human' as const, email: 'alice@example.com' };

describe('memory compact credential', () => {
  let root: string;
  let base: string;
  let unpin: () => void;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-compact-cred-'));
    base = await mkdtemp(join(tmpdir(), 'lazy-compact-cred-base-'));
    unpin = pinDaemonBaseDir(base);
    clearUserCredentialCache();
    clearSessionCredentialCache();
  });

  afterEach(async () => {
    unpin();
    clearUserCredentialCache();
    clearSessionCredentialCache();
    await rm(root, { recursive: true, force: true });
    await rm(base, { recursive: true, force: true });
  });

  // INVARIANT: a single-user install compacts on the builder credential
  // exactly as before — no placeholder is injected.
  test('single-user install: no owner env', async () => {
    expect(await withCompactCredential(root, ALICE, 'llm', async (e) => e)).toBeUndefined();
  });

  // INVARIANT: in team mode the model run is billed to the member who pressed
  // Run, and the binding is revoked once the run is over (per-user billing).
  test('team mode: billed to the acting member, released afterwards', async () => {
    await putUserCredential(root, { userId: 'alice@example.com', kind: 'api-key', token: 'sk-ant-api-alice' });
    let seen: string | undefined;
    await withCompactCredential(root, ALICE, 'auto', async (env) => {
      seen = env?.[0]?.value;
      const binding = await lookupSessionBinding(root, seen!);
      expect(binding?.ownerUserId).toBe('alice@example.com');
    });
    expect(seen).toBeDefined();
    expect(await lookupSessionBinding(root, seen!)).toBeNull();
  });

  // INVARIANT: no silent fallback — a member with no credential is REFUSED,
  // naming the marker Lazy Teams turns into "connect your Claude account",
  // rather than billed to somebody else or quietly downgraded to mechanical.
  test('team mode: a member with no credential is refused', async () => {
    await putUserCredential(root, { userId: 'bob@example.com', kind: 'api-key', token: 'sk-ant-api-bob' });
    let ran = false;
    await expect(withCompactCredential(root, ALICE, 'auto', async () => { ran = true; }))
      .rejects.toMatchObject({ status: 400, message: expect.stringContaining('No Anthropic credential for this user') });
    expect(ran).toBe(false);
  });

  // INVARIANT: a mechanical compact runs no model, so it needs nobody's
  // credential — a member without one can still compact that way.
  test('team mode: mechanical needs no credential', async () => {
    await putUserCredential(root, { userId: 'bob@example.com', kind: 'api-key', token: 'sk-ant-api-bob' });
    expect(await withCompactCredential(root, ALICE, 'mechanical', async (e) => e ?? 'none')).toBe('none');
  });

  // INVARIANT: a compact belongs to no task — it never touches a running
  // task's binding or recorded owner.
  test("team mode: a live turn's binding and owner survive a compact", async () => {
    await putUserCredential(root, { userId: 'alice@example.com', kind: 'api-key', token: 'sk-ant-api-alice' });
    await putUserCredential(root, { userId: 'bob@example.com', kind: 'api-key', token: 'sk-ant-api-bob' });
    // Bob's request is launching task-x's turn, and the compact runs while it is.
    await runAsTurnOwnerRequest({ taskId: 'task-x', owner: { email: 'bob@example.com', spendable: true } }, async () => {
      await planTurnCredential(root, { taskId: 'task-x', sessionId: 'turn-session' });
      const before = await getTaskSessionBinding(root, 'task-x');

      await withCompactCredential(root, ALICE, 'llm', async () => undefined);

      const after = await getTaskSessionBinding(root, 'task-x');
      expect(after?.token).toBe(before!.token);
      expect(getTurnOwner('task-x')).toBe('bob@example.com');
    });
  });
});
