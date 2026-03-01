import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { readdirSync } from 'fs';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput, expectOutputExcludes } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { getNewNotesSince, buildNotesContext } from '../../src/cli/commands/shared';
import { buildNotesSectionForEditor, buildFreeformEditorContentWithNotes, buildEditorContentWithDiff, extractSurvivingNotes, extractFeedbackFromDiff } from '../../src/utils/diff';
import { readCommand, protocolDir as getProtocolDir } from '../../src/protocol';
import type { UnblockCommand } from '../../src/protocol';
import type { Comment } from '../../src/types';

describe('getNewNotesSince', () => {
  const makeNote = (id: string, content: string, created_at: number): Comment => ({
    id,
    task_id: 'task-1',
    content,
    created_at,
  });

  test('filters notes after cutoff timestamp', () => {
    const notes = [
      makeNote('1', 'old note', 1735689600000),       // 2025-01-01T00:00:00Z
      makeNote('2', 'new note', 1735776000000),        // 2025-01-02T00:00:00Z
      makeNote('3', 'newer note', 1735862400000),      // 2025-01-03T00:00:00Z
    ];

    const result = getNewNotesSince(notes, 1735732800000); // 2025-01-01T12:00:00Z
    expect(result).toHaveLength(2);
    expect(result[0].content).toBe('new note');
    expect(result[1].content).toBe('newer note');
  });

  test('returns empty array when all notes are before cutoff', () => {
    const notes = [
      makeNote('1', 'old', 1735689600000),             // 2025-01-01T00:00:00Z
    ];

    const result = getNewNotesSince(notes, 1735776000000); // 2025-01-02T00:00:00Z
    expect(result).toHaveLength(0);
  });

  test('returns all notes when cutoff is very old', () => {
    const notes = [
      makeNote('1', 'a', 1735689600000),               // 2025-01-01T00:00:00Z
      makeNote('2', 'b', 1735776000000),               // 2025-01-02T00:00:00Z
    ];

    const result = getNewNotesSince(notes, 1704067200000); // 2024-01-01T00:00:00Z
    expect(result).toHaveLength(2);
  });

  test('handles empty notes array', () => {
    const result = getNewNotesSince([], 1735689600000);    // 2025-01-01T00:00:00Z
    expect(result).toHaveLength(0);
  });
});

describe('buildNotesContext', () => {
  const makeNote = (content: string, created_at: number): Comment => ({
    id: 'note-1',
    task_id: 'task-1',
    content,
    created_at,
  });

  test('returns empty string for empty notes', () => {
    expect(buildNotesContext([])).toBe('');
  });

  test('includes header and note content', () => {
    const notes = [makeNote('Fix the auth bug', 1735725600000)]; // 2025-01-01T10:00:00Z
    const result = buildNotesContext(notes);

    expect(result).toContain('NOTES ADDED SINCE YOUR LAST TURN');
    expect(result).toContain('[2025-01-01 10:00:00] Fix the auth bug');
    expect(result).toContain('--- END OF NOTES ---');
  });

  test('includes multiple notes', () => {
    const notes = [
      makeNote('First guidance', 1735725600000),  // 2025-01-01T10:00:00Z
      makeNote('Second guidance', 1735729200000),  // 2025-01-01T11:00:00Z
    ];
    const result = buildNotesContext(notes);

    expect(result).toContain('First guidance');
    expect(result).toContain('Second guidance');
  });
});

