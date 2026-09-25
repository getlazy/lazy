import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError, extractTaskId } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { readTaskJson, writeTaskJson } from '../helpers/storage';
import { REVIEW_MODE_METADATA_KEY } from '../../src/review/mode';

describe('lazy create', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('creates a task with --goal flag', async () => {
    const result = await ctx.lazy(['create', '--goal', 'Add authentication']);

    expectSuccess(result);
    expectOutput(result, 'Created task');
    expectOutput(result, 'Add authentication');
    expectOutput(result, 'backlog');
  });

  test('creates a task with --goal and --prompt', async () => {
    const result = await ctx.lazy(['create', '--goal', 'Add auth', '--prompt', 'Implement OAuth2 login flow']);

    expectSuccess(result);
    expectOutput(result, 'Created task');
    expectOutput(result, 'Add auth');
    expectOutput(result, 'v1');
  });

  test('creates a task with --model flag', async () => {
    const result = await ctx.lazy(['create', '--goal', 'Fix bug', '--model', 'claude-opus-4-6']);

    expectSuccess(result);
    expectOutput(result, 'claude-opus-4-6');
  });

  // INVARIANT: There is no model-name allowlist/registry. validateModel accepts
  // any non-empty string and defers name resolution to the Claude CLI, so an
  // unrecognized-looking name is NOT rejected by lazy — only an empty model is.
  // Do NOT reinstate model-name validation here (see persist-model-change / the
  // matching invariant in edit.test.ts).
  test('accepts arbitrary model names but rejects an empty one', async () => {
    // Any non-empty string is accepted and passed through verbatim.
    const ok = await ctx.lazy(['create', '--goal', 'Fix', '--model', 'some-custom-model']);
    expectSuccess(ok);
    expectOutput(ok, 'some-custom-model');

    // An empty model string is still refused.
    const empty = await ctx.lazy(['create', '--goal', 'Fix', '--model', '']);
    expectFailure(empty);
    expectError(empty, 'Model name cannot be empty');
  });

  test('fails without TTY when no flags provided', async () => {
    const result = await ctx.lazy(['create']);

    expectFailure(result);
    expectError(result, 'Interactive mode requires a TTY');
  });

  test('created task appears in list', async () => {
    await ctx.lazy(['create', '--goal', 'Test task for listing']);
    const listResult = await ctx.lazy(['list']);

    expectSuccess(listResult);
    expectOutput(listResult, 'Test task for listing');
  });

  test('created task can be shown by short ID', async () => {
    const createResult = await ctx.lazy(['create', '--goal', 'Showable task', '--prompt', 'Some prompt']);
    const taskId = extractTaskId(createResult.stdout);

    const showResult = await ctx.lazy(['show', taskId]);

    expectSuccess(showResult);
    expectOutput(showResult, 'Showable task');
    expectOutput(showResult, 'backlog');
  });

  test('creates a child task with --parent flag', async () => {
    const parentId = await createTask(ctx, 'Parent umbrella task');

    const result = await ctx.lazy(['create', '--goal', 'Child task', '--parent', parentId]);

    expectSuccess(result);
    expectOutput(result, 'Created task');
    expectOutput(result, 'Child task');
    expectOutput(result, `Parent: ${parentId}`);
  });

  test('child task shows parent in lazy show', async () => {
    const parentId = await createTask(ctx, 'Parent umbrella task');
    const childResult = await ctx.lazy(['create', '--goal', 'Child task', '--parent', parentId]);
    const childId = extractTaskId(childResult.stdout);

    const showResult = await ctx.lazy(['show', childId]);

    expectSuccess(showResult);
    expectOutput(showResult, 'Parent Task:');
    expectOutput(showResult, parentId);
    expectOutput(showResult, 'Parent umbrella task');
  });

  test('parent task shows child in lazy show', async () => {
    const parentId = await createTask(ctx, 'Parent umbrella task');
    await ctx.lazy(['create', '--goal', 'Child task', '--parent', parentId]);

    const showResult = await ctx.lazy(['show', parentId]);

    expectSuccess(showResult);
    expectOutput(showResult, 'Child Tasks (variants):');
    expectOutput(showResult, 'Child task');
  });

  // INVARIANT: A parent in a terminal state cannot be assigned via create.
  // `close` moves a task to the 'abandoned' terminal status (there is no literal
  // 'closed' status — see VALID_TRANSITIONS), and the rejection reports the
  // actual status.
  test('rejects terminal-state parent', async () => {
    const parentId = await createTask(ctx, 'Will be closed');
    // Close the parent task → status becomes 'abandoned'
    await ctx.lazy(['close', parentId, '--reason', 'Done']);

    const result = await ctx.lazy(['create', '--goal', 'Child task', '--parent', parentId]);

    expectFailure(result);
    expectError(result, 'task is abandoned');
  });

  // INVARIANT (fix-target-adoption): when the user runs `lazy create` while
  // checked out on a non-default branch, the task target MUST NOT silently
  // adopt that branch. Top-level tasks target the repo default (origin/HEAD
  // → main) unless --parent is passed explicitly. Adopting the checked-out
  // branch produced PRs against dead release bases.
  test('does NOT adopt current branch as target when --parent is omitted', async () => {
    // Create and check out a feature branch in the test repo
    const branchResult = ctx.git('checkout', '-b', 'some-feature');
    expect(branchResult.exitCode).toBe(0);

    const result = await ctx.lazy(['create', '--goal', 'No-parent task']);
    expectSuccess(result);
    const taskId = extractTaskId(result.stdout);

    // The persisted target should NOT be 'some-feature'. We read it via show.
    const showResult = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult);
    if (showResult.stdout.includes('some-feature')) {
      throw new Error(`Task adopted the current branch 'some-feature' as its target — should default to repo default. show output:\n${showResult.stdout}`);
    }
  });

  test('--parent accepts a raw branch name and persists it as target', async () => {
    const branchResult = ctx.git('checkout', '-b', 'release-x');
    expect(branchResult.exitCode).toBe(0);
    // Switch back to main so the test isn't relying on current-branch behavior
    ctx.git('checkout', 'main');

    const result = await ctx.lazy(['create', '--goal', 'Explicit branch parent', '--parent', 'release-x']);
    expectSuccess(result);
    expectOutput(result, 'Target: branch release-x');
  });

  // INVARIANT (fix-target-adoption): the explicit `--parent <branch>` flag
  // always wins, even when it disagrees with the currently checked-out branch.
  // This is the user's escape hatch from the new default-branch behavior:
  // "I really do want main, even though I'm on some-feature." Without this
  // invariant, the explicit-vs-default story collapses: the user couldn't
  // override the default in either direction.
  test('--parent main wins over the currently checked-out feature branch', async () => {
    const branchResult = ctx.git('checkout', '-b', 'some-feature');
    expect(branchResult.exitCode).toBe(0);
    // Do NOT switch back — we want to prove the explicit flag wins even while
    // checked out on the "wrong" branch.

    const result = await ctx.lazy(['create', '--goal', 'Explicit main', '--parent', 'main']);
    expectSuccess(result);
    expectOutput(result, 'Target: branch main');

    const taskId = extractTaskId(result.stdout);
    const showResult = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult);
    // The persisted target must be 'main', NOT 'some-feature'.
    if (showResult.stdout.includes('some-feature')) {
      throw new Error(`Explicit --parent main was overridden by current branch 'some-feature'. show output:\n${showResult.stdout}`);
    }
  });

  test('--parent rejects a lazy/* task ref as branch', async () => {
    const branchResult = ctx.git('checkout', '-b', 'lazy/some-task');
    expect(branchResult.exitCode).toBe(0);
    ctx.git('checkout', 'main');

    const result = await ctx.lazy(['create', '--goal', 'Bad parent', '--parent', 'lazy/some-task']);
    expectFailure(result);
    expectError(result, 'not a lazy task branch');
  });

  test('rejects non-existent parent', async () => {
    const result = await ctx.lazy(['create', '--goal', 'Child task', '--parent', 'nonexist0']);

    expectFailure(result);
    // --parent now accepts a raw branch name too, so the error mentions both
    // failure modes (not a task, not a branch).
    expectError(result, 'neither a known task nor a local git branch');
  });

  test('creates a task with --type refactor', async () => {
    const result = await ctx.lazy(['create', '--goal', 'Refactor auth module', '--type', 'refactor']);

    expectSuccess(result);
    expectOutput(result, 'Created task');
    expectOutput(result, 'Refactor auth module');

    const taskId = extractTaskId(result.stdout);
    const showResult = await ctx.lazy(['show', taskId]);

    expectSuccess(showResult);
    expectOutput(showResult, 'Type:    refactor');
  });

  test('creates a task without --type and defaults to task', async () => {
    const result = await ctx.lazy(['create', '--goal', 'Default type test']);

    expectSuccess(result);
    expectOutput(result, 'Created task');

    const taskId = extractTaskId(result.stdout);
    const showResult = await ctx.lazy(['show', taskId]);

    expectSuccess(showResult);
    expectOutput(showResult, 'Type:    task');
  });

  test('fails with invalid type', async () => {
    const result = await ctx.lazy(['create', '--goal', 'Test', '--type', 'invalid-type']);

    expectFailure(result);
    expectError(result, 'Invalid type');
  });

  test('starting child task before parent fails with clear error', async () => {
    // Create parent task (but don't start it)
    const parentId = await createTask(ctx, 'Not yet started parent');

    // Create child task with --parent
    const childResult = await ctx.lazy(['create', '--goal', 'Child task', '--parent', parentId, '--prompt', 'Do child work']);
    expectSuccess(childResult);
    const childId = extractTaskId(childResult.stdout);

    // Try to start child task before parent is started
    const startChildResult = await ctx.lazy(['start', childId, '--yes']);
    expectFailure(startChildResult);
    expectError(startChildResult, 'Cannot start child task');
    expectError(startChildResult, 'parent task has no worktree');
    expectError(startChildResult, `lazy start ${parentId}`);
  });
});

