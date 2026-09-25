/**
 * E2E: accept's merge-description one-shot must not run inside the project.
 *
 * THE FIELD BUG (fix-accept-oneshot-in-root)
 * ------------------------------------------
 * Accept invokes the agent a third time — `lazy-machine-oneshot/v1`, which
 * writes the merge description — and that run used to inherit the DAEMON's cwd:
 * the project root, checked out on the TARGET branch. An agent that writes a
 * file and commits it (ordinary housekeeping behavior, and exactly what a
 * scripted agent does) therefore landed a commit on `main` in the middle of an
 * accept and manufactured a conflict with the branch being merged. It surfaced
 * as `acceptTask failed (409): Session branch has conflicts with main`, with
 * nothing whatsoever wrong on the task branch.
 *
 * One-shots now run in a throwaway container with NO repo mount when
 * `repoAccess: 'none'` — the structural fix. Task turns stay on the fake-binary
 * host-process seam; the merge-description one-shot is driven through a scriptable
 * `docker` on the daemon's PATH with `LAZY_SUMMARIZER_STUB` cleared.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { existsSync } from 'fs';
import { join } from 'path';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import { createTask, disablePreAccept } from '../helpers/fixtures';
import { successScenario } from '../helpers/fake-claude';
import { seedFinal } from '../helpers/final';
import { installFakeDocker, type FakeDocker } from '../helpers/fake-docker';
import { IMAGE_TAG } from '../../src/capture/claude';

/** Start a task on the fake-binary seam and land one commit lazy can merge. */
async function startTaskWithCommit(ctx: TestContext, taskId: string): Promise<void> {
  await ctx.setClaudeScenario(successScenario({
    result: 'Task work done.',
    sessionId: 'fake-sess-accept-oneshot',
    commit: { message: 'task work', files: [{ path: 'work.txt', content: 'done\n' }] },
  }));

  expectSuccess(await ctx.lazy(['start', taskId, '--yes']));

  const wait = await ctx.lazy(['wait', taskId]);
  if (wait.exitCode !== 0) {
    throw new Error(`wait failed for ${taskId}: ${wait.stderr}\n${wait.stdout}`);
  }
  // Fixture setup, not the subject (see test/helpers/final.ts): the wrap-up
  // turn gets its own plain scenario — the standing one carries a commit step
  // whose re-commit fails — and its present invocation declares the
  // presentation, which a real agent does via lazy_report and the fake does
  // via the marker write (see successScenario's declarePresentation).
  await ctx.setClaudeScenario(successScenario({
    result: 'Wrap-up complete.',
    declarePresentation: true,
  }));
  await seedFinal(ctx, taskId);
}

describe('accept one-shot runs outside the project', () => {
  let ctx: TestContext;
  let docker: FakeDocker;

  beforeEach(async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'lazy-accept-oneshot-'));
    docker = await installFakeDocker(scratch);
    await docker.seedImage(`lazy-runner:${IMAGE_TAG}`);

    ctx = await setupTestLazy({
      fakeClaude: true,
      daemonEnv: {
        LAZY_SUMMARIZER_STUB: '',
        PATH: `${docker.binDir}:${process.env.PATH ?? ''}`,
      },
    });
    // Pre-accept is another scripted agent turn; this suite's subject is accept's
    // merge-description one-shot, not the pre-accept gate.
    disablePreAccept(ctx.root);
    ctx.git('add', 'lazy.toml');
    ctx.git('commit', '-m', 'Disable pre-accept for this suite');
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  function oneshotRuns(): Promise<string[]> {
    return docker.invocations().then(lines => lines.filter(l => l.startsWith('run ')));
  }

  // THE REPRODUCTION. The merge-description one-shot is a container with no repo
  // mount, so even a file-writing agent cannot reach the target branch.
  test('a one-shot container cannot commit onto the target branch', async () => {
    await docker.setOneshotResponse('A faithful summary.');

    const taskId = await createTask(ctx, 'Oneshot cwd goal', 'Do the work');
    await startTaskWithCommit(ctx, taskId);
    expectSuccess(await ctx.lazy(['accept', taskId, '--yes']));

    const runs = await oneshotRuns();
    expect(runs.length).toBeGreaterThan(0);
    for (const run of runs) {
      expect(run).toContain('lazy.oneshot=1');
      expect(run.includes(`${ctx.root}:${ctx.root}`)).toBe(false);
    }

    expect(existsSync(join(ctx.root, 'AGENT_WAS_HERE.md'))).toBe(false);
    expect(ctx.git('status', '--porcelain').stdout.trim()).toBe('');
    expect(existsSync(join(ctx.root, 'work.txt'))).toBe(true);
  }, 180_000);

  test('the synthesized description still lands in the merge commit', async () => {
    await docker.setOneshotResponse('FIDELITY-FROM-ONESHOT: the task did the work.');

    const taskId = await createTask(ctx, 'Oneshot summary goal', 'Do the work');
    await startTaskWithCommit(ctx, taskId);
    expectSuccess(await ctx.lazy(['accept', taskId, '--yes']));

    expect(ctx.git('log', 'main', '-1', '--format=%B').stdout).toContain('FIDELITY-FROM-ONESHOT');
  }, 180_000);
});