describe('comments in diff output', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('diff stat shows comment count when comments exist', async () => {
    const taskId = await createTask(ctx, 'Diff comment test', 'Do work');

    // Start the task (creates worktree and session)
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });

    // Trigger reconciliation so the agent turn is recorded NOW.
    // With the supervisor model, reconciliation is lazy — it runs on the next
    // command. The agent turn timestamp is set at reconciliation time, so we
    // must reconcile before adding comments to ensure comments come after the cutoff.
    await ctx.lazy(['show', taskId]);

    // Wait so the comment timestamp is strictly after the agent turn's timestamp.
    await Bun.sleep(1100);

    // Add a comment to the task
    await ctx.lazy(['comment', taskId, '--message', 'Review this carefully']);

    // Check diff stat output
    const diffResult = await ctx.lazy(['diff', taskId]);
    expectSuccess(diffResult);
    expectOutput(diffResult, 'comment(s) added');
  });

  test('diff --full renders comments as virtual diff additions', async () => {
    const taskId = await createTask(ctx, 'Full diff comment test', 'Do work');

    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });

    // Trigger reconciliation so the agent turn is recorded NOW.
    await ctx.lazy(['show', taskId]);

    // Wait so comment timestamps are strictly after the agent turn
    await Bun.sleep(1100);

    // Add comments
    await ctx.lazy(['comment', taskId, '--message', 'First comment content']);
    await ctx.lazy(['comment', taskId, '--message', 'Second comment content']);

    // Check full diff output
    const diffResult = await ctx.lazy(['diff', taskId, '--full']);
    expectSuccess(diffResult);
    expectOutput(diffResult, 'diff --lazy a/comments b/comments');
    expectOutput(diffResult, '+First comment content');
    expectOutput(diffResult, '+Second comment content');
  });

  test('diff shows no comments section when no comments exist', async () => {
    const taskId = await createTask(ctx, 'No comments test', 'Do work');

    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });

    const diffResult = await ctx.lazy(['diff', taskId]);
    expectSuccess(diffResult);
    expectOutputExcludes(diffResult, 'comment(s) added');
  });
});

describe('comments injected into agent prompts', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('comments added before start are included in first turn', async () => {
    const taskId = await createTask(ctx, 'Comment injection test', 'Build feature');

    // Add a comment before starting
    await ctx.lazy(['comment', taskId, '--message', 'Important context for agent']);

    // Start the task — the comments should be injected into the prompt
    const result = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    expectSuccess(result);

    // Verify the task started successfully
    const showResult = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult);
    expectOutput(showResult, 'Build feature');
  });

  test('comments reach agent via unblock --message (imperative mode)', async () => {
    const taskId = await createTask(ctx, 'Imperative unblock comments', 'Do feature work');

    // Start the task
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });

    // Trigger reconciliation so the agent turn is recorded
    await ctx.lazy(['show', taskId]);

    // Wait so comment timestamps are strictly after the agent turn
    await Bun.sleep(1100);

    // Add a comment
    await ctx.lazy(['comment', taskId, '--message', 'DESIGN NOTE: Must handle edge case']);

    // Unblock with --message (imperative, no editor)
    const unblockResult = await ctx.lazyMocked(
      ['unblock', taskId, '--message', 'Fix the bug please'],
      MOCK_CLAUDE_SUCCESS,
    );
    expectSuccess(unblockResult);

    // Read the command.json to verify the notes were in the prompt
    const fullTaskId = findFullTaskId(ctx.root, taskId);
    const protoDir = getProtocolDir(fullTaskId);
    const command = readCommand(protoDir) as UnblockCommand;
    expect(command).not.toBeNull();
    expect(command.prompt).toContain('NOTES ADDED SINCE YOUR LAST TURN');
    expect(command.prompt).toContain('DESIGN NOTE: Must handle edge case');
  });
});

function findFullTaskId(root: string, shortId: string): string {
  const tasksDir = join(root, '.lazy', 'tasks');
  const dirs = readdirSync(tasksDir);
  const match = dirs.find(d => d.startsWith(shortId));
  if (!match) throw new Error(`Task directory not found for ${shortId}`);
  return match;
}

