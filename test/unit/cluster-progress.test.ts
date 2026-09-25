/**
 * A cluster task's k-of-n progress, derived from its children.
 *
 * INVARIANT: cluster progress is DERIVED from the tree, never stored. A counter
 * would drift the first time a child is closed, reparented away, or accepted by
 * a human rather than by the cluster's own agent — and the tree is what the cluster
 * agent itself is told to trust (src/prompts/cluster-constraints.md).
 *
 * INVARIANT: `lazy show`, its --json and the task page all render
 * clusterProgressOf, so no two surfaces can disagree about the counts.
 */

import { describe, test, expect } from 'bun:test';
import type { Task, TaskStatus, TaskType } from '../../src/types';
import {
  deferredByTag,
  formatClusterProgress,
  clusterProgressOf,
} from '../../src/task/cluster-progress';
import { hubRollupHtml, clusterProgressHtml } from '../../src/server/subtasks';
import { clusterProgressPartsHtml } from '../../src/server/cluster-progress-html';

function task(
  id: string,
  status: TaskStatus,
  opts: { type?: TaskType; tags?: string[]; code?: string | null } = {},
): Task {
  return {
    id,
    code: opts.code === undefined ? id : opts.code,
    goal: `goal ${id}`,
    prompt: '',
    type: opts.type ?? 'task',
    status,
    created_at: 1_000,
    completed_at: null,
    target: { kind: 'task', parentTaskId: 'the-cluster' },
    branched_from_sha: null,
    close_reason: null,
    model: null,
    agent_id: 'claude-code',
    runner_type: null,
    metadata: null,
    tags: opts.tags ?? [],
    pending_sync: 0,
  };
}

const cluster = task('the-cluster', 'blocked', { type: 'cluster', code: 'fix-review' });

describe('clusterProgressOf', () => {
  // INVARIANT: only `cluster` tasks have cluster progress — every other type returns
  // null so its surfaces render nothing at all, rather than "0/0".
  test('returns null for a task that is not a cluster', () => {
    const hub = task('hub', 'blocked', { type: 'feature' });
    expect(clusterProgressOf(hub, [task('a', 'complete')])).toBeNull();
  });

  test('counts accepted children against the children still expected to land', () => {
    const progress = clusterProgressOf(cluster, [
      task('a', 'complete'),
      task('b', 'complete'),
      task('c', 'blocked'),
      task('d', 'backlog'),
    ])!;
    expect(progress.accepted).toBe(2);
    expect(progress.total).toBe(4);
  });

  // INVARIANT: an abandoned child is excluded from the denominator. The cluster
  // decided it should not land; counting it would leave a finished cluster reading
  // as permanently incomplete.
  test('closed children leave the denominator and are reported separately', () => {
    const progress = clusterProgressOf(cluster, [
      task('a', 'complete'),
      task('b', 'abandoned'),
      task('c', 'blocked'),
    ])!;
    expect(progress.accepted).toBe(1);
    expect(progress.total).toBe(2);
    expect(progress.closed).toBe(1);
  });

  test('names the running child', () => {
    const progress = clusterProgressOf(cluster, [
      task('a', 'complete'),
      task('b', 'working'),
    ])!;
    expect(progress.running.map(t => t.id)).toEqual(['b']);
  });

  test('deferred children are the ones tagged by THIS cluster', () => {
    const progress = clusterProgressOf(cluster, [
      task('a', 'blocked', { tags: ['deferred-by-fix-review'] }),
      task('b', 'blocked', { tags: ['deferred-by-some-other-cluster'] }),
      task('c', 'blocked', { tags: [] }),
    ])!;
    expect(progress.deferred.map(t => t.id)).toEqual(['a']);
  });

  test('the deferred tag is built from the cluster code the same way tags normalize', () => {
    expect(deferredByTag(cluster)).toBe('deferred-by-fix-review');
    expect(deferredByTag({ id: 'abcdef1234', code: null })).toBe('deferred-by-abcdef12');
  });
});

describe('formatClusterProgress', () => {
  test('k of n first, then only the parts that apply', () => {
    const quiet = clusterProgressOf(cluster, [task('a', 'complete'), task('b', 'backlog')])!;
    expect(formatClusterProgress(quiet)).toBe('1/2 accepted');

    const busy = clusterProgressOf(cluster, [
      task('a', 'complete'),
      task('b', 'working'),
      task('c', 'blocked', { tags: ['deferred-by-fix-review'] }),
      task('d', 'abandoned'),
    ])!;
    expect(formatClusterProgress(busy)).toBe('1/3 accepted · running b · 1 deferred · 1 closed');
  });
});

describe('clusterProgressHtml', () => {
  test('renders the same counts as the text surface, with links to the children', () => {
    const html = clusterProgressHtml(cluster, [
      task('a', 'complete'),
      task('b', 'working'),
      task('c', 'blocked', { tags: ['deferred-by-fix-review'] }),
    ]);
    expect(html).toContain('1/3');
    expect(html).toContain('running');
    expect(html).toContain('/tasks/b');
    expect(html).toContain('deferred');
    expect(html).toContain('/tasks/c');
  });

  test('renders nothing for a task that is not a cluster', () => {
    const hub = task('hub', 'blocked', { type: 'feature' });
    expect(clusterProgressHtml(hub, [task('a', 'complete')])).toBe('');
  });

  // INVARIANT: every web surface showing cluster progress renders the same parts,
  // in the same order, from clusterProgressPartsHtml — the sticky review bar is
  // the third surface, and a third phrasing of the same numbers is exactly
  // what the shared renderer exists to prevent.
  test('the compact form is the same parts, with deferred children as a count', () => {
    const children = [
      task('a', 'complete'),
      task('b', 'working'),
      task('c', 'blocked', { tags: ['deferred-by-fix-review'] }),
    ];
    const progress = clusterProgressOf(cluster, children)!;
    expect(clusterProgressPartsHtml(progress)).toEqual([
      '<strong>1/3</strong> accepted',
      'running <a href="/tasks/b">b</a>',
      'deferred <a href="/tasks/c">c</a>',
    ]);
    expect(clusterProgressPartsHtml(progress, { compact: true })).toEqual([
      '<strong>1/3</strong> accepted',
      'running <a href="/tasks/b">b</a>',
      '1 deferred',
    ]);
  });
});

describe('hubRollupHtml', () => {
  // INVARIANT: the two surfaces render the same derivation, so neither may go
  // quiet where the other speaks. `lazy show` prints "Cluster progress: 0/0" for
  // a cluster with no children yet, which is exactly when an operator first opens
  // the page — the generic subtask rollup's empty-list early return must not
  // swallow the cluster line with it.
  test('a cluster with no children still says so', () => {
    const html = hubRollupHtml('the-cluster', [], cluster);
    expect(html).toContain('Cluster:');
    expect(html).toContain('0/0');
    // Still no subtask rollup — there are no subtasks to roll up.
    expect(html).not.toContain('lz-hub-rollup');
  });

  test('a task of any other type with no children renders nothing at all', () => {
    const hub = task('hub', 'blocked', { type: 'feature' });
    expect(hubRollupHtml('hub', [], hub)).toBe('');
    expect(hubRollupHtml('hub', [])).toBe('');
  });

  test('a cluster with children shows both lines', () => {
    const html = hubRollupHtml('the-cluster', [task('a', 'complete'), task('b', 'blocked')], cluster);
    expect(html).toContain('Cluster:');
    expect(html).toContain('lz-hub-rollup');
    expect(html).toContain('2 subtasks');
  });
});
