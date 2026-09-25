/**
 * Web dashboard: note cards (journal entries and comments) are MARKDOWN.
 *
 * They used to render as one escaped line, which made a multi-paragraph journal
 * entry — the normal shape for a design-rationale note — unreadable on the task
 * page. They now go through the same sanitizing renderer as turns and prompts,
 * so raw HTML in agent-written text is still escaped.
 */

import { describe, test, expect } from 'bun:test';
import { taskDetailHtml } from '../../src/server/templates';
import type { Task, Comment, JournalEntry } from '../../src/types';

function makeTask(): Task {
  return {
    id: 'task-id-0001',
    code: 'web-notes-markdown',
    goal: 'Render notes as markdown',
    prompt: 'do the thing',
    type: 'task',
    status: 'blocked',
    created_at: new Date('2026-09-02T10:00:00Z').getTime(),
    completed_at: null,
    target: { kind: 'branch' as const, branch: 'main' },
    branched_from_sha: null,
    close_reason: null,
    model: null,
    agent_id: 'claude-code',
    runner_type: null,
    metadata: null,
    tags: [],
    pending_sync: 0,
  };
}

function makeJournal(content: string): JournalEntry {
  return {
    id: 'j-0001',
    task_id: 'task-id-0001',
    content,
    created_at: new Date('2026-09-02T11:00:00Z').getTime(),
    actor: 'agent',
  };
}

function makeComment(content: string): Comment {
  return {
    id: 'c-0001',
    task_id: 'task-id-0001',
    content,
    created_at: new Date('2026-09-02T11:30:00Z').getTime(),
    actor: 'human',
  };
}

/** taskDetailHtml(task, session, turns, commits, comments, journal, followUps, children, promptVersions) */
function render(opts: { comments?: Comment[]; journal?: JournalEntry[] }): string {
  return taskDetailHtml(
    makeTask(),
    null,
    [],
    [],
    opts.comments ?? [],
    opts.journal ?? [],
    [],
    [],
    [],
  );
}

const MARKDOWN_ENTRY = [
  '## Why K=3',
  '',
  'Two reasons:',
  '',
  '- the third retry is where the flake stops',
  '- anything higher hides a real failure',
  '',
  '```ts',
  'const RETRIES = 3;',
  '```',
];

describe('taskDetailHtml note cards render markdown', () => {
  test('a journal entry with a heading, list and code fence renders as HTML blocks', () => {
    const html = render({ journal: [makeJournal(MARKDOWN_ENTRY.join('\n'))] });

    expect(html).toContain('<h2>Why K=3</h2>');
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>the third retry is where the flake stops</li>');
    expect(html).toContain('<pre><code class="language-ts">const RETRIES = 3;</code></pre>');
    // The date/actor header stays.
    expect(html).toContain('agent');
  });

  test('a comment with a list and code fence renders as HTML blocks', () => {
    const html = render({ comments: [makeComment('- first\n- second\n\n```\nfoo()\n```')] });

    expect(html).toContain('<li>first</li>');
    expect(html).toContain('<li>second</li>');
    expect(html).toContain('<pre><code>foo()</code></pre>');
  });

  test('raw HTML in a journal entry is escaped, not rendered', () => {
    const html = render({ journal: [makeJournal('before <script>alert(1)</script> after')] });

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  test('raw HTML in a comment is escaped, not rendered', () => {
    const html = render({ comments: [makeComment('<img src=x onerror="alert(1)">')] });

    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
  });
});
