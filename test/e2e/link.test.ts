import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError, expectOutputExcludes } from '../helpers/assertions';
import { storageDirFor, readTaskJson } from '../helpers/storage';
import { FileStorage } from '../../src/storage/file-storage';
import { attachLinkedPullRequests } from '../../src/daemon/remote-sync';
import type { RepositoryDriver, ImportResult, RemoteComment } from '../../src/remote/driver';
import { IMPORT_SOURCE_URL_KEY, IMPORT_SOURCE_BRANCH_KEY } from '../../src/task/linked';

// `lazy link` derives a task code from the PR branch and prints/addresses the
// task by that code, so extractTaskId's hex-short-id match never fits.
function extractLinkedTaskRef(output: string): string {
  const match = output.match(/Linked task (\S+)/);
  if (!match) throw new Error(`Could not extract linked task ref from output: ${output}`);
  return match[1];
}
import { MOCK_CLAUDE_SUCCESS, createTask } from '../helpers/fixtures';

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
  mockImport: { goal: string; branch: string; metadata: Record<string, string>; comments?: RemoteComment[] },
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

  test('auto-derived code truncates to 63 chars', async () => {
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
    // Code should be at most 63 chars (the DNS label limit a code has to fit),
    // derived from branch. Extract the code from show output and verify length.
    const codeMatch = showResult.stdout.match(/Code:\s+(\S+)/);
    expect(codeMatch).not.toBeNull();
    expect(codeMatch![1].length).toBeLessThanOrEqual(63);
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

  test('links a bare branch with the local driver', async () => {
    const branch = 'feature/colleague-work';
    setupOriginWithBranch(ctx, branch);

    const result = await ctx.lazy(['link', branch, '--code', 'colleague-work']);
    expectSuccess(result);
    expectOutput(result, 'Linked task colleague-work');
    expectOutput(result, `Branch:   ${branch}`);
    expectOutput(result, 'Status:   blocked');

    const show = await ctx.lazy(['show', 'colleague-work']);
    expectSuccess(show);
    expectOutput(show, 'Linked:');
    expectOutput(show, branch);

    const list = await ctx.lazy(['list']);
    expectSuccess(list);
    expectOutput(list, '[linked]');
  });

  test('links origin/branch by splitting a known remote', async () => {
    const branch = 'feature/from-origin';
    setupOriginWithBranch(ctx, branch);

    const result = await ctx.lazy(['link', `origin/${branch}`, '--code', 'from-origin']);
    expectSuccess(result);
    expectOutput(result, `Branch:   ${branch}`);
  });

  test('attaches an open PR when the forge fake finds one for the branch', async () => {
    const branch = 'feature/has-pr';
    setupOriginWithBranch(ctx, branch);

    const found: ImportResult = {
      goal: 'Found existing PR',
      branch,
      metadata: {
        github_remote_ref_url: 'https://github.com/org/repo/pull/5',
        github_remote_ref_id: '5',
        github_remote_ref_state: 'OPEN',
      },
      comments: [],
    };

    const result = await ctx.lazyMocked(
      ['link', branch, '--code', 'has-pr'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_FIND_PR_RESULT: JSON.stringify(found) } },
    );
    expectSuccess(result);
    expectOutput(result, 'Found existing PR');
    expectOutput(result, 'https://github.com/org/repo/pull/5');

    const show = await ctx.lazy(['show', 'has-pr']);
    expectSuccess(show);
    expectOutput(show, 'Linked:');
    expectOutput(show, 'PR #5');
  });

  test('later PR discovery attaches a PR opened after the branch was linked', async () => {
    const branch = 'feature/later-pr';
    setupOriginWithBranch(ctx, branch);

    const result = await ctx.lazy(['link', branch, '--code', 'later-pr']);
    expectSuccess(result);
    const showBefore = await ctx.lazy(['show', 'later-pr']);
    expectSuccess(showBefore);
    expectOutput(showBefore, 'Linked:');
    expectOutputExcludes(showBefore, 'PR #');

    const storage = new FileStorage(ctx.root, { basePath: storageDirFor(ctx.root) });
    await storage.initialize();
    try {
      const driver = {
        hasRemoteRef: (task: { metadata?: Record<string, string> }) =>
          !!task.metadata?.github_remote_ref_id,
        findPullRequestForBranch: async (name: string) => {
          if (name !== branch) return null;
          return {
            goal: 'Opened later',
            branch: name,
            metadata: {
              github_remote_ref_url: 'https://github.com/org/repo/pull/88',
              github_remote_ref_id: '88',
              github_remote_ref_state: 'OPEN',
              [IMPORT_SOURCE_URL_KEY]: 'SHOULD_NOT_WIN',
              [IMPORT_SOURCE_BRANCH_KEY]: 'SHOULD_NOT_WIN',
            },
            comments: [],
          };
        },
      } as unknown as RepositoryDriver;

      const { attached } = await attachLinkedPullRequests(storage, driver);
      expect(attached).toBe(1);
    } finally {
      await storage.close();
    }

    const showAfter = await ctx.lazy(['show', 'later-pr']);
    expectSuccess(showAfter);
    expectOutput(showAfter, 'PR #88');
    expectOutput(showAfter, branch);

    const uuidMatch = (await ctx.lazy(['show', 'later-pr', '--full'])).stdout.match(/ID:\s+([a-f0-9-]{36})/);
    expect(uuidMatch).not.toBeNull();
    const meta = readTaskJson(ctx.root, uuidMatch![1].slice(0, 8)).metadata as Record<string, string>;
    expect(meta[IMPORT_SOURCE_URL_KEY]).toBe(branch);
    expect(meta[IMPORT_SOURCE_BRANCH_KEY]).toBe(branch);
  });

  test('keeps --parent when linking a branch', async () => {
    const parentId = await createTask(ctx, 'Parent of linked');

    const branch = 'feature/child-link';
    setupOriginWithBranch(ctx, branch);
    const result = await ctx.lazy(['link', branch, '--parent', parentId, '--code', 'child-link']);
    expectSuccess(result);
    expectOutput(result, 'Parent:');
  });

  test('rejects a URL that is not a PR, MR, or branch page', async () => {
    const result = await ctx.lazy(['link', 'https://github.com/org/repo/issues/1']);
    expectFailure(result);
    expectError(result, 'not a pull request, merge request, or branch page');
  });

  test('refuses a dash-prefixed branch and creates no task', async () => {
    // `--upload-pack=…` as argv[2] would be an unknown CLI flag. The
    // `origin/` form reaches the daemon as a remote+branch pair.
    const result = await ctx.lazy(['link', 'origin/--upload-pack=evil']);
    expectFailure(result);
    expectError(result, "starting with '-'");

    const list = await ctx.lazy(['list', '--all']);
    expectSuccess(list);
    expectOutputExcludes(list, '[linked]');
  });

  test('writes a generated description as the linked task prompt', async () => {
    const branch = 'feature/described';
    setupOriginWithBranch(ctx, branch);

    const result = await linkWithMock(ctx, {
      goal: 'Add retry to the uploader',
      branch,
      metadata: { github_remote_ref_url: 'https://github.com/org/repo/pull/7' },
      comments: [{ forge: 'github', kind: 'issue_comment', id: '1', body: 'please cover the 429 case too', author: 'reviewer', createdAt: '2026-09-01T00:00:00Z' }],
    }, ['--code', 'described']);
    expectSuccess(result);
    expectOutput(result, 'Describe the task from its branch and PR');

    const show = await ctx.lazy(['show', 'described']);
    expectSuccess(show);
    expectOutput(show, 'Prompt');
    expectOutput(show, '[link-describe]');
    // The imported PR comments are part of what the description is written from.
    expectOutput(show, 'Comments in prompt: yes');
    // A PR title is the author's own words — describing never rewrites it.
    expectOutput(show, 'Add retry to the uploader');
  });

  test('regenerates the goal when the linked branch has no pull request', async () => {
    const branch = 'feature/no-pr-goal';
    setupOriginWithBranch(ctx, branch);

    const result = await ctx.lazyMocked(
      ['link', branch, '--code', 'no-pr-goal'],
      MOCK_CLAUDE_SUCCESS,
    );
    expectSuccess(result);
    // Without a PR the goal was the branch name; the generated one replaces it.
    expectOutput(result, `Goal:     Describe ${branch}`);
  });

  test('still links, with a warning, when the description cannot be generated', async () => {
    const branch = 'feature/describe-fails';
    setupOriginWithBranch(ctx, branch);

    const result = await ctx.lazyMocked(
      ['link', branch, '--code', 'describe-fails'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_LINK_DESCRIBE_FAIL: '1' } },
    );
    expectSuccess(result);
    expectOutput(result, 'Linked task describe-fails');
    expectError(result, 'Could not generate a description');
    expectError(result, 'lazy describe describe-fails');

    const show = await ctx.lazy(['show', 'describe-fails']);
    expectSuccess(show);
    expectOutput(show, '(no prompt yet)');
  });

  test('lazy describe regenerates the description of a linked task', async () => {
    const branch = 'feature/describe-retry';
    setupOriginWithBranch(ctx, branch);

    const linked = await ctx.lazyMocked(
      ['link', branch, '--code', 'describe-retry'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_LINK_DESCRIBE_FAIL: '1' } },
    );
    expectSuccess(linked);

    const described = await ctx.lazyMocked(
      ['describe', 'describe-retry'],
      MOCK_CLAUDE_SUCCESS,
    );
    expectSuccess(described);
    expectOutput(described, 'Described task describe-retry');
    expectOutput(described, 'characters written');

    const show = await ctx.lazy(['show', 'describe-retry']);
    expectSuccess(show);
    expectOutput(show, '[link-describe]');
    expectOutput(show, branch);
  });

  test('describes the branch against the remote base, not a stale local main', async () => {
    // INVARIANT: the description's diff base comes from the shared resolver, so
    // it is the ref the branch was cut from as accept sees it. lazy never updates
    // the human's local `main`, so reading it raw puts every upstream commit the
    // branch merged in into the description as if this branch had written it.
    const branch = 'feature/merged-upstream';
    setupOriginWithBranch(ctx, branch);
    // A forge driver, which is what linking a PR needs: the resolver then routes
    // a protected/remote-owned parent to `origin/main`, exactly as accept does.
    const tomlPath = join(ctx.root, 'lazy.toml');
    const toml = await Bun.file(tomlPath).text();
    const patched = toml.replace('driver = "local"', 'driver = "github"');
    expect(patched).not.toBe(toml);
    await Bun.write(tomlPath, patched);

    // Upstream work lands on origin/main, and the local main is left behind it.
    await Bun.write(join(ctx.root, 'upstream-file.txt'), 'upstream work\n');
    ctx.git('add', 'upstream-file.txt');
    ctx.git('commit', '-m', 'Upstream work nobody on this branch wrote');
    ctx.git('push', 'origin', 'main');
    ctx.git('reset', '--hard', 'HEAD~1');

    // The linked branch does its own work and then merges upstream in, the way a
    // long-lived PR does.
    ctx.git('checkout', branch);
    await Bun.write(join(ctx.root, 'branch-file.txt'), 'branch work\n');
    ctx.git('add', 'branch-file.txt');
    ctx.git('commit', '-m', 'Branch work');
    ctx.git('merge', '--no-edit', 'origin/main');
    ctx.git('push', 'origin', branch);
    ctx.git('checkout', 'main');

    const result = await ctx.lazyMocked(
      ['link', branch, '--code', 'merged-upstream'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_NEEDS_SYNC: '1', LAZY_MOCK_UPSTREAM_REMOTE: '1' } },
    );
    expectSuccess(result);

    const show = await ctx.lazy(['show', 'merged-upstream']);
    expectSuccess(show);
    // The branch's own work is described...
    expectOutput(show, 'branch-file.txt');
    // ...and the upstream commit it merged is not attributed to it.
    expectOutputExcludes(show, 'upstream-file.txt');
    expectOutputExcludes(show, 'Upstream work nobody on this branch wrote');
  });

  test('lazy describe asks before replacing a hand-edited prompt', async () => {
    const branch = 'feature/hand-edited';
    setupOriginWithBranch(ctx, branch);

    const linked = await ctx.lazyMocked(
      ['link', branch, '--code', 'hand-edited'],
      MOCK_CLAUDE_SUCCESS,
    );
    expectSuccess(linked);

    // The human rewrites the prompt into their own instructions.
    const edited = await ctx.lazy(['edit', 'hand-edited', '--prompt', 'Only fix the retry loop, nothing else.']);
    expectSuccess(edited);

    // Non-interactive and without --yes: refused, prompt untouched.
    const refused = await ctx.lazyMocked(['describe', 'hand-edited'], MOCK_CLAUDE_SUCCESS);
    expectFailure(refused);
    expectError(refused, 'has been edited since lazy last wrote it');
    const afterRefusal = await ctx.lazy(['show', 'hand-edited']);
    expectOutput(afterRefusal, 'Only fix the retry loop');

    // With --yes: regenerated, and the human's text survives as a version.
    const forced = await ctx.lazyMocked(['describe', 'hand-edited', '--yes'], MOCK_CLAUDE_SUCCESS);
    expectSuccess(forced);
    const afterForce = await ctx.lazy(['show', 'hand-edited']);
    expectOutput(afterForce, '[link-describe]');
    expectOutputExcludes(afterForce, 'Only fix the retry loop');
  });

  test('a generated description says where it came from', async () => {
    const branch = 'feature/provenance';
    setupOriginWithBranch(ctx, branch);

    const result = await linkWithMock(ctx, {
      goal: 'Someone else PR',
      branch,
      metadata: { github_remote_ref_url: 'https://github.com/org/repo/pull/9' },
      comments: [],
    }, ['--code', 'provenance']);
    expectSuccess(result);

    const show = await ctx.lazy(['show', 'provenance']);
    expectSuccess(show);
    // The prompt is instructions to whoever picks the task up, and it was
    // written out of someone else's PR — it has to say so.
    expectOutput(show, 'Written by lazy');
    expectOutput(show, 'https://github.com/org/repo/pull/9');
    expectOutput(show, 'not an instruction from this project');
  });

  test('lazy describe is discoverable from the CLI', async () => {
    const help = await ctx.lazy(['describe', '--help']);
    expectSuccess(help);
    expectOutput(help, 'Usage: lazy describe');

    const noArgs = await ctx.lazy(['describe']);
    expectFailure(noArgs);
    expectOutput(noArgs, 'Usage: lazy describe');
  });

  test('lazy describe refuses a task lazy created itself', async () => {
    const taskId = await createTask(ctx, 'An ordinary task');

    const result = await ctx.lazyMocked(['describe', taskId], MOCK_CLAUDE_SUCCESS);
    expectFailure(result);
    expectError(result, 'was not created by `lazy link`');
  });

  test('warns when the local branch is not a fast-forward of origin', async () => {
    const branch = 'feature/local-ahead';
    setupOriginWithBranch(ctx, branch);
    ctx.git('checkout', branch);
    ctx.git('commit', '--allow-empty', '-m', 'local-only commit');
    ctx.git('checkout', 'main');

    const result = await ctx.lazy(['link', branch, '--code', 'local-ahead']);
    expectSuccess(result);
    expectError(result, 'tracks the local branch');
    expectError(result, 'local-only');
  });
});
