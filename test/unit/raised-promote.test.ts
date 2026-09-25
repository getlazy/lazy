/**
 * Unit tests for raised-item promotion: goal/prompt helpers, parent defaulting,
 * and storage promoteRaisedItem.
 *
 * INVARIANT: promotion works on ONE entity regardless of the blocking flag — a
 * gating question and an orthogonal note promote through the same code path and
 * differ only in the flag they carry. See docs/design/raised-items-unified.md.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createStorage, type Storage } from '../../src/storage';
import { spawnSyncUnsupervised } from '../../src/utils/spawn';
import {
  allocatePromotedCode,
  buildPromotedTaskPrompt,
  defaultPromotedCode,
  defaultPromotedGoal,
  defaultPromoteParentTaskId,
  MAX_PROMOTED_CODE_ATTEMPTS,
  MAX_PROMOTED_GOAL_LENGTH,
} from '../../src/raised/promote-task';
import { MAX_TASK_CODE_LENGTH } from '../../src/task/identity';
import { parentTaskIdOf, taskTarget } from '../../src/task-target';
import type { RaisedItem, RaisedItemInput, Task } from '../../src/types';

function stubTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    code: overrides.code ?? 'child-task',
    goal: overrides.goal ?? 'Child goal',
    prompt: overrides.prompt ?? '',
    type: 'task',
    status: overrides.status ?? 'working',
    created_at: 1,
    completed_at: null,
    target: overrides.target ?? taskTarget('parent-hub'),
    branched_from_sha: null,
    close_reason: null,
    model: null,
    agent_id: 'claude-code',
    runner_type: null,
    metadata: null,
    tags: [],
    ...overrides,
  } as Task;
}

/**
 * The malformed promote that started this fix: web UI sliced at 120 chars
 * mid-word ("CLI `--m") and assigned no code. First sentence ends at `.md).`.
 */
const SHIPPED_DEFAULT_ITEM =
  'Shipped default is still `claude-opus-4-8` (`DEFAULT_CONFIG` in src/config/loader.ts, ' +
  'the `lazy init` template, CLI `--model` examples, public-docs/lazy-toml.md). ' +
  'Task update-default-model (8b2419e8) was accepted to bump this to `claude-opus-5` ' +
  'but it is not on this branch. Out of scope here — do not mix with the Fable 5.1 pin.';

const SHIPPED_DEFAULT_FIRST_SENTENCE =
  'Shipped default is still `claude-opus-4-8` (`DEFAULT_CONFIG` in src/config/loader.ts, ' +
  'the `lazy init` template, CLI `--model` examples, public-docs/lazy-toml.md).';

