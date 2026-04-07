import { describe, test, expect } from 'bun:test';
import { buildEditorContent, buildFreeformEditorContent, buildEditorContentWithDiff, buildFreeformEditorContentWithNotes } from '../../src/utils/diff';

describe('Editor content with remote URL', () => {
  test('buildEditorContent includes remote URL in header', () => {
    const content = buildEditorContent('Agent response here', 'task123', 'My goal', 'https://github.com/org/repo/pull/42');
    expect(content).toContain('# Task: task123');
    expect(content).toContain('# Goal: My goal');
    expect(content).toContain('# Remote: https://github.com/org/repo/pull/42');
    expect(content).toContain('Agent response here');
  });

  test('buildEditorContent omits remote URL when not provided', () => {
    const content = buildEditorContent('Agent response here', 'task123', 'My goal');
    expect(content).toContain('# Task: task123');
    expect(content).toContain('# Goal: My goal');
    expect(content).not.toContain('# Remote:');
    expect(content).toContain('Agent response here');
  });

  test('buildFreeformEditorContent includes remote URL', () => {
    const content = buildFreeformEditorContent('task456', 'Another goal', 'https://github.com/org/repo/pull/43');
    expect(content).toContain('# Task: task456');
    expect(content).toContain('# Goal: Another goal');
    expect(content).toContain('# Remote: https://github.com/org/repo/pull/43');
    expect(content).toContain('No previous agent response available');
  });

  test('buildFreeformEditorContent omits remote URL when not provided', () => {
    const content = buildFreeformEditorContent('task456', 'Another goal');
    expect(content).toContain('# Task: task456');
    expect(content).toContain('# Goal: Another goal');
    expect(content).not.toContain('# Remote:');
  });

  test('buildEditorContentWithDiff includes remote URL', async () => {
    const result = await buildEditorContentWithDiff(
      'Agent response',
      null,
      'task789',
      'Test goal',
      [],
      'https://github.com/org/repo/pull/100'
    );
    expect(result.editorContent).toContain('# Task: task789');
    expect(result.editorContent).toContain('# Goal: Test goal');
    expect(result.editorContent).toContain('# Remote: https://github.com/org/repo/pull/100');
    expect(result.comparisonContent).toContain('# Task: task789');
    expect(result.comparisonContent).toContain('# Goal: Test goal');
    expect(result.comparisonContent).toContain('# Remote: https://github.com/org/repo/pull/100');
  });

  test('buildFreeformEditorContentWithNotes includes remote URL', () => {
    const result = buildFreeformEditorContentWithNotes('task999', 'Goal with notes', [], 'https://github.com/org/repo/pull/200');
    expect(result.editorContent).toContain('# Task: task999');
    expect(result.editorContent).toContain('# Goal: Goal with notes');
    expect(result.editorContent).toContain('# Remote: https://github.com/org/repo/pull/200');
    expect(result.comparisonContent).toContain('# Remote: https://github.com/org/repo/pull/200');
  });

  test('remote URL appears after goal in header', () => {
    const content = buildEditorContent('Response', 'task1', 'Goal 1', 'https://github.com/test');
    const lines = content.split('\n');
    let goalLineIdx = -1;
    let remoteLineIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('# Goal:')) goalLineIdx = i;
      if (lines[i].includes('# Remote:')) remoteLineIdx = i;
    }
    expect(goalLineIdx).toBeGreaterThanOrEqual(0);
    expect(remoteLineIdx).toBeGreaterThanOrEqual(0);
    expect(remoteLineIdx).toBeGreaterThan(goalLineIdx);
  });
});