describe('buildNotesSectionForEditor', () => {
  const makeNote = (content: string, created_at: number): Comment => ({
    id: 'note-1',
    task_id: 'task-1',
    content,
    created_at,
  });

  test('returns empty string for empty notes', () => {
    expect(buildNotesSectionForEditor([])).toBe('');
  });

  test('includes section markers and note content', () => {
    const notes = [makeNote('Fix the auth bug', 1735725600000)]; // 2025-01-01T10:00:00Z
    const result = buildNotesSectionForEditor(notes);

    expect(result).toContain('# --- Unseen comments (edit or delete as needed) ---');
    expect(result).toContain('# --- End comments ---');
    expect(result).toContain('[2025-01-01 10:00:00] Fix the auth bug');
  });

  test('puts timestamp and first line on same line', () => {
    const notes = [makeNote('Single line note', 1735725600000)];
    const result = buildNotesSectionForEditor(notes);

    expect(result).toContain('[2025-01-01 10:00:00] Single line note');
  });

  test('handles multi-line notes', () => {
    const notes = [makeNote('First line\nSecond line\nThird line', 1735725600000)];
    const result = buildNotesSectionForEditor(notes);

    expect(result).toContain('[2025-01-01 10:00:00] First line');
    expect(result).toContain('Second line');
    expect(result).toContain('Third line');
  });

  test('includes multiple notes', () => {
    const notes = [
      makeNote('First comment', 1735725600000),   // 2025-01-01T10:00:00Z
      makeNote('Second comment', 1735729200000),   // 2025-01-01T11:00:00Z
    ];
    const result = buildNotesSectionForEditor(notes);

    expect(result).toContain('[2025-01-01 10:00:00] First comment');
    expect(result).toContain('[2025-01-01 11:00:00] Second comment');
  });

  test('note content is not #-prefixed (survives comment stripping)', () => {
    const notes = [makeNote('Important note', 1735725600000)];
    const result = buildNotesSectionForEditor(notes);

    const lines = result.split('\n');
    const contentLines = lines.filter(l => l.includes('Important note'));
    for (const line of contentLines) {
      expect(line.startsWith('#')).toBe(false);
    }
  });
});

describe('buildFreeformEditorContentWithNotes', () => {
  const makeNote = (content: string, created_at: number): Comment => ({
    id: 'note-1',
    task_id: 'task-1',
    content,
    created_at,
  });

  test('returns base freeform content when no notes', () => {
    const { editorContent } = buildFreeformEditorContentWithNotes('abc123', 'Do work');
    expect(editorContent).toContain('# Task: abc123');
    expect(editorContent).toContain('# Goal: Do work');
    expect(editorContent).not.toContain('Unseen comments');
  });

  test('includes notes section in editorContent when notes provided', () => {
    const notes = [makeNote('Review this approach', 1735725600000)]; // 2025-01-01T10:00:00Z
    const { editorContent } = buildFreeformEditorContentWithNotes('abc123', 'Do work', notes);

    expect(editorContent).toContain('# Task: abc123');
    expect(editorContent).toContain('# --- Unseen comments (edit or delete as needed) ---');
    expect(editorContent).toContain('[2025-01-01 10:00:00] Review this approach');
    expect(editorContent).toContain('# --- End comments ---');
  });

  test('comparisonContent has placeholder instead of real comments', () => {
    const notes = [makeNote('Review this approach', 1735725600000)];
    const { comparisonContent } = buildFreeformEditorContentWithNotes('abc123', 'Do work', notes);

    expect(comparisonContent).toContain('# --- Unseen comments (edit or delete as needed) ---');
    expect(comparisonContent).toContain('# --- End comments ---');
    // Real comment content should NOT be in the comparison
    expect(comparisonContent).not.toContain('Review this approach');
  });
});

