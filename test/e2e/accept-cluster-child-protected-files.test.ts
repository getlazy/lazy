/**
 * E2E: a cluster's child is never held for a protected-file approval — the
 * cluster's own accept asks instead.
 *
 * THE REGRESSION (engineer, 2026-10-04). Cluster drivers kept parking finished
 * children "awaiting engineer approval of protected regression-test files" and
 * raising blocking items for it, because a child's accept refused without
 * `approved_files`. That question was never a person's at that level: a
 * cluster's children are agent-audience, their accepts are the driver's, and
 * the cluster's own accept already re-asks every protected file an
 * agent-audience child carried up (an agent's approval never counts there).
 * So the child-level gate only held the cluster up — the opposite of what a
 * cluster is for. The engineer decides once, at the cluster.
 *
 * Needs a real daemon: accepting the child is what lands its squash on the
 * cluster's branch, and only the reconciler moves a task out of `working`.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectError } from '../helpers/assertions';
import { disablePreAccept, MOCK_CLAUDE_SUCCESS, setProtectedPatterns } from '../helpers/fixtures';
import { seedFinal } from '../helpers/final';

const ORIGINAL = 'describe("existing", () => {});\n';
const CHILD_EDIT = 'describe("the cluster child changed this", () => {});\n';

describe('a cluster child\'s protected files are decided at the cluster', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
    disablePreAccept(ctx.root);
    setProtectedPatterns(ctx.root, ['*.spec.*']);
    writeFileSync(join(ctx.root, 'a.spec.ts'), ORIGINAL);
    ctx.git('add', 'lazy.toml', 'a.spec.ts');
    ctx.git('commit', '-m', 'Protect specs and seed one');
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function waitForTask(taskId: string): Promise<void> {
    const result = await ctx.lazy(['wait', taskId]);
    if (result.exitCode !== 0) {
      throw new Error(`wait failed for ${taskId}: ${result.stderr}\n${result.stdout}`);
    }
  }

  async function created(args: string[]): Promise<string> {
    const result = await ctx.lazy(['create', ...args]);
    expectSuccess(result);
    return result.stdout.match(/Created task ([a-f0-9]{8})/)![1];
  }

  // INVARIANT: an agent-audience subtask — every child of a cluster, whoever
  // launched it — is accepted with NO protected-file approval, and its files
  // are asked at the cluster's own accept. Pre-fix the child's accept refused
  // naming `a.spec.ts`.
  test('the child accepts without approvals; the cluster\'s accept asks', async () => {
    const clusterId = await created(['--goal', 'Patch cluster', '--prompt', 'Run the children', '--type', 'cluster']);
    // Created BEFORE the cluster's first turn, so its arrival does not wake a
    // parked cluster — the cluster must be parked, not working, for the child's
    // accept to land on its branch from this terminal.
    const childId = await created(['--goal', 'Fix a test', '--prompt', 'Fix it', '--parent', clusterId]);

    expectSuccess(await ctx.lazyMocked(['start', clusterId, '--yes'], MOCK_CLAUDE_SUCCESS));
    await waitForTask(clusterId);

    // Started by a PERSON, deliberately: a cluster's child is agent-audience
    // whoever launched it.
    expectSuccess(await ctx.lazyMocked(['start', childId, '--yes'], MOCK_CLAUDE_SUCCESS));
    await waitForTask(childId);

    const childWorktree = join(ctx.root, '.lazy', 'worktrees', childId);
    writeFileSync(join(childWorktree, 'a.spec.ts'), CHILD_EDIT);
    expect(ctx.git('-C', childWorktree, 'add', 'a.spec.ts').exitCode).toBe(0);
    expect(ctx.git('-C', childWorktree, 'commit', '-m', 'Child rewrites a protected spec').exitCode).toBe(0);
    // Fixture setup, not the subject (see test/helpers/final.ts).
    await seedFinal(ctx, childId);

    // THE ASSERTION: no --approve-file, and the accept goes through — naming
    // the file it carried up and where it will be asked.
    const childAccept = await ctx.lazy(['accept', childId, '--yes']);
    expectSuccess(childAccept);
    const childOutput = childAccept.stdout + childAccept.stderr;
    expect(childOutput).toContain('a.spec.ts');
    expect(childOutput).toContain('own accept');

    // The question did not disappear: the cluster's accept refuses on it...
    await seedFinal(ctx, clusterId);
    const refused = await ctx.lazy(['accept', clusterId, '--yes']);
    expectFailure(refused);
    expectError(refused, 'a.spec.ts');

    // ...until the person decides, once, at the cluster.
    const accepted = await ctx.lazy(['accept', clusterId, '--approve-file', 'a.spec.ts', '--yes']);
    expectSuccess(accepted);
    expect(readFileSync(join(ctx.root, 'a.spec.ts'), 'utf-8')).toBe(CHILD_EDIT);
  }, 180000);
});
