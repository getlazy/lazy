import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';

/**
 * End-to-end coverage for the two git LFS layers.
 *
 * INVARIANT: lazy never lets an agent commit raw file content onto an
 * LFS-tracked path unnoticed. `lazy start` refuses to launch into an LFS-broken
 * environment, and `lazy accept` refuses to merge a branch that already carries
 * such a blob — the second holds even when the first was bypassed, which is the
 * whole reason there are two.
 *
 * The fixture reproduces the reported incident: `filter.lfs.process` set but
 * EMPTY and `filter.lfs.required` false, which is the state where git skips the
 * clean filter and commits raw bytes with exit 0 and no output.
 */
describe('git LFS guard', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    // accept needs a real daemon: start launches the supervisor asynchronously
    // and the reconciler is what moves the task out of 'working'.
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /** Track `datasets/**` with LFS on the target branch. */
  function trackDatasetsWithLfs(): void {
    writeFileSync(join(ctx.root, '.gitattributes'), 'datasets/** filter=lfs -text\n');
    expect(ctx.git('-C', ctx.root, 'add', '.gitattributes').exitCode).toBe(0);
    expect(ctx.git('-C', ctx.root, 'commit', '-m', 'Track datasets with LFS').exitCode).toBe(0);
  }

  /** The incident's config: filters present but empty, required=false. */
  function breakLfsFilter(): void {
    for (const key of ['process', 'clean', 'smudge']) {
      expect(ctx.git('-C', ctx.root, 'config', `filter.lfs.${key}`, '').exitCode).toBe(0);
    }
    expect(ctx.git('-C', ctx.root, 'config', 'filter.lfs.required', 'false').exitCode).toBe(0);
  }

  /**
   * Switch the start-time check to "warn" so a task can still start in the
   * broken environment — that is exactly the state the accept-time backstop
   * exists for. Edits the key rather than overwriting lazy.toml, which would
   * throw away the external_path init wrote.
   */
  function setLfsCheck(mode: 'refuse' | 'warn' | 'off'): void {
    const path = join(ctx.root, 'lazy.toml');
    const before = readFileSync(path, 'utf-8');
    const after = before.replace('# lfs_check = "refuse"', `lfs_check = "${mode}"`);
    expect(after).not.toBe(before);
    writeFileSync(path, after);
  }

  async function startedTask(goal: string): Promise<string> {
    const taskId = await createTask(ctx, goal, 'Some work');
    expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    }));
    const waitResult = await ctx.lazy(['wait', taskId]);
    if (waitResult.exitCode !== 0) {
      throw new Error(`wait failed for ${taskId}: ${waitResult.stderr}\n${waitResult.stdout}`);
    }
    return taskId;
  }

  function commitInWorktree(taskId: string, file: string, content: string, message: string): void {
    const worktree = join(ctx.root, '.lazy', 'worktrees', taskId);
    const full = join(worktree, file);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    expect(ctx.git('-C', worktree, 'add', file).exitCode).toBe(0);
    expect(ctx.git('-C', worktree, 'commit', '-m', message).exitCode).toBe(0);
  }

  /** A syntactically valid LFS pointer — no git-lfs binary needed to write one. */
  function pointer(sizeBytes: number): string {
    return `version https://git-lfs.github.com/spec/v1\noid sha256:${'a'.repeat(64)}\nsize ${sizeBytes}\n`;
  }

  test('start refuses on an LFS repo whose filter would not run', async () => {
    trackDatasetsWithLfs();
    breakLfsFilter();

    const taskId = await createTask(ctx, 'Work on an LFS repo', 'Some work');
    const result = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);
    expectFailure(result);

    const output = result.stdout + result.stderr;
    expect(output).toContain('git LFS');
    // One generic line plus the single diagnosis surface — the remedies live in
    // `lazy doctor`, not here (project convention).
    expect(output).toContain('lazy doctor');

    // Refused BEFORE anything was provisioned: no worktree was left behind.
    const worktrees = ctx.git('-C', ctx.root, 'worktree', 'list');
    expect(worktrees.stdout).not.toContain(taskId);
  });

  test('start is unaffected when the LFS filter is configured', async () => {
    trackDatasetsWithLfs();
    for (const [key, value] of [
      ['process', 'git-lfs filter-process'],
      ['clean', 'git-lfs clean -- %f'],
      ['smudge', 'git-lfs smudge -- %f'],
      ['required', 'true'],
    ]) {
      expect(ctx.git('-C', ctx.root, 'config', `filter.lfs.${key}`, value!).exitCode).toBe(0);
    }

    const taskId = await createTask(ctx, 'Work on a healthy LFS repo', 'Some work');
    expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS));
  });

  // INVARIANT: the guard must be invisible on repos that do not use LFS at all.
  test('start is unaffected on a repo that does not use LFS', async () => {
    breakLfsFilter(); // broken config, but nothing is LFS-tracked
    const taskId = await createTask(ctx, 'Ordinary work', 'Some work');
    expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS));
  });

  test('accept refuses a branch carrying a raw blob on an LFS path', async () => {
    trackDatasetsWithLfs();
    breakLfsFilter();
    setLfsCheck('warn'); // let the task start so the backstop is what is tested

    const taskId = await startedTask('Add a dataset');
    // Committed exactly as the incident did: a broken filter, so git stores the
    // raw bytes with exit 0 and nothing on stderr.
    commitInWorktree(taskId, 'datasets/big.bin', 'A'.repeat(50_000), 'Add training data');

    const result = await ctx.lazy(['accept', taskId, '--yes']);
    expectFailure(result);

    const output = result.stdout + result.stderr;
    expect(output).toContain('datasets/big.bin');
    expect(output).toContain('RAW CONTENT');
    expect(output).toContain('Add training data');
    expect(output).toContain('--approve-file datasets/big.bin');

    // Refused BEFORE merging — the raw blob never reached the target branch.
    expect(ctx.git('-C', ctx.root, 'ls-files', 'datasets/big.bin').stdout.trim()).toBe('');
  });

  test('accept passes when the committed blob is a proper LFS pointer', async () => {
    trackDatasetsWithLfs();
    breakLfsFilter();
    setLfsCheck('warn');

    const taskId = await startedTask('Add a dataset pointer');
    commitInWorktree(taskId, 'datasets/big.bin', pointer(50_000), 'Add training data pointer');

    expectSuccess(await ctx.lazy(['accept', taskId, '--yes']));
    expect(ctx.git('-C', ctx.root, 'ls-files', 'datasets/big.bin').stdout.trim()).toBe('datasets/big.bin');
  });

  test('--approve-file lets a deliberate raw blob through', async () => {
    trackDatasetsWithLfs();
    breakLfsFilter();
    setLfsCheck('warn');

    const taskId = await startedTask('Add a small tracked file as-is');
    commitInWorktree(taskId, 'datasets/notes.txt', 'plain text, deliberately not LFS\n', 'Add notes');

    expectSuccess(await ctx.lazy(['accept', taskId, '--yes', '--approve-file', 'datasets/notes.txt']));
    expect(ctx.git('-C', ctx.root, 'ls-files', 'datasets/notes.txt').stdout.trim()).toBe('datasets/notes.txt');
  });
});
