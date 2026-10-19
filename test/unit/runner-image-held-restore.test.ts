/**
 * The destination-restore unblock — the daemon reconciling a worktree after
 * ANOTHER task's accept — is a daemon-started WRITE turn, so while the
 * project's runner image is not ready it WAITS (engineer decision 2026-10-02)
 * rather than erroring.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FileStorage } from '../../src/storage/file-storage';
import { processRunnerImageHeldRestores, RUNNER_IMAGE_HELD_RESTORE_KEY } from '../../src/daemon/task-lifecycle';
import { resetRunnerImageForTests } from '../../src/daemon/runner-image';

const BUILDING = {
  state: 'building' as const, imageName: 'lazy-custom-abc:0.91', dockerfile: 'Dockerfile.lazy',
  defaultImage: 'lazy-runner:0.91', startedAt: new Date().toISOString(), reason: null, progress: null,
};
const READY = {
  state: 'ready' as const, imageName: 'lazy-custom-abc:0.91', dockerfile: 'Dockerfile.lazy',
  defaultImage: 'lazy-runner:0.91', readyAt: new Date().toISOString(),
};

describe('a restore unblock held for the runner image', () => {
  let root: string;
  let storage: FileStorage;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'lazy-held-restore-'));
    const base = join(root, 'store');
    mkdirSync(base, { recursive: true });
    writeFileSync(join(root, 'lazy.toml'), `[storage]\nbackend = "external"\nexternal_path = "${base}"\n`);
    storage = new FileStorage(root, { basePath: base });
    await storage.initialize();
  });

  afterEach(async () => {
    resetRunnerImageForTests();
    await storage.close();
    rmSync(root, { recursive: true, force: true });
  });

  // INVARIANT: held while the image is not ready; once it is, the record is
  // taken and the unblock launched — and a launch that fails is journaled with
  // the feedback it carried (naming the preserved stash), never dropped.
  test('waits while the image builds, then launches — a failed launch is journaled', async () => {
    const task = await storage.createTask('owner');
    const message = 'Reconcile the preserved stash abc123 in this worktree.';
    await storage.updateTaskMetadata(task.id, RUNNER_IMAGE_HELD_RESTORE_KEY, JSON.stringify({ message, at: '' }));

    resetRunnerImageForTests(BUILDING);
    await processRunnerImageHeldRestores(root, storage);
    expect((await storage.getTask(task.id))!.metadata![RUNNER_IMAGE_HELD_RESTORE_KEY]).not.toBe('');
    expect(await storage.getTaskJournal(task.id)).toHaveLength(0);

    // Ready: the record is taken. No daemon runs in this unit test, so the
    // launch itself fails — which must leave the words on the task.
    resetRunnerImageForTests(READY);
    await processRunnerImageHeldRestores(root, storage);
    expect((await storage.getTask(task.id))!.metadata![RUNNER_IMAGE_HELD_RESTORE_KEY]).toBe('');
    const journal = await storage.getTaskJournal(task.id);
    expect(journal.some((j) => j.content.includes(message))).toBe(true);
  });
});
