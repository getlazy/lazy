/**
 * The Clusters page and the header nav around it.
 *
 * Two things are being kept honest here. First, the page's numbers: a cluster's
 * k-of-n is DERIVED from its children (src/task/cluster-progress.ts), so a page
 * that renders its own count would be a second source of truth that drifts the
 * first time a child is closed or accepted by a human. Second, the nav's shape:
 * Clusters second, Inbox last, and exactly ONE standalone search entry point.
 */

import { describe, test, expect } from 'bun:test';
import {
  activeClusterCount,
  clusterCardHtml,
  clustersPageHtml,
  sortClusterEntries,
  type ClusterEntry,
} from '../../src/server/cluster-tasks';
import { layoutHtml } from '../../src/server/templates';
import { MODIFIER_KEY_FALLBACK, modifierKeyScript } from '../../src/server/modifier-key';
import { PALETTE_COMMANDS, commandPaletteScript } from '../../src/server/command-palette';
import type { Task } from '../../src/types';

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    code: 'a-cluster',
    goal: 'Drive the review findings',
    prompt: '',
    status: 'working',
    type: 'cluster',
    created_at: 1000,
    updated_at: 1000,
    ...overrides,
  } as unknown as Task;
}

function child(overrides: Partial<Task> = {}): Task {
  return task({
    id: '22222222-2222-2222-2222-222222222222',
    code: 'child-one',
    goal: 'First finding',
    type: 'task',
    ...overrides,
  });
}

describe('Clusters page', () => {
  // INVARIANT: the k-of-n comes from clusterProgressOf over the CHILDREN. The page
  // must not carry a counter of its own — a stored or re-derived count drifts
  // the first time a child is closed, reparented away, or human-accepted.
  test('renders derived progress: accepted, running, deferred', () => {
    const cluster = task();
    const children = [
      child({ id: 'c1', code: 'done-one', status: 'complete' }),
      child({ id: 'c2', code: 'running-one', status: 'working' }),
      child({ id: 'c3', code: 'later-one', status: 'backlog', tags: ['deferred-by-a-cluster'] }),
    ];
    const html = clusterCardHtml({ task: cluster, children });
    expect(html).toContain('<strong>1/3</strong> accepted');
    expect(html).toContain('running');
    expect(html).toContain('running-one');
    expect(html).toContain('deferred');
    // Every child is visible without clicking into the cluster.
    for (const c of children) expect(html).toContain(c.code!);
  });

  test('a closed child leaves the denominator rather than inflating it', () => {
    const html = clusterCardHtml({
      task: task(),
      children: [
        child({ id: 'c1', code: 'done-one', status: 'complete' }),
        child({ id: 'c2', code: 'dropped', status: 'abandoned' }),
      ],
    });
    expect(html).toContain('<strong>1/1</strong> accepted');
    expect(html).toContain('1 closed');
  });

  test('a cluster with no children says so instead of showing an empty table', () => {
    const html = clusterCardHtml({ task: task(), children: [] });
    expect(html).toContain('has not created its first one');
    expect(html).not.toContain('<table');
  });

  test('the empty page explains what a cluster task is', () => {
    const html = clustersPageHtml([]);
    expect(html).toContain('No cluster tasks yet');
    expect(html).toContain('run at the same time');
  });

  // Running clusters are what the page is for; finished ones stay as the record.
  test('running clusters sort above finished ones, newest first within each', () => {
    const entries: ClusterEntry[] = [
      { task: task({ id: 'a', code: 'old-live', status: 'blocked', created_at: 1 }), children: [] },
      { task: task({ id: 'b', code: 'done', status: 'complete', created_at: 9 }), children: [] },
      { task: task({ id: 'c', code: 'new-live', status: 'working', created_at: 5 }), children: [] },
    ];
    expect(sortClusterEntries(entries).map((e) => e.task.code)).toEqual(['new-live', 'old-live', 'done']);
  });

  test('the nav badge counts live clusters only', () => {
    expect(activeClusterCount([
      task({ status: 'working' }),
      task({ status: 'complete' }),
      task({ status: 'blocked' }),
    ])).toBe(2);
  });

  test('the create form is reused, pinned to type cluster', () => {
    const html = clustersPageHtml([], { createFormHtml: '<form action="/tasks/new">stub</form>' });
    expect(html).toContain('New cluster');
    expect(html).toContain('action="/tasks/new"');
  });

  test('without an action port the page says creation is unavailable', () => {
    expect(clustersPageHtml([])).toContain('needs a daemon action port');
  });
});

describe('header nav', () => {
  const nav = (): string =>
    layoutHtml('Demo', '<p>hi</p>').match(/<nav class="nav">[\s\S]*?<\/nav>/)?.[0] ?? '';

  // INVARIANT: Clusters is the SECOND destination (after Dashboard) and Inbox is
  // the LAST one. Both positions were asked for by name; a later nav edit that
  // reorders them silently is what this test exists to catch.
  test('Clusters is second, Inbox is last', () => {
    const order = [...nav().matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]);
    // First entry is the brand link, second the Dashboard link.
    expect(order.slice(0, 3)).toEqual(['/', '/', '/clusters']);
    expect(order[order.length - 1]).toBe('/messages');
  });

  // INVARIANT: ONE standalone search entry point. The box and the palette chord
  // stay; the Search LINK is gone, and the palette gained a command to the full
  // page so it is still reachable from the chrome.
  test('no Search link, but a search box and a palette route to it', () => {
    expect(nav()).not.toContain('>Search</a>');
    expect(nav()).toContain('action="/search"');
    expect(PALETTE_COMMANDS.some((c) => c.href === '/search')).toBe(true);
    expect(commandPaletteScript()).toContain("'/search?q='");
  });

  test('Clusters carries a count badge like its neighbours', () => {
    expect(nav()).toContain('id="nav-clusters"');
    expect(layoutHtml('Demo', '')).toContain("clusters: document.getElementById('nav-clusters')");
  });
});

describe('platform modifier key', () => {
  // INVARIANT: the server cannot know whether the human is on a Mac, so no
  // page may SPELL the chord. It renders the both-platforms fallback and marks
  // the element; the island rewrites it with the real key.
  test('the nav search box is marked for the island, not spelled by the server', () => {
    const html = layoutHtml('Demo', '<p>hi</p>');
    expect(html).toContain('data-lz-modkey-placeholder="search… (%s)"');
    expect(html).toContain('data-lz-modkey-title="Open the command palette with %s"');
    // The no-JS text names both platforms rather than guessing one.
    expect(html).toContain(MODIFIER_KEY_FALLBACK);
  });

  test('the island picks ⌘K on a Mac and Ctrl+K elsewhere', () => {
    const script = modifierKeyScript();
    expect(script).toContain("mac ? '⌘K' : 'Ctrl+K'");
    expect(script).toContain('userAgentData');
    expect(script).toContain('navigator.platform');
    expect(script).toContain('data-lz-modkey-placeholder');
  });

  test('every layout page ships the island', () => {
    expect(layoutHtml('Demo', '<p>hi</p>')).toContain('data-lz-modkey-title');
  });
});