describe('lazy create --parent (started tasks)', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    // This test starts BOTH the parent and the child and inspects their
    // worktree branches after the turn is reconciled. `start` + turn
    // reconciliation require a real daemon (post-v0.11 the CLI goes through the
    // daemon for storage and turn processing), so it runs withDaemon and waits
    // for each task to reach blocked before reading git state.
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: Child tasks created via `create --parent` must branch from the
  // parent's current HEAD at start time, not from main. This prevents child
  // tasks from missing parent's work.
  test('child task created with --parent branches from parent HEAD, not main', async () => {
    const { MOCK_CLAUDE_SUCCESS } = await import('../helpers/fixtures');
    const { join } = await import('path');

    // Create and start parent task, then wait for its turn to reconcile so the
    // parent's commit is present on its branch.
    const parentId = await createTask(ctx, 'Parent task', 'Do parent work');
    const startResult = await ctx.lazyMocked(['start', parentId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    expectSuccess(startResult);
    expect((await ctx.lazy(['wait', parentId])).exitCode).toBe(0);

    // Get parent's worktree and current HEAD
    const parentWorktreePath = join(ctx.root, '.lazy', 'worktrees', parentId);
    const parentHeadResult = ctx.git('-C', parentWorktreePath, 'rev-parse', 'HEAD');
    expect(parentHeadResult.exitCode).toBe(0);
    const parentHead = parentHeadResult.stdout.trim();

    // Get main HEAD for comparison
    const mainHeadResult = ctx.git('rev-parse', 'HEAD');
    expect(mainHeadResult.exitCode).toBe(0);
    const mainHead = mainHeadResult.stdout.trim();

    // Parent should be ahead of main (has at least the init commit)
    expect(parentHead).not.toBe(mainHead);

    // Create child task with --parent
    const childResult = await ctx.lazy(['create', '--goal', 'Child task', '--parent', parentId, '--prompt', 'Do child work']);
    expectSuccess(childResult);
    const childId = extractTaskId(childResult.stdout);

    // Start child task and wait for its turn to reconcile.
    const startChildResult = await ctx.lazyMocked(['start', childId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    expectSuccess(startChildResult);
    expect((await ctx.lazy(['wait', childId])).exitCode).toBe(0);

    // Get child's worktree and verify it branched from parent's HEAD
    const childWorktreePath = join(ctx.root, '.lazy', 'worktrees', childId);
    const mergeBaseResult = ctx.git('-C', childWorktreePath, 'merge-base', `lazy/${parentId}`, `lazy/${childId}`);
    expect(mergeBaseResult.exitCode).toBe(0);
    const mergeBase = mergeBaseResult.stdout.trim();

    // The merge base between child and parent should be the parent's HEAD
    // (i.e., child branched from parent's HEAD, not from an earlier point)
    expect(mergeBase).toBe(parentHead);
  }, 60_000);

  /*
   * The per-task review MODE, pinned at creation (engineer decision
   * 2026-09-21). Pinning it here rather than at start is what lets
   * `lazy create --review separate` stick with no second flag on the command
   * that launches the task, and what keeps a task in one review arm for its
   * whole life when the project default later changes.
   */
  describe('--review', () => {
    test('pins the mode on the task, in the stored spelling', async () => {
      const result = await ctx.lazy([
        'create', '--goal', 'Rotate the signing keys', '--review', 'separate',
      ]);
      expectSuccess(result);
      expectOutput(result, 'Review: separate');
      const taskId = extractTaskId(result.stdout);
      // The hyphenated spelling a human types normalizes to the underscored
      // one metadata and lazy.toml use — one vocabulary, two spellings.
      expect(readTaskJson(ctx.root, taskId).metadata?.[REVIEW_MODE_METADATA_KEY]).toBe('separate');
    });

    test('accepts the hyphenated spelling', async () => {
      const result = await ctx.lazy([
        'create', '--goal', 'Tidy the imports', '--review', 'low-high',
      ]);
      expectSuccess(result);
      const taskId = extractTaskId(result.stdout);
      expect(readTaskJson(ctx.root, taskId).metadata?.[REVIEW_MODE_METADATA_KEY]).toBe('low_high');
    });

    // INVARIANT: an unrecognised mode is refused BEFORE the task row is
    // written. The mode decides whether a reviewer ever runs for this task, so
    // resolving a typo to a default would give someone a review posture they
    // did not choose, silently, for the task's whole life.
    test('refuses an unknown mode, naming the three, and creates nothing', async () => {
      const before = (await ctx.lazy(['list', '--all'])).stdout;
      const result = await ctx.lazy([
        'create', '--goal', 'Nope', '--review', 'thorough',
      ]);
      expectFailure(result);
      expectError(result, "Invalid --review value 'thorough'");
      expectError(result, 'off, low-high, separate');
      expect((await ctx.lazy(['list', '--all'])).stdout).toBe(before);
    });

    test('leaves the mode unpinned when the flag is absent, so the project default applies', async () => {
      const result = await ctx.lazy(['create', '--goal', 'Ordinary work']);
      expectSuccess(result);
      const taskId = extractTaskId(result.stdout);
      expect(readTaskJson(ctx.root, taskId).metadata?.[REVIEW_MODE_METADATA_KEY]).toBeUndefined();
    });

    // Mid-flight safe, like --model and --effort: this is the escape hatch out
    // of a reviewer cycle costing more than it is finding.
    test('lazy edit --review changes it on an existing task', async () => {
      const taskId = await createTask(ctx, 'Change my mind', 'Do the work');
      expectSuccess(await ctx.lazy(['edit', taskId, '--review', 'off']));
      expect(readTaskJson(ctx.root, taskId).metadata?.[REVIEW_MODE_METADATA_KEY]).toBe('off');
    });
  });

  /*
   * INHERITANCE: project config → parent task → task (engineer requirement,
   * 2026-09-21). "A cluster driver therefore sets a mode once on itself and its
   * children follow unless they override."
   *
   * Through the real CLI and the real launch path: `lazy create --review` pins
   * the parent, `lazy start` on the child is what RESOLVES and pins the child,
   * so what these read back is what the daemon actually decided.
   */
  describe('inheritance from a parent task', () => {
    test('a child with no --review keeps its parent\'s mode', async () => {
      const parent = await ctx.lazy([
        'create', '--goal', 'Drive the batch', '--prompt', 'Drive it', '--type', 'cluster',
        '--code', 'inherit-parent', '--review', 'separate', '--review-gate', 'always',
      ]);
      expectSuccess(parent);
      const parentId = extractTaskId(parent.stdout);
      expectSuccess(await ctx.lazyMocked(['start', parentId, '--yes'], MOCK_CLAUDE_SUCCESS));
      expectSuccess(await ctx.lazy(['wait', parentId]));

      const child = await ctx.lazy([
        'create', '--goal', 'Do one piece', '--prompt', 'Do the work',
        '--parent', 'inherit-parent', '--code', 'inherit-child',
      ]);
      expectSuccess(child);
      const childId = extractTaskId(child.stdout);

      // Nothing is pinned until the child LAUNCHES: create records only what it
      // was told, so the rest can still follow a parent that changes its mind.
      expect(readTaskJson(ctx.root, childId).metadata?.[REVIEW_MODE_METADATA_KEY]).toBeUndefined();

      // …and `show` on that unpinned task still says what it WILL run under,
      // naming where it comes from. Reading the project default here would be a
      // false claim on exactly the tasks a human inspects before starting them.
      const beforeStart = await ctx.lazy(['show', childId]);
      expectSuccess(beforeStart);
      expectOutput(beforeStart, 'Review:  separate, gate always, auto-fix off');
      expectOutput(beforeStart, 'inherited from inherit-parent');

      expectSuccess(await ctx.lazyMocked(['start', childId, '--yes'], MOCK_CLAUDE_SUCCESS));
      expectSuccess(await ctx.lazy(['wait', childId]));

      const metadata = readTaskJson(ctx.root, childId).metadata ?? {};
      expect(metadata[REVIEW_MODE_METADATA_KEY]).toBe('separate');
      expect(metadata.review_gate).toBe('always');
      // Stated nowhere up the chain, so the PROJECT's value is what got pinned.
      expect(metadata.review_auto_fix).toBe('off');
      expect(metadata.review_mode_source).toBe('parent:inherit-parent');

      // INVARIANT: the choice keeps travelling. A GRANDCHILD of the hub gets
      // `separate` too — inheritance is the whole chain, and stopping after one
      // generation would silently give a deep tree LESS review than the human
      // asked for. The provenance keeps naming the hub that decided, not the
      // intermediary that passed it on.
      const grandchild = await ctx.lazy([
        'create', '--goal', 'A piece of the piece', '--prompt', 'Do the work',
        '--parent', 'inherit-child', '--code', 'inherit-grandchild',
      ]);
      expectSuccess(grandchild);
      const grandchildId = extractTaskId(grandchild.stdout);
      expectSuccess(await ctx.lazyMocked(['start', grandchildId, '--yes'], MOCK_CLAUDE_SUCCESS));
      expectSuccess(await ctx.lazy(['wait', grandchildId]));

      const grandchildMetadata = readTaskJson(ctx.root, grandchildId).metadata ?? {};
      expect(grandchildMetadata[REVIEW_MODE_METADATA_KEY]).toBe('separate');
      expect(grandchildMetadata.review_mode_source).toBe('parent:inherit-parent');
    });

    test('a child that overrides keeps its own mode, and still inherits the rest', async () => {
      const parent = await ctx.lazy([
        'create', '--goal', 'Drive the batch', '--prompt', 'Drive it', '--type', 'cluster',
        '--code', 'override-parent', '--review', 'separate', '--review-gate', 'always',
      ]);
      expectSuccess(parent);
      const parentId = extractTaskId(parent.stdout);
      expectSuccess(await ctx.lazyMocked(['start', parentId, '--yes'], MOCK_CLAUDE_SUCCESS));
      expectSuccess(await ctx.lazy(['wait', parentId]));

      const child = await ctx.lazy([
        'create', '--goal', 'Do one piece', '--prompt', 'Do the work',
        '--parent', 'override-parent', '--code', 'override-child', '--review', 'low-high',
      ]);
      expectSuccess(child);
      const childId = extractTaskId(child.stdout);

      expectSuccess(await ctx.lazyMocked(['start', childId, '--yes'], MOCK_CLAUDE_SUCCESS));
      expectSuccess(await ctx.lazy(['wait', childId]));

      const metadata = readTaskJson(ctx.root, childId).metadata ?? {};
      // INVARIANT: the levels resolve PER KEY. The child overrode only the mode,
      // so its parent's gate still reaches it — one flag must not silently reset
      // the other two to the project default.
      expect(metadata[REVIEW_MODE_METADATA_KEY]).toBe('low_high');
      expect(metadata.review_gate).toBe('always');
    });

    /*
     * INVARIANT: a parent's LEGACY flag is not a decision about its children.
     * The old resolver pinned `low_high_loop = "off"` on every task alive, so
     * reading it as a choice put every task created under an existing hub into
     * `separate` on a project whose default is `low_high` — reported by the
     * engineer on 2026-09-21, the first task they created after upgrading:
     * "Why would review be separate by default — I think I was pretty explicit
     * in that regard?"
     */
    test("a parent's pre-[review] flag does not put the child in separate", async () => {
      const parent = await ctx.lazy([
        'create', '--goal', 'An older hub', '--prompt', 'Hub', '--code', 'legacy-hub',
      ]);
      expectSuccess(parent);
      const parentId = extractTaskId(parent.stdout);
      expectSuccess(await ctx.lazyMocked(['start', parentId, '--yes'], MOCK_CLAUDE_SUCCESS));
      expectSuccess(await ctx.lazy(['wait', parentId]));

      // Put the hub in the state every task was in before `[review]` existed:
      // the legacy flag, pinned 'off' by the old resolver whether or not anyone
      // had an opinion, and no review_* keys at all.
      const parentJson = readTaskJson(ctx.root, parentId);
      const parentMetadata = { ...(parentJson.metadata ?? {}) } as Record<string, string>;
      for (const key of Object.keys(parentMetadata)) {
        if (key.startsWith('review_')) delete parentMetadata[key];
      }
      parentMetadata.low_high_loop = 'off';
      writeTaskJson(ctx.root, parentId, { ...parentJson, metadata: parentMetadata });

      const child = await ctx.lazy([
        'create', '--goal', 'New work under it', '--prompt', 'Do the work',
        '--parent', 'legacy-hub', '--code', 'legacy-child',
      ]);
      expectSuccess(child);
      const childId = extractTaskId(child.stdout);
      expectSuccess(await ctx.lazyMocked(['start', childId, '--yes'], MOCK_CLAUDE_SUCCESS));
      expectSuccess(await ctx.lazy(['wait', childId]));

      const metadata = readTaskJson(ctx.root, childId).metadata ?? {};
      expect(metadata[REVIEW_MODE_METADATA_KEY]).toBe('low_high');
      // …and the task records WHERE that came from, which is the other half of
      // the report: the line said `separate` and explained nothing.
      expect(metadata.review_mode_source).toBe('project');

      const shown = await ctx.lazy(['show', childId]);
      expectSuccess(shown);
      expectOutput(shown, 'Review:  low-high, gate auto, auto-fix off');
      expectOutput(shown, 'project default');
    });
  });
});
