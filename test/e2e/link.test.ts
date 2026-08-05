import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError, extractTaskId } from '../helpers/assertions';

// `lazy link` derives a task code from the PR branch and prints/addresses the
// task by that code, so extractTaskId's hex-short-id match never fits.
function extractLinkedTaskRef(output: string): string {
  const match = output.match(/Linked task (\S+)/);
  if (!match) throw new Error(`Could not extract linked task ref from output: ${output}`);
  return match[1];
}
import { MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';

/**
 * Helper: set up a bare "origin" repo and create+push a branch so that
 * `lazy link` can successfully fetch and create a worktree.
 */
function setupOriginWithBranch(ctx: TestContext, branch: string): void {
  const bareRepo = mkdtempSync(join(tmpdir(), 'lazy-e2e-bare-'));
  Bun.spawnSync(['git', 'init', '--bare', bareRepo]);
  ctx.git('remote', 'add', 'origin', bareRepo);
  ctx.git('branch', branch);
  ctx.git('push', 'origin', branch);
}

/**
 * Helper: run `lazy link` with a mock import result.
 */
function linkWithMock(
  ctx: TestContext,
  mockImport: { goal: string; branch: string; metadata: Record<string, string>; comments?: string[] },
  extraArgs: string[] = [],
) {
  return ctx.lazyMocked(
    ['link', 'https://github.com/org/repo/pull/1', ...extraArgs],
    MOCK_CLAUDE_SUCCESS,
    { env: { LAZY_MOCK_IMPORT_RESULT: JSON.stringify(mockImport) } },
  );
}

describe('lazy link', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('shows usage when no URL provided', async () => {
    const result = await ctx.lazy(['link']);

    expectFailure(result);
    expectOutput(result, 'Usage: lazy link');
  });

  test('shows help with --help flag', async () => {
    const result = await ctx.lazy(['link', '--help']);

    expectSuccess(result);
    expectOutput(result, 'Usage: lazy link');
    expectOutput(result, 'GitHub PRs');
  });

  test('rejects URL when using local driver (no remote configured)', async () => {
    // setupTestLazy initializes with local driver by default
    const result = await ctx.lazy(['link', 'https://github.com/org/repo/pull/1']);

    expectFailure(result);
    expectError(result, 'Cannot link external resources with the current driver');
    expectError(result, 'Configure a remote driver');
  });

  test('rejects invalid code', async () => {
    const result = await ctx.lazy(['link', 'https://github.com/org/repo/pull/1', '--code', 'INVALID CODE!']);

    expectFailure(result);
    expectError(result, 'Invalid code');
  });

  test('rejects unknown flags', async () => {
    const result = await ctx.lazy(['link', 'https://github.com/org/repo/pull/1', '--unknown']);

    expectFailure(result);
    expectError(result, 'Unknown flag');
  });

  test('rejects link when branch already has a worktree', async () => {
    const branch = 'feature/existing-pr';

    // Set up a bare repo as "origin" so git fetch works
    const bareRepo = mkdtempSync(join(tmpdir(), 'lazy-e2e-bare-'));
    Bun.spawnSync(['git', 'init', '--bare', bareRepo]);
    ctx.git('remote', 'add', 'origin', bareRepo);

    // Create the branch locally and push it to origin
    ctx.git('branch', branch);
    ctx.git('push', 'origin', branch);

    // Create a worktree for that branch so it's "already checked out"
    const worktreePath = join(ctx.root, 'existing-worktree');
    ctx.git('worktree', 'add', worktreePath, branch);

    // Mock the import result to return the same branch
    const mockImport = JSON.stringify({
      goal: 'Test PR',
      branch,
      metadata: { github_remote_ref_url: 'https://github.com/org/repo/pull/1' },
      comments: [],
    });

    const result = await ctx.lazyMocked(
      ['link', 'https://github.com/org/repo/pull/1'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_IMPORT_RESULT: mockImport } },
    );

    expectFailure(result);
    expectError(result, `Branch '${branch}' already has a worktree`);
    expectError(result, 'Cannot link');
  });

  test('auto-derives code from branch name', async () => {
    const branch = 'ivan/deno-v2';
    setupOriginWithBranch(ctx, branch);

    const result = await linkWithMock(ctx, {
      goal: 'Some PR title',
      branch,
      metadata: { github_remote_ref_url: 'https://github.com/org/repo/pull/1' },
      comments: [],
    });

    expectSuccess(result);
    // The code should be derived from the branch: "ivan/deno-v2" → "ivan-deno-v2"
    expectOutput(result, 'ivan-deno-v2');
  });

  test('auto-derived code truncates to 80 chars', async () => {
    const branch = 'feature/' + 'a-long-segment-'.repeat(10) + 'end';
    setupOriginWithBranch(ctx, branch);

    const result = await linkWithMock(ctx, {
      goal: 'Long branch PR',
      branch,
      metadata: { github_remote_ref_url: 'https://github.com/org/repo/pull/1' },
      comments: [],
    });

    expectSuccess(result);
    const taskId = extractLinkedTaskRef(result.stdout);
    const showResult = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult);
    // Code should be at most 80 chars, derived from branch
    // Extract the code from show output and verify length
    const codeMatch = showResult.stdout.match(/Code:\s+(\S+)/);
    expect(codeMatch).not.toBeNull();
    expect(codeMatch![1].length).toBeLessThanOrEqual(80);
  });

  test('explicit --code overrides auto-derived code', async () => {
    const branch = 'ivan/deno-v2';
    setupOriginWithBranch(ctx, branch);

    const result = await linkWithMock(ctx, {
      goal: 'Some PR title',
      branch,
      metadata: { github_remote_ref_url: 'https://github.com/org/repo/pull/1' },
      comments: [],
    }, ['--code', 'my-custom-code']);

    expectSuccess(result);
    // The explicit code should be used, not the derived one
    const taskId = extractLinkedTaskRef(result.stdout);
    const showResult = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult);
    expectOutput(showResult, 'my-custom-code');
  });

  test('cleans up branch-like PR titles in goal', async () => {
    const branch = 'ivan/deno-v2';
    setupOriginWithBranch(ctx, branch);

    const result = await linkWithMock(ctx, {
      goal: 'Ivan/deno v2',
      branch,
      metadata: { github_remote_ref_url: 'https://github.com/org/repo/pull/1' },
      comments: [],
    });

    expectSuccess(result);
    // "Ivan/deno v2" contains `/` so should be cleaned: "Ivan: Deno V2"
    expectOutput(result, 'Ivan: Deno V2');
  });

  test('preserves normal PR titles as-is', async () => {
    const branch = 'feature/auth-fix';
    setupOriginWithBranch(ctx, branch);

    const result = await linkWithMock(ctx, {
      goal: 'Fix authentication timeout bug',
      branch,
      metadata: { github_remote_ref_url: 'https://github.com/org/repo/pull/1' },
      comments: [],
    });

    expectSuccess(result);
    // Normal title (no `/`) should be preserved as-is
    expectOutput(result, 'Fix authentication timeout bug');
  });

  test('linked task is editable (no agent has run)', async () => {
    const branch = 'feature/editable-task';
    setupOriginWithBranch(ctx, branch);

    const result = await linkWithMock(ctx, {
      goal: 'Test editability',
      branch,
      metadata: { github_remote_ref_url: 'https://github.com/org/repo/pull/1' },
      comments: [],
    });
    expectSuccess(result);

    const taskId = extractLinkedTaskRef(result.stdout);

    // Should be able to edit goal on a linked task
    const editResult = await ctx.lazy(['edit', taskId, '--goal', 'Updated goal']);
    expectSuccess(editResult);
    expectOutput(editResult, 'Updated goal: Updated goal');

    // Should be able to edit code
    const editCode = await ctx.lazy(['edit', taskId, '--code', 'new-code']);
    expectSuccess(editCode);
    expectOutput(editCode, 'Updated code: new-code');
  });
});
