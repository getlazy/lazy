/**
 * Every agent turn records the runner image it ACTUALLY ran on — the launch
 * record of the container that ran it (src/task/turn-run-image.ts), stamped by
 * storage when the turn is written.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FileStorage } from '../../src/storage/file-storage';
import { recordTaskLaunchImage } from '../../src/daemon/runner-image-choice';
import { resetRunnerImageForTests } from '../../src/daemon/runner-image';
import { turnLaunchLabels } from '../../src/utils/turn-labels';

describe('the image every turn ran on', () => {
  let root: string;
  let storage: FileStorage;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'lazy-turn-image-'));
    const base = join(root, 'store');
    mkdirSync(base, { recursive: true });
    writeFileSync(join(root, 'lazy.toml'), `[storage]\nbackend = "external"\nexternal_path = "${base}"\n`);
    storage = new FileStorage(root, { basePath: base });
    await storage.initialize();
    resetRunnerImageForTests({
      state: 'building', imageName: 'lazy-custom-abc:0.91', dockerfile: 'Dockerfile.lazy',
      defaultImage: 'lazy-runner:0.91', startedAt: new Date().toISOString(), reason: null, progress: null,
    });
  });

  afterEach(async () => {
    resetRunnerImageForTests();
    await storage.close();
    rmSync(root, { recursive: true, force: true });
  });

  // INVARIANT: every agent turn of every type records the image of the
  // container that ran it. The task's newest-launch record alone cannot answer
  // "what did turn N run on": a reviewer, a read-only ask on the default image
  // and a work turn on the project's image can all be on one task.
  test('work, ask and review turns each carry their own container image', async () => {
    const task = await storage.createTask('goal');
    const sess = await storage.createSession(task.id, 'claude-code', 'lazy/x', 'abc123');
    const work = `lazy-${task.id.slice(0, 8)}`;
    const review = `lazy-review-${task.id.slice(0, 8)}`;

    // An ask while the project's image builds: the work container on the
    // default image, as a read-only fallback nobody chose.
    await recordTaskLaunchImage(storage, task.id, 'lazy-runner:0.91', 'readonly-default', work);
    const ask = await storage.createTurn({ sessionId: sess.id, sequence: 1, role: 'agent', content: 'answer', turnType: 'ask' });
    expect(ask.runner_image).toEqual({ image: 'lazy-runner:0.91', kind: 'readonly' });

    // A review in its own container on the project's image, once ready.
    resetRunnerImageForTests({
      state: 'ready', imageName: 'lazy-custom-abc:0.91', dockerfile: 'Dockerfile.lazy',
      defaultImage: 'lazy-runner:0.91', readyAt: new Date().toISOString(),
    });
    await recordTaskLaunchImage(storage, task.id, 'lazy-custom-abc:0.91', 'project', review);
    const rev = await storage.createTurn({ sessionId: sess.id, sequence: 2, role: 'agent', content: 'findings', turnType: 'review' });
    expect(rev.runner_image).toEqual({ image: 'lazy-custom-abc:0.91', kind: 'custom' });

    // A work turn REUSING the work container keeps that container's launch
    // image — the reviewer's launch says nothing about it.
    const sync = await storage.createTurn({ sessionId: sess.id, sequence: 3, role: 'agent', content: 'merged', turnType: 'sync' });
    expect(sync.runner_image).toEqual({ image: 'lazy-runner:0.91', kind: 'readonly' });

    // INVARIANT: the low-high SELF-review runs inside the work turn, in the
    // work container — never stamped from a dispatched reviewer's container.
    const self = await storage.createTurn({ sessionId: sess.id, sequence: 31, role: 'agent', content: 'self', turnType: 'review', reviewDispatch: 'self' });
    expect(self.runner_image).toEqual({ image: 'lazy-runner:0.91', kind: 'readonly' });

    // A review that never launched ran in no container: no image at all.
    const notRun = await storage.createTurn({ sessionId: sess.id, sequence: 32, role: 'agent', content: 'not run', turnType: 'review', reviewDispatch: 'auto', noRunnerImage: true });
    expect(notRun.runner_image).toBeUndefined();

    // A human turn ran nowhere.
    const human = await storage.createTurn({ sessionId: sess.id, sequence: 4, role: 'human', content: 'please' });
    expect(human.runner_image).toBeUndefined();

    // The reviewer's launch never moved the task-level record (banner,
    // recreate rule), which follows the work container only.
    const fresh = (await storage.getTask(task.id))!;
    expect(JSON.parse(fresh.metadata!.runner_image_last!).kind).toBe('readonly');
    // ...and the read-only fallback wrote no default-image CHOICE.
    expect(fresh.metadata?.runner_image_choice ?? '').toBe('');
  });

  test('surfaces show the image as a launch label, flagged when it was the default', () => {
    expect(turnLaunchLabels({ agent: 'claude-code', runner_image: { image: 'lazy-runner:0.91', kind: 'readonly' } }))
      .toContain('image: lazy-runner:0.91 (default image — project image not ready)');
    expect(turnLaunchLabels({ agent: 'claude-code', runner_image: { image: 'lazy-custom-abc:0.91', kind: 'custom' } }))
      .toContain('image: lazy-custom-abc:0.91');
    expect(turnLaunchLabels({ agent: 'claude-code' }).some((l) => l.startsWith('image:'))).toBe(false);
  });
});
