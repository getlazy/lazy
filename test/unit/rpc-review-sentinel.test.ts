/**
 * Unit tests for the RPC review handlers: task-level anchor (sentinel) guards.
 *
 * The `(task)` sentinel anchors the conversation about the work as a whole.
 * These tests verify that:
 * - `reviewPostComment` rejects a FRESH sentinel comment (that is what the
 *   Unblock message box is) but accepts one REPLYING on a task-level thread
 * - `reviewAsk` rejects `(task)` with a non-zero line (inconsistent sentinel)
 * - `reviewAsk` rejects a line without a file (ambiguous anchor)
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  initDaemonStorage,
  getOrCreateStorage,
  closeAllStorage,
} from '../../src/daemon/rpc-handlers';
import { handleReviewPostComment, handleReviewAsk } from '../../src/daemon/rpc-review';
import { TASK_LEVEL_REVIEW_ANCHOR } from '../../src/review/task-level-anchor';
import { enableInProcessTestMode } from '../helpers/in-process-test-mode';
import { pinConfig } from '../helpers/pin-config';

// This suite imports src/ in-process, so it needs LAZY_TEST=1 for any code that
// checks it and needs LAZY_CONFIG pinned so config discovery does not walk up
// into the repo's own lazy.toml.
enableInProcessTestMode();

describe('RPC review sentinel guards', () => {
  let root: string;
  let taskId: string;
  let unpinConfig: () => void;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-rpc-review-'));
    await writeFile(
      join(root, 'lazy.toml'),
      `[storage]\nbackend = "external"\nexternal_path = "${join(root, 'store')}"\n`,
    );
    unpinConfig = pinConfig(root);
    initDaemonStorage(root);

    const storage = await getOrCreateStorage();
    // Keep task in backlog so asks fail gracefully with "not askable" rather
    // than attempting a real dispatch (which hits permission issues in the
    // test environment). The sentinel validation we're testing happens before
    // the askability gate.
    const task = await storage.createTask('Sentinel guard test');
    taskId = task.id;
  });

  afterEach(async () => {
    await closeAllStorage();
    unpinConfig();
    await rm(root, { recursive: true, force: true });
  });

  // INVARIANT: a FRESH sentinel comment (no thread to reply on) is refused. It
  // would render outside the diff, marking up no code, and it is exactly what
  // the Unblock tab's message box already is. The one exception — a reply on an
  // existing task-level thread — is covered by the test after next.
  test('reviewPostComment rejects the (task) sentinel file', async () => {
    await expect(
      handleReviewPostComment(root, {
        taskId,
        file: TASK_LEVEL_REVIEW_ANCHOR.file,
        line: TASK_LEVEL_REVIEW_ANCHOR.line,
        side: 'new',
        content: 'This should be rejected',
      }),
    ).rejects.toThrow(/comments must anchor to a diff line/i);
  });

  // The reviewer's follow-up to an agent's answer ("alright, do that") is a
  // plain comment on that same conversation — no line anchor to hunt for.
  test('reviewPostComment accepts a sentinel comment replying on a task-level thread', async () => {
    const asked = await handleReviewAsk(root, {
      taskId,
      content: 'Why this approach?',
    });

    const result = await handleReviewPostComment(root, {
      taskId,
      threadId: asked.comment.thread_id,
      file: TASK_LEVEL_REVIEW_ANCHOR.file,
      line: TASK_LEVEL_REVIEW_ANCHOR.line,
      side: TASK_LEVEL_REVIEW_ANCHOR.side,
      content: 'alright, do that',
    });

    expect(result.comment.thread_id).toBe(asked.comment.thread_id);
    expect(result.comment.file).toBe(TASK_LEVEL_REVIEW_ANCHOR.file);
    expect(result.comment.intent).toBe('comment');
    expect(result.comment.delivery_state).toBe('pending_delivery');
  });

  test('reviewPostComment accepts a normal file path', async () => {
    const result = await handleReviewPostComment(root, {
      taskId,
      file: 'src/foo.ts',
      line: 10,
      side: 'new',
      content: 'This is valid',
    });
    expect(result.comment).toBeDefined();
    expect(result.comment.file).toBe('src/foo.ts');
    expect(result.comment.line).toBe(10);
  });

  // INVARIANT: the (task) sentinel MUST have line 0. Accepting (task) with a
  // non-zero line would create an anchor that isTaskLevelReviewAnchor() rejects
  // downstream, making the comment render in neither the Ask tab nor the diff.
  test('reviewAsk rejects (task) file with a non-zero line', async () => {
    await expect(
      handleReviewAsk(root, {
        taskId,
        file: TASK_LEVEL_REVIEW_ANCHOR.file,
        line: 5,
        side: 'new',
        content: 'Inconsistent sentinel',
      }),
    ).rejects.toThrow(/requires line 0/i);
  });

  // These tests verify anchor handling. The task stays in backlog so asks are
  // "failed" (not askable) rather than attempting real dispatch. The anchor
  // validation happens BEFORE the askability gate, so this tests the right thing.

  test('reviewAsk accepts (task) file with line 0', async () => {
    const result = await handleReviewAsk(root, {
      taskId,
      file: TASK_LEVEL_REVIEW_ANCHOR.file,
      line: TASK_LEVEL_REVIEW_ANCHOR.line,
      content: 'This is a valid task-level ask',
    });
    expect(result.comment).toBeDefined();
    expect(result.comment.file).toBe(TASK_LEVEL_REVIEW_ANCHOR.file);
    expect(result.comment.line).toBe(TASK_LEVEL_REVIEW_ANCHOR.line);
    // Ask failed because task is not askable (backlog), not because of anchor.
    expect(result.comment.ask_state).toBe('failed');
  });

  test('reviewAsk accepts omitted file as task-level', async () => {
    const result = await handleReviewAsk(root, {
      taskId,
      content: 'No file means task-level',
    });
    expect(result.comment).toBeDefined();
    expect(result.comment.file).toBe(TASK_LEVEL_REVIEW_ANCHOR.file);
    expect(result.comment.line).toBe(TASK_LEVEL_REVIEW_ANCHOR.line);
    expect(result.comment.ask_state).toBe('failed');
  });

  test('reviewAsk accepts empty string file as task-level', async () => {
    const result = await handleReviewAsk(root, {
      taskId,
      file: '',
      content: 'Empty file means task-level',
    });
    expect(result.comment).toBeDefined();
    expect(result.comment.file).toBe(TASK_LEVEL_REVIEW_ANCHOR.file);
    expect(result.comment.line).toBe(TASK_LEVEL_REVIEW_ANCHOR.line);
    expect(result.comment.ask_state).toBe('failed');
  });

  // INVARIANT: a line without a file is ambiguous. The comment in the handler
  // says so and the code must match: reject rather than silently treat as
  // task-level.
  test('reviewAsk rejects a line without a file', async () => {
    await expect(
      handleReviewAsk(root, {
        taskId,
        line: 10,
        content: 'Line without file is ambiguous',
      }),
    ).rejects.toThrow(/line number without a file/i);
  });

  test('reviewAsk with a real file requires line and side', async () => {
    await expect(
      handleReviewAsk(root, {
        taskId,
        file: 'src/foo.ts',
        content: 'Missing line and side',
      }),
    ).rejects.toThrow(/line/i);
  });

  test('reviewAsk with a real file and line creates a line-anchored comment', async () => {
    const result = await handleReviewAsk(root, {
      taskId,
      file: 'src/foo.ts',
      line: 42,
      side: 'new',
      content: 'Line-anchored question',
    });
    expect(result.comment).toBeDefined();
    expect(result.comment.file).toBe('src/foo.ts');
    expect(result.comment.line).toBe(42);
    expect(result.comment.side).toBe('new');
    expect(result.comment.ask_state).toBe('failed');
  });
});
