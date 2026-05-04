/**
 * Unit tests for runSyncWithUpstream's SHA-based merge behavior.
 *
 * INVARIANT (fix-sync-no-merge): The supervisor's sync phase MUST merge the
 * exact SHA the daemon resolved on the host, not just the ref name. Previously
 * the supervisor re-resolved `origin/<branch>` inside the container, which
 * produced different results than the daemon's view and short-circuited the
 * sync with a fake "completed successfully" response.
 *
 * These tests pin three behaviors:
 *   1. With upstreamSha provided and HEAD behind → a merge actually happens
 *      and result.merged is true.
 *   2. With upstreamSha provided and HEAD already containing it → merged is
 *      false and pre/post SHA are equal (honest "no-op", not a fake success).
 *   3. checkUpstreamChanges surfaces git errors instead of swallowing them —
 *      an invalid target throws with a clear message (CLAUDE.md "errors are
 *      actionable").
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { runGit } from '../../src/utils/git';
import { runSyncWithUpstream } from '../../src/supervisor/merge';
import { hasUpstreamChanges } from '../../src/git/operations';

async function initRepo(dir: string): Promise<void> {
  await runGit(['init', '-q', '-b', 'main'], { cwd: dir });
  await runGit(['config', 'user.email', 'test@example.com'], { cwd: dir });
  await runGit(['config', 'user.name', 'Test'], { cwd: dir });
  await writeFile(join(dir, 'README.md'), 'init\n');
  await runGit(['add', '.'], { cwd: dir });
  await runGit(['commit', '-q', '-m', 'init'], { cwd: dir });
}

async function headSha(cwd: string): Promise<string> {
  const r = await runGit(['rev-parse', 'HEAD'], { cwd });
  return r.stdout.trim();
}

describe('runSyncWithUpstream: SHA-based merge', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'lazy-merge-test-'));
    await initRepo(repo);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  test('merges when HEAD is behind the provided upstream SHA', async () => {
    // Create a task branch from main, then advance main.
    await runGit(['checkout', '-q', '-b', 'task'], { cwd: repo });
    await runGit(['checkout', '-q', 'main'], { cwd: repo });
    await writeFile(join(repo, 'upstream.txt'), 'new content\n');
    await runGit(['add', '.'], { cwd: repo });
    await runGit(['commit', '-q', '-m', 'upstream change'], { cwd: repo });
    const upstreamSha = await headSha(repo);

    await runGit(['checkout', '-q', 'task'], { cwd: repo });
    const preSha = await headSha(repo);

    const result = await runSyncWithUpstream(repo, 'main', undefined, undefined, upstreamSha);

    expect(result.merged).toBe(true);
    expect(result.preMergeSha).toBe(preSha);
    expect(result.postMergeSha).not.toBe(preSha);
    expect(result.targetSha).toBe(upstreamSha);
    expect(result.conflicts).toEqual([]);
  });

  test('honestly reports "no merge" when HEAD already contains upstream SHA', async () => {
    // Advance main; task is on main too, so HEAD already contains upstream.
    await writeFile(join(repo, 'upstream.txt'), 'upstream\n');
    await runGit(['add', '.'], { cwd: repo });
    await runGit(['commit', '-q', '-m', 'upstream change'], { cwd: repo });
    const upstreamSha = await headSha(repo);
    // Task branch points at same SHA.
    await runGit(['checkout', '-q', '-b', 'task'], { cwd: repo });
    const preSha = await headSha(repo);

    const result = await runSyncWithUpstream(repo, 'main', undefined, undefined, upstreamSha);

    expect(result.merged).toBe(false);
    expect(result.preMergeSha).toBe(preSha);
    expect(result.postMergeSha).toBe(preSha);
    expect(result.targetSha).toBe(upstreamSha);
  });

  // INVARIANT (fix-sync-no-merge): hasUpstreamChanges throws on git failure
  // rather than returning false. The prior silent-false behavior was the
  // exact mechanism that turned broken ref lookups into fake "up to date"
  // responses. This test locks in the throw so a future refactor can't
  // re-introduce the swallow.
  test('hasUpstreamChanges throws on unresolvable target (no silent swallow)', async () => {
    await expect(
      hasUpstreamChanges('definitely-not-a-real-ref-or-sha', repo),
    ).rejects.toThrow(/rev-list HEAD\.\.definitely-not-a-real-ref-or-sha/);
  });

  test('surfaces git errors for unresolvable targets (no silent swallow)', async () => {
    await runGit(['checkout', '-q', '-b', 'task'], { cwd: repo });

    // A bogus SHA that git cannot resolve — checkUpstreamChanges must throw.
    await expect(
      runSyncWithUpstream(repo, 'main', undefined, undefined, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'),
    ).rejects.toThrow(/Failed to resolve merge target/);
  });
});
