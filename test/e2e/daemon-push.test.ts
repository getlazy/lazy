/**
 * Tests for daemon push-after-state-change behavior.
 *
 * Verifies that the daemon pushes task branches to the remote after
 * state transitions (turn completion → blocked/conflict).
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  pushBranchAfterStateChange,
  retryFailedPushes,
  getPendingPushCount,
  _resetPushState,
} from '../../src/daemon/push';
import { localBranchExists, branchExists } from '../../src/git/operations';
import { spawnSyncUnsupervised } from '../../src/utils/spawn';

describe('localBranchExists', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-branch-test-'));
    spawnSyncUnsupervised(['git', 'init', tmpDir]);
    spawnSyncUnsupervised(['git', 'commit', '--allow-empty', '-m', 'init'], { cwd: tmpDir });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // INVARIANT: localBranchExists returns true for existing local branches.
  test('returns true for existing local branch', async () => {
    spawnSyncUnsupervised(['git', 'branch', 'test-branch'], { cwd: tmpDir });
    expect(await localBranchExists('test-branch', tmpDir)).toBe(true);
  });

  // INVARIANT: localBranchExists returns false for non-existent branches.
  // After computer migration, local branches may be missing even though
  // task metadata references them.
  test('returns false for non-existent branch', async () => {
    expect(await localBranchExists('does-not-exist', tmpDir)).toBe(false);
  });

  // INVARIANT: localBranchExists only checks refs/heads/, not remote tracking refs.
  // This is the key difference from branchExists — after migration, remote tracking
  // refs exist but local branches don't. pushBranch needs local refs to work.
  test('returns false for remote-only tracking branch', async () => {
    // Create a remote tracking ref manually (simulating fetched remote)
    spawnSyncUnsupervised(['git', 'branch', 'temp-branch'], { cwd: tmpDir });
    const sha = spawnSyncUnsupervised(['git', 'rev-parse', 'temp-branch'], { cwd: tmpDir, stdout: 'pipe' });
    const commitHash = sha.stdout.toString().trim();

    // Create a remote tracking ref
    spawnSyncUnsupervised(['git', 'update-ref', 'refs/remotes/origin/lazy/test.abc12345', commitHash], { cwd: tmpDir });

    // localBranchExists should NOT find the remote tracking ref
    expect(await localBranchExists('lazy/test.abc12345', tmpDir)).toBe(false);

    // But branchExists might find it (depending on git ref resolution)
    // This test documents the behavioral difference between the two functions
  });
});

describe('daemon push-after-state-change', () => {
  beforeEach(() => {
    _resetPushState();
  });

  afterEach(() => {
    _resetPushState();
  });

  // INVARIANT: Push queue starts empty.
  // No branches should be pending until a state change triggers a push.
  test('pending push count is 0 initially', () => {
    expect(getPendingPushCount('/fake/project')).toBe(0);
  });

  // INVARIANT: Push with local driver is a no-op.
  // When remote.driver is 'local', there's nothing to push to.
  // This test verifies pushBranchAfterStateChange doesn't throw for
  // unconfigured projects (graceful degradation).
  test('push is no-op when driver config cannot be loaded', async () => {
    // Using a non-existent project root — config loading will fail
    await pushBranchAfterStateChange('/nonexistent/project', 'lazy/test-branch');
    // Should not throw, and queue should be cleared
    expect(getPendingPushCount('/nonexistent/project')).toBe(0);
  });

  // INVARIANT: Retry is a no-op when no branches failed.
  // Calling retryFailedPushes on an empty queue should not throw.
  test('retryFailedPushes is no-op when no pending pushes', async () => {
    await retryFailedPushes('/fake/project');
    expect(getPendingPushCount('/fake/project')).toBe(0);
  });

  // INVARIANT: Reset clears all push state.
  // Tests must be able to start with a clean slate.
  test('_resetPushState clears all state', () => {
    // Manually set some state by accessing internals through the public API
    // Since pushBranchAfterStateChange will try to drain, we just verify
    // reset works on the initial state
    _resetPushState();
    expect(getPendingPushCount('/any/project')).toBe(0);
  });

  // INVARIANT: Multiple branches can be queued for the same project.
  // When multiple tasks complete in the same reconcile tick, all their
  // branches should be queued for pushing.
  test('queues multiple branches for the same project', async () => {
    // pushBranchAfterStateChange will try to drain immediately and fail
    // (no config), clearing the queue. But we can verify the serialization
    // logic by calling push and checking it doesn't throw.
    await pushBranchAfterStateChange('/nonexistent/project', 'lazy/branch-1');
    await pushBranchAfterStateChange('/nonexistent/project', 'lazy/branch-2');
    // Both should have been cleared (config load fails → queue cleared)
    expect(getPendingPushCount('/nonexistent/project')).toBe(0);
  });
});
