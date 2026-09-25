/**
 * Whose credential the linked-task description one-shot spends.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';
import { withDescribeCredential } from '../../src/daemon/link-describe';
import { putUserCredential, clearUserCredentialCache } from '../../src/daemon/user-credentials';
import {
  clearSessionCredentialCache,
  getTaskSessionBinding,
  lookupSessionBinding,
} from '../../src/daemon/session-credentials';
import { getTurnOwner } from '../../src/daemon/turn-credentials';
import { runAsTurnOwnerRequest } from '../../src/daemon/turn-owner';
import {
  planTurnCredential,
  TurnCredentialUnavailableError,
} from '../../src/daemon/turn-credentials';
import type { Task } from '../../src/types';

const TASK = { id: 'task-uuid-linked', code: 'linked' } as unknown as Task;

describe('link description credential', () => {
  let root: string;
  let base: string;
  let unpin: () => void;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-linkdesc-cred-'));
    base = await mkdtemp(join(tmpdir(), 'lazy-linkdesc-cred-base-'));
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

  // INVARIANT: a single-user install runs the one-shot on the builder
  // credential exactly as before — no placeholder is injected.
  test('single-user install: no owner env', async () => {
    const env = await withDescribeCredential(root, TASK, { role: 'human', email: 'alice@example.com' }, async (e) => e);
    expect(env).toBeUndefined();
  });

  // INVARIANT: in team mode the one-shot carries a session placeholder bound to
  // the member who asked, and that binding is revoked once the run is over.
  test('team mode: billed to the acting member, released afterwards', async () => {
    await putUserCredential(root, { userId: 'alice@example.com', kind: 'api-key', token: 'sk-ant-api-alice' });
    let seen: string | undefined;
    await withDescribeCredential(root, TASK, { role: 'human', email: 'alice@example.com' }, async (env) => {
      seen = env?.[0]?.value;
      const binding = await lookupSessionBinding(root, seen!);
      expect(binding?.ownerUserId).toBe('alice@example.com');
    });
    expect(seen).toBeDefined();
    expect(await lookupSessionBinding(root, seen!)).toBeNull();
  });

  // INVARIANT: describing never touches the task's OWN turn credentials — a
  // running or queued turn keeps its binding and its recorded owner, or it
  // dies with a 401 and is billed to the describer.
  test("team mode: a live turn's binding and owner survive a describe", async () => {
    await putUserCredential(root, { userId: 'alice@example.com', kind: 'api-key', token: 'sk-ant-api-alice' });
    await putUserCredential(root, { userId: 'bob@example.com', kind: 'api-key', token: 'sk-ant-api-bob' });
    // Bob's request is launching the task's turn, and the describe runs while it is.
    await runAsTurnOwnerRequest({ taskId: TASK.id, owner: { email: 'bob@example.com', spendable: true } }, async () => {
      await planTurnCredential(root, { taskId: TASK.id, sessionId: 'turn-session' });
      const before = await getTaskSessionBinding(root, TASK.id);

      await withDescribeCredential(root, TASK, { role: 'human', email: 'alice@example.com' }, async () => undefined);

      const after = await getTaskSessionBinding(root, TASK.id);
      expect(after?.token).toBe(before!.token);
      expect(after?.ownerUserId).toBe('bob@example.com');
      expect(after?.revokedAt).toBeNull();
      expect(getTurnOwner(TASK.id)).toBe('bob@example.com');
    });
  });

  // INVARIANT: no fallback — with nobody to bill (no member, no service
  // credential) team mode refuses rather than spending the builder's account.
  test('team mode: no member and no service credential refuses', async () => {
    await putUserCredential(root, { userId: 'alice@example.com', kind: 'api-key', token: 'sk-ant-api-alice' });
    await expect(
      withDescribeCredential(root, TASK, 'human', async () => undefined),
    ).rejects.toBeInstanceOf(TurnCredentialUnavailableError);
  });
});
