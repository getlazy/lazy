/**
 * Whose credential a review conversation's builder spends, and what it must
 * leave alone: the credential of the turn its task is running.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';
import { withReviewSessionCredential } from '../../src/daemon/review-session-builder-turn';
import { putUserCredential, clearUserCredentialCache } from '../../src/daemon/user-credentials';
import {
  clearSessionCredentialCache,
  getTaskSessionBinding,
  lookupSessionBinding,
} from '../../src/daemon/session-credentials';
import { getTurnOwner, planTurnCredential } from '../../src/daemon/turn-credentials';
import { runAsTurnOwnerRequest } from '../../src/daemon/turn-owner';

const TASK_ID = 'task-uuid-under-review';

describe('review conversation credential', () => {
  let root: string;
  let base: string;
  let unpin: () => void;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-review-cred-'));
    base = await mkdtemp(join(tmpdir(), 'lazy-review-cred-base-'));
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

  // INVARIANT: a single-user install runs the conversation's builder on the
  // daemon's own credential exactly as before — no placeholder is injected.
  test('single-user install: no owner env', async () => {
    const env = await withReviewSessionCredential(
      root, { reviewSessionId: 'rs-1', ownerEmail: 'alice@example.com' }, async (e) => e,
    );
    expect(env).toBeNull();
  });

  // INVARIANT: in team mode the builder carries a placeholder bound to the
  // reviewer, and that binding is revoked once the conversation turn is over.
  test('team mode: billed to the reviewer, released afterwards', async () => {
    await putUserCredential(root, { userId: 'alice@example.com', kind: 'api-key', token: 'sk-ant-api-alice' });
    let seen: string | undefined;
    await withReviewSessionCredential(root, { reviewSessionId: 'rs-1', ownerEmail: 'alice@example.com' }, async (env) => {
      seen = env?.[0]?.value;
      expect((await lookupSessionBinding(root, seen!))?.ownerUserId).toBe('alice@example.com');
    });
    expect(seen).toBeDefined();
    expect(await lookupSessionBinding(root, seen!)).toBeNull();
  });

  // INVARIANT: a review conversation never touches the credential of a turn
  // its task is running — not while it is open, and not when it ends. The
  // conversation used to bind under the TASK's id: that re-pointed the running
  // turn's placeholder at the reviewer (billing them for somebody else's turn,
  // and handing the builder the turn's own token), and its release revoked the
  // turn's binding, which killed the turn with a 401.
  test("team mode: a live turn's binding and owner survive a review conversation", async () => {
    await putUserCredential(root, { userId: 'alice@example.com', kind: 'api-key', token: 'sk-ant-api-alice' });
    await putUserCredential(root, { userId: 'bob@example.com', kind: 'api-key', token: 'sk-ant-api-bob' });
    // Bob's request is launching the task's turn; Alice opens a review
    // conversation on the task while that turn runs.
    await runAsTurnOwnerRequest({ taskId: TASK_ID, owner: { email: 'bob@example.com', spendable: true } }, async () => {
      await planTurnCredential(root, { taskId: TASK_ID, sessionId: 'turn-session' });
      const before = await getTaskSessionBinding(root, TASK_ID);
      expect(before?.ownerUserId).toBe('bob@example.com');

      let reviewerToken: string | undefined;
      await withReviewSessionCredential(
        root, { reviewSessionId: 'rs-1', ownerEmail: 'alice@example.com' },
        async (env) => {
          reviewerToken = env?.[0]?.value;
          // Open: the builder holds a placeholder of its own, bound to Alice …
          expect(reviewerToken).toBeDefined();
          expect(reviewerToken).not.toBe(before!.token);
          expect((await lookupSessionBinding(root, reviewerToken!))?.ownerUserId).toBe('alice@example.com');
          // … and the turn's placeholder still resolves to Bob.
          const during = await getTaskSessionBinding(root, TASK_ID);
          expect(during?.token).toBe(before!.token);
          expect(during?.ownerUserId).toBe('bob@example.com');
          expect((await lookupSessionBinding(root, before!.token))?.ownerUserId).toBe('bob@example.com');
        },
      );

      // Ended: the reviewer's placeholder is dead, the turn's is untouched.
      expect(await lookupSessionBinding(root, reviewerToken!)).toBeNull();
      const after = await getTaskSessionBinding(root, TASK_ID);
      expect(after?.token).toBe(before!.token);
      expect(after?.ownerUserId).toBe('bob@example.com');
      expect(after?.revokedAt).toBeNull();
      expect((await lookupSessionBinding(root, before!.token))?.ownerUserId).toBe('bob@example.com');
      expect(getTurnOwner(TASK_ID)).toBe('bob@example.com');
    });
  });

  // INVARIANT: the launcher binds and releases only through
  // withReviewSessionCredential. Reaching the launcher behaviourally means
  // admitting a builder slot and starting a container, so the route is
  // asserted at the source: a plan or release keyed on the task id anywhere in
  // this file is the bug above coming back.
  test('the launcher never binds or releases under the task id', async () => {
    const source = await readFile('src/daemon/review-session-builder-turn.ts', 'utf-8');
    expect(source).toContain('withReviewSessionCredential(projectRoot,');
    expect(source.match(/planTurnCredential\(/g)?.length).toBe(1);
    expect(source).toContain('taskId: key,');
    expect(source.match(/releaseTurnCredential\(/g)?.length).toBe(1);
    expect(source).toContain('releaseTurnCredential(projectRoot, key)');
  });
});
