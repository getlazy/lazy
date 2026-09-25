/**
 * Markup tests for two review-page polish fixes:
 *
 * 1. The maintained-group skip reasons render as a LABELLED viewable card —
 *    not orphan prose. The reviewer meets the agent's `lazy_justify_maintain`
 *    reasons with a header saying what they are, one row per group, and a
 *    plain explanation of what a maintained group is. The internal word
 *    "(structured)" never reaches the page.
 *
 * 2. Unblock / Ask / Accept are three buttons that open dialogs — not an
 *    in-card tab control whose panels jerked the layout. Forms live in
 *    `<template>`s (plus a `<noscript>` copy). The dialog CSS lives in
 *    review.css next to the raised-item dialog.
 */

import { describe, test, expect } from 'bun:test';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { maintainDecisionsHtml, reviewTaskHtml } from '../../src/server/review';
import type { FileDecision } from '../../src/types';
import type { Task } from '../../src/storage';

function decision(target: string, reason: string, scope: 'maintain' | 'protected' = 'maintain'): FileDecision {
  return {
    id: `id-${target}`,
    task_id: 'task1234abcd',
    scope,
    target,
    decision: 'keep',
    reason,
    created_at: 1,
  } as FileDecision;
}

function task(): Task {
  return {
    id: 'task1234abcd',
    code: 'demo-task',
    goal: 'Do the thing',
    prompt: '',
    type: 'task',
    status: 'blocked',
    priority: 'normal',
    created_at: 1,
    completed_at: null,
    target: { kind: 'branch', branch: 'main' },
    branched_from_sha: null,
    close_reason: null,
    model: null,
    agent_id: 'claude-code',
    metadata: null,
  } as unknown as Task;
}

describe('maintained-group skip card', () => {
  test('renders a labelled viewable card with one row per group and an explanation', () => {
    const html = maintainDecisionsHtml([
      decision('docs', 'no internal docs page went stale'),
      decision('changelog', 'intra-release fix, no entry needed'),
    ]);
    // Shared viewable-card chrome: collapses and ticks like every other card.
    expect(html).toContain('data-viewed-key="card:maintain-skips"');
    expect(html).toContain('data-content-hash=');
    expect(html).toContain('rv-maintain-decisions');
    // A header the reviewer understands, with the count.
    expect(html).toContain('Maintained files the agent chose not to update');
    expect(html).toContain('2 groups skipped');
    // One row per group: name and the agent's reason.
    expect(html).toContain('<strong>docs</strong>');
    expect(html).toContain('no internal docs page went stale');
    expect(html).toContain('<strong>changelog</strong>');
    expect(html).toContain('intra-release fix, no entry needed');
    // A plain one-line explanation of what a maintained group is.
    expect(html).toContain('expected to be kept up to date');
    // Internal distinction never reaches user-facing text.
    expect(html).not.toContain('(structured)');
  });

  test('singular head for one group; protected decisions do not leak in; empty is empty', () => {
    const one = maintainDecisionsHtml([
      decision('docs', 'nothing stale'),
      decision('src/secret.ts', 'needed', 'protected'),
    ]);
    expect(one).toContain('1 group skipped');
    expect(one).not.toContain('src/secret.ts');
    expect(maintainDecisionsHtml([])).toBe('');
    expect(maintainDecisionsHtml([decision('x', 'y', 'protected')])).toBe('');
  });
});

describe('action dialogs instead of in-card tabs', () => {
  test('the action card is three dialog buttons, not a tablist', () => {
    const html = reviewTaskHtml(task(), '', []);
    expect(html).toContain('data-lz-action-open="unblock"');
    expect(html).toContain('data-lz-action-open="ask"');
    expect(html).toContain('data-lz-action-open="accept"');
    expect(html).toContain('data-lz-action-template="unblock"');
    expect(html).toContain('data-lz-action-template="ask"');
    expect(html).toContain('data-lz-action-template="accept"');
    expect(html).not.toContain('rv-tablist');
    expect(html).not.toContain('data-rv-tab=');
    expect(html).not.toContain("classList.add('rv-tabs-ready')");
    expect(html).not.toContain('task-action-disclosure');
  });

  test('the stylesheet styles live action steps', async () => {
    const css = await readFile(join(import.meta.dir, '../../src/server/styles/review.css'), 'utf-8');
    expect(css).toContain('.lz-action-steps');
    expect(css).toContain('.lz-action-step[data-state="failed"]');
    expect(css).toContain('dialog.lz-action-dialog');
    expect(css).toContain('dialog.lz-action-form-hidden .lz-action-dialog-body');
    expect(css).toContain('min-height: min(28rem, calc(100vh - 40px))');
    expect(css).toContain('height: auto');
    expect(css).toContain('.lz-action-dialog-body .rv-form-actions');
    expect(css).toContain('position: sticky');
  });

  test('queued extras still sit on the page, not inside a tab panel', () => {
    const html = reviewTaskHtml(task(), '', []);
    expect(html).toContain('data-rv-queued');
    expect(html).toContain('rv-task-threads');
  });
});
