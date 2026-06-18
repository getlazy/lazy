import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { resolveDetachedHead } from '../../src/git/operations';
import { spawnSync } from '../../src/utils/spawn';

/**
 * INVARIANT: remote_target_branch must never be the literal "HEAD".
 * GitHub's PR API rejects "HEAD" as a base ref ("Base ref must be a branch").
 * resolveDetachedHead converts "HEAD" to the remote's default branch name.
 */
describe('resolveDetachedHead', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lazy-test-detached-'));
    // Initialize a git repo with a commit. Force the initial branch to "master"
    // so the test is deterministic regardless of the machine's
    // init.defaultBranch (modern git defaults to "main") — the remote setup
    // below pushes "master" and sets origin/HEAD to it.
    spawnSync(['git', 'init', '-b', 'master'], { cwd: tmpDir });
    spawnSync(['git', 'config', 'user.email', 'test@test.com'], { cwd: tmpDir });
    spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: tmpDir });
    spawnSync(['git', 'commit', '--allow-empty', '-m', 'init'], { cwd: tmpDir });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('returns branch unchanged when not "HEAD"', async () => {
    expect(await resolveDetachedHead('main', tmpDir)).toBe('main');
    expect(await resolveDetachedHead('develop', tmpDir)).toBe('develop');
    expect(await resolveDetachedHead('feature/foo', tmpDir)).toBe('feature/foo');
  });

  // INVARIANT: "HEAD" must be resolved to a real branch name for GitHub PRs.
  test('resolves "HEAD" to remote default branch when symbolic-ref exists', async () => {
    // Set up a remote with a default branch
    const remoteDir = mkdtempSync(join(tmpdir(), 'lazy-test-remote-'));
    spawnSync(['git', 'init', '--bare'], { cwd: remoteDir });
    spawnSync(['git', 'remote', 'add', 'origin', remoteDir], { cwd: tmpDir });
    spawnSync(['git', 'push', '-u', 'origin', 'master'], { cwd: tmpDir });
    // Set origin/HEAD to point to master
    spawnSync(['git', 'remote', 'set-head', 'origin', 'master'], { cwd: tmpDir });

    const result = await resolveDetachedHead('HEAD', tmpDir, 'origin');
    expect(result).toBe('master');

    rmSync(remoteDir, { recursive: true, force: true });
  });

  // INVARIANT: When symbolic-ref resolution fails, fall back to "main".
  test('falls back to "main" when symbolic-ref resolution fails', async () => {
    // No remote configured — symbolic-ref will fail
    const result = await resolveDetachedHead('HEAD', tmpDir, 'origin');
    expect(result).toBe('main');
  });

  test('uses specified remote name', async () => {
    // Set up a custom remote
    const remoteDir = mkdtempSync(join(tmpdir(), 'lazy-test-remote-'));
    spawnSync(['git', 'init', '--bare'], { cwd: remoteDir });
    spawnSync(['git', 'remote', 'add', 'upstream', remoteDir], { cwd: tmpDir });
    spawnSync(['git', 'push', '-u', 'upstream', 'master'], { cwd: tmpDir });
    spawnSync(['git', 'remote', 'set-head', 'upstream', 'master'], { cwd: tmpDir });

    const result = await resolveDetachedHead('HEAD', tmpDir, 'upstream');
    expect(result).toBe('master');

    rmSync(remoteDir, { recursive: true, force: true });
  });
});
