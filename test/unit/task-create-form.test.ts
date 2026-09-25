/**
 * Boundary parsing for the New-task form. Validation of code / type / agent
 * / parent is the daemon's — this helper only trims, requires a goal, and
 * refuses Start now without a prompt so we do not create-then-fail-start.
 */

import { describe, test, expect } from 'bun:test';
import { parseCreateTaskForm, readCreateTaskDraft } from '../../src/server/task-create-form';
import { taskCreateHtml } from '../../src/server/templates';

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

describe('parseCreateTaskForm', () => {
  test('reads every box and treats a missing checkbox as not starting', () => {
    const draft = readCreateTaskDraft(form({
      goal: ' Add auth ',
      prompt: '# Do it',
      code: 'add-auth',
      parent: 'release-v022',
      type: 'feature',
      model: 'opus',
      effort: 'high',
      agent: 'cursor',
    }));
    expect(draft.goal).toBe(' Add auth ');
    expect(draft.prompt).toBe('# Do it');
    expect(draft.code).toBe('add-auth');
    expect(draft.parent).toBe('release-v022');
    expect(draft.type).toBe('feature');
    expect(draft.model).toBe('opus');
    expect(draft.effort).toBe('high');
    expect(draft.agent).toBe('cursor');
    expect(draft.startNow).toBe(false);
  });

  test('start_now is true only when the box sends 1', () => {
    expect(readCreateTaskDraft(form({ goal: 'G', start_now: '1' })).startNow).toBe(true);
    expect(readCreateTaskDraft(form({ goal: 'G', start_now: 'on' })).startNow).toBe(false);
  });

  test('refuses an empty goal and keeps the typed prompt', () => {
    const result = parseCreateTaskForm(form({
      goal: '   ',
      prompt: 'A paragraph that must not be lost.',
    }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('goal cannot be empty');
    expect(result.draft.prompt).toBe('A paragraph that must not be lost.');
  });

  test('refuses Start now without a prompt so nothing is created', () => {
    const result = parseCreateTaskForm(form({
      goal: 'Add auth',
      prompt: '  ',
      start_now: '1',
    }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('prompt is required to start');
    expect(result.draft.goal).toBe('Add auth');
    expect(result.draft.startNow).toBe(true);
  });

  test('accepts a goal-only create that stays in backlog', () => {
    const result = parseCreateTaskForm(form({ goal: 'Add auth' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft.goal).toBe('Add auth');
    expect(result.draft.startNow).toBe(false);
  });
});

describe('taskCreateHtml', () => {
  test('renders the create fields and a suggested code from the goal', () => {
    const html = taskCreateHtml(
      {
        goal: 'Add authentication',
        prompt: 'Do it',
        code: '',
        parent: 'release-v022',
        type: 'feature',
        model: '',
        effort: '',
        review: '',
        reviewGate: '',
        reviewAutoFix: '',
        agent: '',
        startNow: false,
      },
      {
        agents: [
          { name: 'company-tokens-cursor', summary: 'cursor · claude-sonnet-5 · key: work-cursor', group: 'configured' },
          { name: 'claude-code', summary: 'claude-code · claude-code default model', group: 'builtin' },
        ],
        efforts: ['low', 'medium', 'high'],
        types: ['task', 'feature'],
        parentTargets: { tasks: [], branches: ['main'] },
      },
    );
    expect(html).toContain('name="goal"');
    expect(html).toContain('Add authentication');
    expect(html).toContain('add-authentication');
    expect(html).toContain('name="start_now"');
    expect(html).toContain('data-lz-action-when="start_now"');
    expect(html).toContain('value="release-v022"');
    expect(html).toContain('id="lz-action-dialog"');

    // INVARIANT: the agent picker offers PROFILES, the project's own first and
    // labelled as configured, each showing what it runs. A flat list of names
    // reads as a list of harnesses, which is what led a human to pick an
    // "agent" their lazy.toml never defined.
    expect(html).toContain('<optgroup label="Configured profiles (lazy.toml)">');
    expect(html).toContain('<optgroup label="Built-in profiles">');
    expect(html).toContain('company-tokens-cursor — cursor · claude-sonnet-5 · key: work-cursor');
    expect(html.indexOf('company-tokens-cursor')).toBeLessThan(html.indexOf('Built-in profiles'));
    expect(html).toContain('[agents.&lt;name&gt;]');
  });

  test('a degraded picker says so instead of calling everything built-in', () => {
    // INVARIANT: when the project's profiles cannot be read the form still
    // renders, but it must SAY the set is degraded. Silently relabelling a
    // human's own configured profile as a built-in is worse than the old
    // unlabelled list: it asserts something false, in the one place whose job
    // is to say where a name came from.
    const html = taskCreateHtml(
      {
        goal: 'G', prompt: '', code: '', parent: '', type: 'task',
        model: '', effort: '', review: '', reviewGate: '', reviewAutoFix: '', agent: '', startNow: false,
      },
      {
        agents: [
          { name: 'claude-code', summary: '', group: 'degraded' },
          { name: 'cursor', summary: '', group: 'degraded' },
        ],
        agentsNotice: 'Could not read this project’s agent profiles: bad [agents.x] block',
        efforts: ['low'],
        types: ['task'],
        parentTargets: { tasks: [], branches: [] },
      },
    );
    expect(html).toContain('Could not read this project’s agent profiles: bad [agents.x] block');
    expect(html).toContain('<optgroup label="Built-in agents (lazy.toml unread)">');
    expect(html).not.toContain('<optgroup label="Configured profiles (lazy.toml)">');
    expect(html).not.toContain('<optgroup label="Built-in profiles">');
  });

  test('escapes every typed value it re-renders', () => {
    const html = taskCreateHtml(
      {
        goal: `"><img src=x onerror=alert(1)>`,
        prompt: '<script>alert(1)</script>',
        code: '"><code',
        parent: `"><img src=x>`,
        type: 'task',
        model: '"><model',
        effort: '',
        review: '',
        reviewGate: '',
        reviewAutoFix: '',
        agent: '',
        startNow: false,
      },
      {
        agents: [{ name: 'claude-code', summary: 'claude-code · claude-code default model', group: 'builtin' }],
        efforts: ['low'],
        types: ['task'],
        parentTargets: { tasks: [], branches: [] },
        notice: { text: '<em>owned</em>', error: true },
      },
    );
    // Layout scripts are real <script> tags; the assertion is that typed
    // values never re-enter the markup unescaped.
    expect(html).toContain('value="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('value="&quot;&gt;&lt;img src=x&gt;"');
    expect(html).toContain('value="&quot;&gt;&lt;model"');
    expect(html).not.toContain('<em>owned</em>');
    expect(html).toContain('&lt;em&gt;owned&lt;/em&gt;');
    expect(html).not.toContain('value=""><img');
  });
});