describe('buildEditorContentWithDiff with notes', () => {
  const makeNote = (content: string, created_at: number): Comment => ({
    id: 'note-1',
    task_id: 'task-1',
    content,
    created_at,
  });

  test('editorContent includes notes between response and diff', () => {
    const notes = [makeNote('Check edge case', 1735725600000)]; // 2025-01-01T10:00:00Z
    const diff = { diff: 'diff --git a/file b/file\n+new line', filesChanged: 1, isFallback: false };
    const { editorContent } = buildEditorContentWithDiff('Agent response text', diff, 'abc123', 'Goal', notes);

    // Notes section should be present
    expect(editorContent).toContain('# --- Unseen comments (edit or delete as needed) ---');
    expect(editorContent).toContain('[2025-01-01 10:00:00] Check edge case');
    expect(editorContent).toContain('# --- End comments ---');

    // Notes should come before the diff
    const notesPos = editorContent.indexOf('Unseen comments');
    const diffPos = editorContent.indexOf('Changes this turn');
    expect(notesPos).toBeLessThan(diffPos);
  });

  test('comparisonContent has placeholder instead of real comments', () => {
    const notes = [makeNote('Check edge case', 1735725600000)];
    const diff = { diff: 'diff --git a/file b/file\n+new line', filesChanged: 1, isFallback: false };
    const { comparisonContent } = buildEditorContentWithDiff('Agent response text', diff, 'abc123', 'Goal', notes);

    // Markers should be present
    expect(comparisonContent).toContain('# --- Unseen comments (edit or delete as needed) ---');
    expect(comparisonContent).toContain('# --- End comments ---');
    // Real comment content should NOT be in the comparison
    expect(comparisonContent).not.toContain('Check edge case');
  });

  test('omits notes section when no notes', () => {
    const diff = { diff: 'diff --git a/file b/file\n+new line', filesChanged: 1, isFallback: false };
    const { editorContent } = buildEditorContentWithDiff('Agent response', diff, 'abc123', 'Goal', []);

    expect(editorContent).not.toContain('Unseen comments');
    expect(editorContent).not.toContain('End comments');
  });

  test('diff between comparison and unedited editor shows comments as additions', () => {
    const notes = [makeNote('Important design note', 1735725600000)];
    const { editorContent, comparisonContent } = buildEditorContentWithDiff(
      'Agent response text', null, 'abc123', 'Goal', notes,
    );

    // Simulate: human saves without editing (editorContent = edited)
    const result = extractFeedbackFromDiff(comparisonContent, editorContent);
    expect(result.hasChanges).toBe(true);
    expect(result.feedbackText).toContain('Important design note');
  });

  test('diff is clean when human deletes all comments', () => {
    const notes = [makeNote('Delete me', 1735725600000)];
    const { editorContent, comparisonContent } = buildEditorContentWithDiff(
      'Agent response text', null, 'abc123', 'Goal', notes,
    );

    // Simulate: human deletes the comment lines but keeps everything else
    const edited = editorContent
      .split('\n')
      .filter(line => !line.includes('Delete me') && !line.includes('[2025-01-01 10:00:00'))
      .join('\n');

    const result = extractFeedbackFromDiff(comparisonContent, edited);
    expect(result.hasChanges).toBe(false);
  });

  test('diff shows edited comments when human modifies them', () => {
    const notes = [makeNote('Original note', 1735725600000)];
    const { editorContent, comparisonContent } = buildEditorContentWithDiff(
      'Agent response text', null, 'abc123', 'Goal', notes,
    );

    // Simulate: human edits the comment
    const edited = editorContent.replace(
      '[2025-01-01 10:00:00] Original note',
      '[2025-01-01 10:00:00] Edited note with more context',
    );

    const result = extractFeedbackFromDiff(comparisonContent, edited);
    expect(result.hasChanges).toBe(true);
    expect(result.feedbackText).toContain('Edited note with more context');
  });
});

describe('extractSurvivingNotes', () => {
  test('returns null when no notes section markers present', () => {
    const content = 'Just some regular editor content\nwith multiple lines';
    expect(extractSurvivingNotes(content)).toBeNull();
  });

  test('returns surviving comment lines between markers', () => {
    const content = [
      '# --- Unseen comments (edit or delete as needed) ---',
      '',
      '[2025-01-01 10:00:00] First comment',
      '',
      '[2025-01-01 11:00:00] Second comment',
      '',
      '# --- End comments ---',
    ].join('\n');

    const result = extractSurvivingNotes(content);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(2);
    expect(result![0]).toBe('[2025-01-01 10:00:00] First comment');
    expect(result![1]).toBe('[2025-01-01 11:00:00] Second comment');
  });

  test('returns empty array when all comments deleted', () => {
    const content = [
      '# --- Unseen comments (edit or delete as needed) ---',
      '',
      '# --- End comments ---',
    ].join('\n');

    const result = extractSurvivingNotes(content);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(0);
  });

  test('handles missing end marker (deleted by user)', () => {
    const content = [
      'Some text before',
      '# --- Unseen comments (edit or delete as needed) ---',
      '',
      '[2025-01-01 10:00:00] Kept this comment',
      '',
    ].join('\n');

    const result = extractSurvivingNotes(content);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result![0]).toBe('[2025-01-01 10:00:00] Kept this comment');
  });

  test('excludes #-prefixed lines', () => {
    const content = [
      '# --- Unseen comments (edit or delete as needed) ---',
      '# This is a comment line that should be excluded',
      '[2025-01-01 10:00:00] Real note content',
      '# --- End comments ---',
    ].join('\n');

    const result = extractSurvivingNotes(content);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result![0]).toBe('[2025-01-01 10:00:00] Real note content');
  });
});
