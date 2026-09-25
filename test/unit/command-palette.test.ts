/**
 * Global command palette — markup contract and load-bearing script wiring.
 *
 * Same posture as review-navigation tests: no DOM harness, so we pin the
 * emitted chrome and the chord / mode seams as text. Runtime behaviour
 * (showModal, fetch) is covered lightly in the e2e suite.
 */

import { describe, test, expect } from 'bun:test';
import {
  PALETTE_COMMANDS,
  commandPaletteChromeHtml,
  commandPaletteScript,
  searchResultHref,
} from '../../src/server/command-palette';
import { layoutHtml, taskCreateFormHtml, type AgentChoice } from '../../src/server/templates';
import type { TaskCreateDraft } from '../../src/server/task-create-form';

const emptyDraft: TaskCreateDraft = {
  goal: '',
  prompt: '',
  code: '',
  parent: '',
  type: 'task',
  model: '',
  effort: '',
  review: '',
  reviewGate: '',
  reviewAutoFix: '',
  agent: '',
  startNow: false,
};

describe('command palette commands', () => {
  // INVARIANT: the human-named destinations stay reachable from command mode.
  // Dropping one from the list silently removes it from Cmd+Shift+K.
  test('includes every destination the task asked for', () => {
    const labels = PALETTE_COMMANDS.map((c) => c.label);
    expect(labels).toContain('Create new task');
    expect(labels).toContain('Navigate to dashboard');
    expect(labels).toContain('Navigate to all tasks');
    expect(labels).toContain('Navigate to blocked tasks');
    expect(labels).toContain('Navigate to review queue');
    expect(labels).toContain('Navigate to inbox');
    expect(labels).toContain('Navigate to all raised items');
    expect(labels).toContain('Navigate to blocking raised items');
  });

  test('create-task is an action; navigation commands have hrefs', () => {
    const create = PALETTE_COMMANDS.find((c) => c.id === 'create-task');
    expect(create?.action).toBe('create-task');
    expect(create?.href).toBeUndefined();

    expect(PALETTE_COMMANDS.find((c) => c.id === 'dashboard')?.href).toBe('/');
    expect(PALETTE_COMMANDS.find((c) => c.id === 'tasks-all')?.href).toBe('/tasks?filter=all');
    expect(PALETTE_COMMANDS.find((c) => c.id === 'tasks-blocked')?.href).toBe('/tasks?filter=blocked');
    expect(PALETTE_COMMANDS.find((c) => c.id === 'review')?.href).toBe('/review');
    expect(PALETTE_COMMANDS.find((c) => c.id === 'inbox')?.href).toBe('/messages');
    expect(PALETTE_COMMANDS.find((c) => c.id === 'raised-all')?.href).toBe('/raised?all=1');
    expect(PALETTE_COMMANDS.find((c) => c.id === 'raised-blocking')?.href).toBe('/raised?gate=blocking');
  });
});

describe('searchResultHref', () => {
  test('routes entity types to their real pages', () => {
    expect(searchResultHref({
      entity_type: 'task',
      entity_id: 't1',
      task_id: 'abcd1234',
    })).toBe('/tasks/abcd1234');

    expect(searchResultHref({
      entity_type: 'turn',
      entity_id: 'u1',
      task_id: 'abcd1234',
      turn_sequence: 7,
    })).toBe('/tasks/abcd1234/turns/7');

    expect(searchResultHref({
      entity_type: 'conversation',
      entity_id: 'sess-1',
      task_id: 'sess-1',
    })).toBe('/conversations/sess-1');

    expect(searchResultHref({
      entity_type: 'memory',
      entity_id: 'alpha-scope',
      task_id: 'alpha-scope',
    })).toBe('/memory/alpha-scope');

    expect(searchResultHref({
      entity_type: 'raised',
      entity_id: 'ri-9',
      task_id: 'abcd1234',
    })).toBe('/raised/ri-9');
  });
});

describe('command palette chrome and script', () => {
  test('chrome emits palette and create dialogs', () => {
    const html = commandPaletteChromeHtml();
    expect(html).toContain('id="lz-palette"');
    expect(html).toContain('id="lz-palette-input"');
    expect(html).toContain('id="lz-palette-results"');
    expect(html).toContain('id="lz-create-dialog"');
    expect(html).toContain('id="lz-create-dialog-body"');
  });

  // INVARIANT: Cmd/Ctrl+K opens search; Cmd/Ctrl+Shift+K opens command mode.
  // The island must claim the chord (preventDefault) and treat shift as the
  // mode switch — renaming either seam ships a page whose shortcut does nothing.
  test('script wires Cmd/Ctrl+K and Shift for command mode', () => {
    const script = commandPaletteScript();
    expect(script).toContain("ev.metaKey || ev.ctrlKey");
    expect(script).toContain("toLowerCase() !== 'k'");
    expect(script).toContain('openPalette(!!ev.shiftKey)');
    expect(script).toContain("'/api/search?q='");
    expect(script).toContain("'/tasks/new?fragment=1'");
    expect(script).toContain("action === 'create-task'");
    expect(script).toContain("raw.charAt(0) !== '>'");
    // Page j/k island ignores meta/ctrl; this one must still skip the terminal.
    expect(script).toContain(".xterm");
  });

  test('every layout page ships the palette', () => {
    const page = layoutHtml('Demo', '<p>hi</p>');
    expect(page).toContain('id="lz-palette"');
    expect(page).toContain('window.lzOpenCommandPalette');
    expect(page).toContain('Ctrl/Cmd+K');
  });
});

describe('create-task fragment form', () => {
  test('fragment Cancel closes the dialog; page Cancel links to /tasks', () => {
    const opts = {
      agents: [] as AgentChoice[],
      efforts: [] as string[],
      types: ['task'] as string[],
      parentTargets: null,
    };
    const fragment = taskCreateFormHtml(emptyDraft, opts, 'fragment');
    expect(fragment).toContain('data-lz-create-cancel');
    expect(fragment).not.toContain('href="/tasks"');
    expect(fragment).toContain('name="goal"');
    expect(fragment).toContain('action="/tasks/new"');

    const page = taskCreateFormHtml(emptyDraft, opts, 'page');
    expect(page).toContain('href="/tasks"');
    expect(page).not.toContain('data-lz-create-cancel');
  });
});