describe('raised-item promote helpers', () => {
  test('defaultPromotedGoal uses first sentence trimmed', () => {
    expect(defaultPromotedGoal('Extract retry helper.\nMore detail here.'))
      .toBe('Extract retry helper.');
  });

  // INVARIANT: Promote goal is the first sentence, not a length-truncated prefix.
  // Periods inside backticks, file extensions, and parentheses are not sentence ends.
  test('defaultPromotedGoal keeps the first sentence through backticks, parens, and file extensions', () => {
    const goal = defaultPromotedGoal(SHIPPED_DEFAULT_ITEM);
    expect(goal).toBe(SHIPPED_DEFAULT_FIRST_SENTENCE);
    expect(goal.endsWith('CLI `--m')).toBe(false);
    expect(goal.length).not.toBe(120);
    expect(goal.endsWith('lazy-toml.md).')).toBe(true);
  });

  test('defaultPromotedGoal does not split on a period inside backticks', () => {
    expect(defaultPromotedGoal('Fix the `foo. bar` helper. Then more detail.'))
      .toBe('Fix the `foo. bar` helper.');
  });

  test('defaultPromotedGoal truncates an absurdly long first sentence at a word boundary', () => {
    const word = 'word';
    const longSentence = `${Array.from({ length: 80 }, () => word).join(' ')}.`;
    expect(longSentence.length).toBeGreaterThan(MAX_PROMOTED_GOAL_LENGTH);
    const goal = defaultPromotedGoal(longSentence);
    expect(goal.endsWith('…')).toBe(true);
    expect(goal.length).toBeLessThanOrEqual(MAX_PROMOTED_GOAL_LENGTH);
    // Word-boundary: last kept token is a whole "word", not "wo…".
    expect(goal).toMatch(/word…$/);
    expect(goal).not.toMatch(/wo…$/);
  });

  test('defaultPromotedCode derives kebab-case from the goal', () => {
    expect(defaultPromotedCode('Extract shared retry helper')).toBe('extract-shared-retry-helper');
    expect(defaultPromotedCode(SHIPPED_DEFAULT_FIRST_SENTENCE)).toMatch(
      /^shipped-default-is-still-claude-opus-4-8/,
    );
    expect(defaultPromotedCode('Lazy should document the flag')).toBe('should-document-the-flag');
    expect(defaultPromotedCode('a')).toBeUndefined();
  });

  // INVARIANT: A derived promote code that a live task already holds is
  // suffixed, not failed. lazy raised groups near-duplicates into recurrences, so two
  // promotes sharing a first sentence is the common case.
  test('allocatePromotedCode suffixes -2, -3 when the base is taken', () => {
    expect(allocatePromotedCode('extract-retry', new Set())).toBe('extract-retry');
    expect(allocatePromotedCode('extract-retry', new Set(['extract-retry'])))
      .toBe('extract-retry-2');
    expect(allocatePromotedCode(
      'extract-retry',
      new Set(['extract-retry', 'extract-retry-2']),
    )).toBe('extract-retry-3');
  });

  // Expressed against MAX_TASK_CODE_LENGTH, not a literal: the limit dropped
  // from 80 to 63 when task codes became subdomain labels, and a hard-coded
  // length made this assertion stale rather than wrong-in-product.
  test('allocatePromotedCode trims a max-length base so the suffix still fits', () => {
    const base = `${'a'.repeat(MAX_TASK_CODE_LENGTH - 2)}12`;
    expect(base.length).toBe(MAX_TASK_CODE_LENGTH);
    const allocated = allocatePromotedCode(base, new Set([base]));
    expect(allocated).toBe(`${'a'.repeat(MAX_TASK_CODE_LENGTH - 2)}-2`);
    expect(allocated.length).toBeLessThanOrEqual(MAX_TASK_CODE_LENGTH);
  });

  test('allocatePromotedCode throws after MAX_PROMOTED_CODE_ATTEMPTS collisions', () => {
    const taken = new Set(['extract-retry']);
    for (let n = 2; n <= MAX_PROMOTED_CODE_ATTEMPTS; n++) {
      taken.add(`extract-retry-${n}`);
    }
    expect(() => allocatePromotedCode('extract-retry', taken)).toThrow(/already taken/);
  });

  // INVARIANT: provenance names the raised item and reads the same for either
  // flag — a promoted gating question and a promoted note are indistinguishable
  // downstream, which is what makes one promote path correct for both.
  test('buildPromotedTaskPrompt embeds the item body and provenance, whatever the flag', () => {
    const task = stubTask('task-id', { code: 'fix-retry', goal: 'Fix retry bugs' });
    for (const blocking of [false, true]) {
      const item: RaisedItem = {
        id: 'ri-uuid',
        task_id: 'task-id',
        content: 'Fix the flaky retry path',
        blocking,
        status: 'open',
        created_at: 1,
      };
      const prompt = buildPromotedTaskPrompt(item, task);
      expect(prompt).toContain('Fix the flaky retry path');
      expect(prompt).toContain('Promoted from raised item ri-uuid on task fix-retry: Fix retry bugs');
    }
  });

  test('defaultPromoteParentTaskId mirrors redo parent (originating task parent)', () => {
    const child = stubTask('child', { target: taskTarget('hub-id') });
    expect(defaultPromoteParentTaskId(child)).toBe('hub-id');
    expect(parentTaskIdOf(child)).toBe('hub-id');

    const topLevel = stubTask('top', {
      target: { kind: 'branch', branch: 'main' },
      code: 'top-task',
    });
    expect(defaultPromoteParentTaskId(topLevel)).toBeUndefined();
  });
});

