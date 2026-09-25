/**
 * The show RPC answers "which protected files are in play" for remote clients.
 *
 * INVARIANT (same one `violation-turn-detection.test.ts` encodes for the local
 * surfaces): the final violation set is the one on the last agent turn that
 * CARRIED violations, not the last agent turn — a violation turn is followed by
 * push-back and maintained-files nudges whose agent replies carry none.
 *
 * A remote client (Lazy Teams) has no access to `latestViolationTurn`, and
 * re-deriving the rule in another language would be a second copy of a
 * load-bearing invariant that can drift. So the daemon answers it, and the show
 * payload carries the answer. Dropping `fileViolations` from that payload is
 * silent on this side of the wire — the remote review page simply stops
 * offering any way to resolve a conflict task — which is why it is asserted.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  initDaemonStorage,
  getOrCreateStorage,
  closeAllStorage,
  handleShow,
} from '../../src/daemon/rpc-handlers';
import { enableInProcessTestMode } from '../helpers/in-process-test-mode';
import { pinConfig } from '../helpers/pin-config';
import type { FileViolation } from '../../src/types';

enableInProcessTestMode();

const VIOLATIONS: FileViolation[] = [
  { file: 'lazy.toml', base_sha: 'abc123', status: 'pending' },
  { file: 'CLAUDE.md', base_sha: 'abc123', status: 'approved' },
];

describe('show RPC: file violations', () => {
  let root: string;
  let taskId: string;
  let unpinConfig: () => void;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-rpc-show-violations-'));
    await writeFile(
      join(root, 'lazy.toml'),
      `[storage]\nbackend = "external"\nexternal_path = "${join(root, 'store')}"\n`,
    );
    unpinConfig = pinConfig(root);
    initDaemonStorage(root);

    const storage = await getOrCreateStorage();
    const task = await storage.createTask('Touch a protected file');
    taskId = task.id;
    const session = await storage.createSession(task.id, 'claude', 'lazy/t', 'HEAD');

    // Shaped like the incident: violations on the work turn, then a supervised
    // push-back exchange whose agent reply carries none.
    await storage.createTurn({
      sessionId: session.id,
      sequence: 1,
      role: 'agent',
      content: 'work turn',
      violations: VIOLATIONS,
    });
    await storage.createTurn({
      sessionId: session.id,
      sequence: 2,
      role: 'human',
      content: '## Permission Violation Review',
      turnType: 'nudge',
    });
    await storage.createTurn({
      sessionId: session.id,
      sequence: 3,
      role: 'agent',
      content: 'push-back reply',
      turnType: 'nudge',
    });
  });

  afterEach(async () => {
    await closeAllStorage();
    unpinConfig();
    await rm(root, { recursive: true, force: true });
  });

  test('serializes the set from the last turn that carried violations', async () => {
    const payload = (await handleShow(root, { taskId })) as Record<string, unknown>;

    // Every record, whatever its status — an approved file is what tells a
    // reviewer a decision was already made, so it must not be filtered out.
    expect(payload.fileViolations).toEqual(VIOLATIONS);
  });

  test('a task with no violations answers with an empty set, not an absent field', async () => {
    const storage = await getOrCreateStorage();
    const clean = await storage.createTask('Nothing protected here');
    const session = await storage.createSession(clean.id, 'claude', 'lazy/c', 'HEAD');
    await storage.createTurn({ sessionId: session.id, sequence: 1, role: 'agent', content: 'work' });

    const payload = (await handleShow(root, { taskId: clean.id })) as Record<string, unknown>;
    expect(payload.fileViolations).toEqual([]);
  });
});
