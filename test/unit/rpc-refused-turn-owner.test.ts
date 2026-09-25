/**
 * A turn-launching RPC that REFUSES leaves no turn owner behind.
 *
 * `handleRpc` decides who asked for a turn (the pending owner,
 * src/daemon/turn-owner.ts) BEFORE the handler runs, because only then does it
 * know both the caller and the command, and runs the handler in that owner's
 * request scope. When the handler then refuses, no turn launched, and nothing
 * of the owner may survive the request: the next turn on the task — including
 * one the daemon starts by itself — would be billed to, and attributed to, a
 * person who did not ask for it. The owner lives only in the scope, so there is
 * no record to clear; this pins that a daemon-side read finds nobody.
 *
 * The e2e half (test/e2e/daemon-actor-tokens.test.ts, "a turn-launching RPC
 * that refuses leaves no owner behind for the next turn") proves the billing
 * consequence against a live daemon.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  initDaemonStorage,
  getOrCreateStorage,
  closeAllStorage,
  handleRpc,
} from '../../src/daemon/rpc-handlers';
import { RpcError } from '../../src/daemon/rpc-error';
import { getPendingTurnOwner } from '../../src/daemon/turn-owner';
import { enableInProcessTestMode } from '../helpers/in-process-test-mode';
import { pinConfig } from '../helpers/pin-config';

enableInProcessTestMode();

const MEMBER = { kind: 'user', email: 'ada@example.com', name: 'Ada' } as const;

describe('a refused turn-launching RPC', () => {
  let root: string;
  let taskId: string;
  let unpinConfig: () => void;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-rpc-refused-owner-'));
    await writeFile(
      join(root, 'lazy.toml'),
      `[storage]\nbackend = "external"\nexternal_path = "${join(root, 'store')}"\n`,
    );
    unpinConfig = pinConfig(root);
    initDaemonStorage(root);

    // Never started: no session, so an unblock has nothing to launch.
    const storage = await getOrCreateStorage();
    taskId = (await storage.createTask('Refused-owner task')).id;
  });

  afterEach(async () => {
    await closeAllStorage();
    unpinConfig();
    await rm(root, { recursive: true, force: true });
  });

  // INVARIANT: a turn owner recorded for a command that then refuses is
  // cleared before the refusal propagates. No turn launched, so nothing is owed
  // to that person, and a record left behind would be spent by the NEXT turn on
  // the task — an auto-resume or a sync nobody asked for — in their name and on
  // their credential.
  test('an unblock refused for want of a session leaves no pending owner', async () => {
    let refusal: unknown = null;
    try {
      await handleRpc('unblockTask', root, { taskId, message: 'Carry on' }, undefined, MEMBER);
    } catch (err) {
      refusal = err;
    }

    // The command really did refuse, from inside the handler — after the owner
    // was recorded, which is the path this test is about.
    expect(refusal).toBeInstanceOf(RpcError);
    expect(getPendingTurnOwner(taskId)).toBeNull();
  });
});