describe('storage promoteRaisedItem', () => {
  let testDir: string;
  let storage: Storage;
  let parentTask: Task;
  let childTask: Task;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'lazy-promote-test-'));
    mkdirSync(join(testDir, '.lazy'), { recursive: true });
    spawnSyncUnsupervised(['git', 'init'], { cwd: testDir });
    spawnSyncUnsupervised(['git', 'config', 'user.name', 'Test'], { cwd: testDir });
    spawnSyncUnsupervised(['git', 'config', 'user.email', 't@example.com'], { cwd: testDir });
    writeFileSync(join(testDir, 'README.md'), '# Test\n');
    spawnSyncUnsupervised(['git', 'add', '.'], { cwd: testDir });
    spawnSyncUnsupervised(['git', 'commit', '-m', 'Initial'], { cwd: testDir });

    storage = await createStorage(testDir, { backend: 'external' });
    parentTask = await storage.createTask('Release hub', undefined, undefined, 'release-hub');
    childTask = await storage.createTask('Child work', parentTask.id, undefined, 'child-work');
  });

  afterEach(async () => {
    if (storage) await storage.close();
    if (testDir) rmSync(testDir, { recursive: true, force: true });
  });

  /** File a non-blocking raised item (the former follow-up) on the child task. */
  function raise(
    input: Omit<RaisedItemInput, 'blocking'> | string,
    blocking = false,
  ): Promise<RaisedItem> {
    return storage.createRaisedItem(
      childTask.id,
      typeof input === 'string' ? { content: input, blocking } : { ...input, blocking },
    );
  }

  test('creates backlog task under originating parent and marks the item promoted', async () => {
    const item = await raise('Extract shared retry helper for all callers');

    const result = await storage.promoteRaisedItem(childTask.id, item.id, {
      code: 'fix-retry-helper',
      actor: 'human',
    });

    expect(result.task.status).toBe('backlog');
    expect(result.task.code).toBe('fix-retry-helper');
    expect(result.task.goal).toBe('Extract shared retry helper for all callers');
    expect(parentTaskIdOf(result.task)).toBe(parentTask.id);
    expect(result.task.prompt).toContain('Extract shared retry helper');
    expect(result.task.prompt).toContain('Promoted from raised item');
    expect(result.task.prompt).toContain('child-work');

    expect(result.raised_item.status).toBe('promoted_peer');
    expect(result.raised_item.promoted_task_id).toBe(result.task.id);

    const items = await storage.getTaskRaisedItems(childTask.id);
    expect(items[0].status).toBe('promoted_peer');
  });

  // INVARIANT: one promote path serves both flags. A blocking question the
  // human decides to spin out promotes exactly like an orthogonal note; the
  // relation, not the flag, decides peer vs subtask.
  test('promotes a blocking item too, as a subtask when asked', async () => {
    const item = await raise('Should the new flag default on?', true);

    const result = await storage.promoteRaisedItem(childTask.id, item.id, {
      relation: 'subtask',
      code: 'decide-flag-default',
      actor: 'human',
    });

    expect(result.task.status).toBe('backlog');
    expect(parentTaskIdOf(result.task)).toBe(childTask.id);
    expect(result.raised_item.status).toBe('promoted_subtask');
    expect(result.raised_item.blocking).toBe(true);
    expect(result.task.prompt).toContain('Promoted from raised item');
  });

  test('refuses re-promote', async () => {
    const item = await raise('Second attempt note');
    await storage.promoteRaisedItem(childTask.id, item.id, { actor: 'human' });

    await expect(
      storage.promoteRaisedItem(childTask.id, item.id, { actor: 'human' }),
    ).rejects.toThrow(/already promoted/i);
  });

  test('omitted goal and code use first sentence and a derived kebab-case code', async () => {
    const item = await raise(SHIPPED_DEFAULT_ITEM);

    const result = await storage.promoteRaisedItem(childTask.id, item.id, {
      actor: 'human',
    });

    expect(result.task.goal).toBe(SHIPPED_DEFAULT_FIRST_SENTENCE);
    expect(result.task.goal.endsWith('CLI `--m')).toBe(false);
    expect(result.task.code).toBeTruthy();
    expect(result.task.code).toMatch(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/);
    expect(result.task.code).toMatch(/^shipped-default-is-still/);
  });

  // INVARIANT: Two omitted-code promotes with the same first sentence both
  // succeed. Before suffixing, the second hit createTask's duplicate-code
  // throw — a regression from always succeeding with a bare hex id.
  test('two promotes with the same first sentence get distinct derived codes', async () => {
    const first = await raise('Extract shared retry helper for all callers. Extra detail on the first.');
    const second = await raise('Extract shared retry helper for all callers. Extra detail on the second.');

    const a = await storage.promoteRaisedItem(childTask.id, first.id, { actor: 'human' });
    const b = await storage.promoteRaisedItem(childTask.id, second.id, { actor: 'human' });

    expect(a.task.code).toBe('extract-shared-retry-helper-for-all-callers');
    expect(b.task.code).toBe('extract-shared-retry-helper-for-all-callers-2');
    expect(a.task.goal).toBe(b.task.goal);
  });

  test('explicit --code still fails when a live task already holds it', async () => {
    const item = await raise('Another retry note');

    await expect(
      storage.promoteRaisedItem(childTask.id, item.id, {
        code: 'child-work',
        actor: 'human',
      }),
    ).rejects.toThrow(/already exists/i);
  });

  test('honors explicit --parent override', async () => {
    const otherParent = await storage.createTask('Other hub', undefined, undefined, 'other-hub');
    const item = await raise('Move under other hub');

    const result = await storage.promoteRaisedItem(childTask.id, item.id, {
      parent: otherParent.code!,
      actor: 'human',
    });

    expect(parentTaskIdOf(result.task)).toBe(otherParent.id);
  });

  test('promote uses structured proposal for goal, code, and prompt', async () => {
    const item = await raise({
      title: 'Extract shared retry helper',
      explanation: 'Three call sites duplicate the same backoff logic.',
      proposed_code: 'extract-retry-helper',
      proposed_prompt: 'Extract retry into src/utils/retry.ts and migrate callers.',
    });

    const result = await storage.promoteRaisedItem(childTask.id, item.id, {
      actor: 'human',
    });

    expect(result.task.goal).toBe('Extract shared retry helper');
    expect(result.task.code).toBe('extract-retry-helper');
    expect(result.task.prompt).toContain('Extract retry into src/utils/retry.ts');
    expect(result.task.prompt).toContain('Promoted from raised item');
    expect(result.raised_item.promoted_task_id).toBe(result.task.id);
    expect(result.raised_item.promoted_task_code).toBe('extract-retry-helper');
  });

  // INVARIANT: Promoted tasks inherit the originating task's launch identity
  // (agent, model, effort) — silent fallback to project defaults is a surprise.
  test('promote inherits agent, model, and effort from originating task', async () => {
    await storage.updateTaskAgent(childTask.id, 'cursor');
    await storage.updateTaskModel(childTask.id, 'opus');
    await storage.updateTaskMetadata(childTask.id, 'effort', 'high');

    const item = await raise({
      title: 'Raised item with identity',
      proposed_prompt: 'Do the orthogonal thing.',
    });

    const result = await storage.promoteRaisedItem(childTask.id, item.id, {
      actor: 'human',
    });

    expect(result.task.agent_id).toBe('cursor');
    expect(result.task.model).toBe('opus');
    expect((await storage.getTaskMetadata(result.task.id, 'effort'))).toBe('high');
  });
});
