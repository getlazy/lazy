/**
 * Boundary parsing for the Link form. Code / parent validation is the
 * daemon's — this helper only trims and requires a ref.
 */

import { describe, test, expect } from 'bun:test';
import { parseLinkTaskForm, readLinkTaskDraft } from '../../src/server/task-link-form';
import { taskLinkHtml } from '../../src/server/templates';

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

describe('parseLinkTaskForm', () => {
  test('reads every box', () => {
    const draft = readLinkTaskDraft(form({
      ref: ' origin/feature/auth ',
      parent: 'release-v023',
      code: 'fix-auth',
    }));
    expect(draft.ref).toBe(' origin/feature/auth ');
    expect(draft.parent).toBe('release-v023');
    expect(draft.code).toBe('fix-auth');
  });

  test('refuses an empty ref and keeps the typed parent', () => {
    const result = parseLinkTaskForm(form({
      ref: '   ',
      parent: 'keep-me',
      code: 'also-kept',
    }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('required');
    expect(result.draft.parent).toBe('keep-me');
    expect(result.draft.code).toBe('also-kept');
  });

  test('accepts a PR URL with optional fields blank', () => {
    const result = parseLinkTaskForm(form({
      ref: 'https://github.com/org/repo/pull/12',
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft.ref).toBe('https://github.com/org/repo/pull/12');
  });
});

describe('taskLinkHtml', () => {
  test('renders the link fields and always uses the action dialog', () => {
    const html = taskLinkHtml(
      { ref: 'feature/auth', parent: 'release-v023', code: '' },
      { parentTargets: { tasks: [], branches: ['main'] } },
    );
    expect(html).toContain('name="ref"');
    expect(html).toContain('name="parent"');
    expect(html).toContain('name="code"');
    expect(html).toContain('feature/auth');
    expect(html).toContain('value="release-v023"');
    expect(html).toContain('data-lz-action-when="always"');
    expect(html).toContain('id="lz-action-dialog"');
  });

  test('escapes every typed value it re-renders', () => {
    const html = taskLinkHtml(
      {
        ref: `"><img src=x onerror=alert(1)>`,
        parent: `"><img src=x>`,
        code: '"><code',
      },
      {
        parentTargets: { tasks: [], branches: [] },
        notice: { text: '<em>owned</em>', error: true },
      },
    );
    expect(html).toContain('value="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"');
    expect(html).toContain('value="&quot;&gt;&lt;img src=x&gt;"');
    expect(html).not.toContain('<em>owned</em>');
    expect(html).toContain('&lt;em&gt;owned&lt;/em&gt;');
    expect(html).not.toContain('value=""><img');
  });
});
