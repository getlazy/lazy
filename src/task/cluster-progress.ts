/**
 * How far along a `cluster` task is, derived from its children.
 *
 * NO new stored state: a cluster's progress is a function of the tree it already
 * has. Storing a counter would mean a second source of truth that drifts the
 * first time a child is closed, reparented away, or accepted by a human rather
 * than by its driver — and the tree is what the driver itself is
 * told to trust (src/prompts/cluster-constraints.md).
 *
 * Every surface that shows cluster progress — `lazy show`, its `--json`, the task
 * page — renders {@link clusterProgressOf}, so they cannot disagree about the
 * counts.
 */

import type { Task } from '../types';
import { isActiveStatus, isClusterTask } from '../types';
import { normalizeTag } from '../utils/tags';
import { displayId, shortId } from './identity';

export interface ClusterProgress {
  /** Children accepted into the cluster's branch (status `complete`). */
  accepted: number;
  /**
   * Denominator: children still expected to land. Abandoned/closed children
   * are excluded — the driver decided they should not land, so counting them
   * would make a finished cluster read as permanently incomplete.
   */
  total: number;
  /** Children the driver closed rather than landed. Reported, not counted in `total`. */
  closed: number;
  /**
   * The children currently running. A cluster may have ANY number — the daemon
   * used to refuse a second and no longer does (the serial rule was reversed on
   * 2026-09-20) — so this is derived from live status, never from a claim.
   */
  running: Task[];
  /** Children tagged `deferred-by-<cluster code>` — set aside by this cluster. */
  deferred: Task[];
}

/**
 * The tag a cluster puts on a child it has set aside, e.g.
 * `deferred-by-fix-review-findings`. Normalized the same way tags are on write
 * and on query, so `tag:` search and this helper agree.
 */
export function deferredByTag(cluster: Pick<Task, 'id' | 'code'>): string {
  return normalizeTag(`deferred-by-${cluster.code ?? shortId(cluster.id)}`);
}

/**
 * Has this cluster set this child aside?
 *
 * The one test, for every surface that marks a deferred child — the progress
 * derivation below, the Clusters page's child rows, and the `clusters` RPC a remote
 * client renders. A surface spelling the tag comparison itself is a second
 * definition of "deferred" one normalization rule away from disagreeing.
 */
export function isDeferredBy(cluster: Pick<Task, 'id' | 'code'>, child: Pick<Task, 'tags'>): boolean {
  const tag = deferredByTag(cluster);
  return (child.tags ?? []).some((t) => normalizeTag(t) === tag);
}

/**
 * Cluster progress for a `cluster`, or `null` for any other task type — callers
 * use the null to decide whether to render a cluster line at all.
 */
export function clusterProgressOf(task: Task, children: Task[]): ClusterProgress | null {
  if (!isClusterTask(task)) return null;

  const accepted = children.filter(c => c.status === 'complete').length;
  const closed = children.filter(c => c.status === 'abandoned').length;

  return {
    accepted,
    total: children.length - closed,
    closed,
    running: children.filter(c => isActiveStatus(c.status)),
    deferred: children.filter(c => isDeferredBy(task, c)),
  };
}

/**
 * A child as a remote client sees it in a progress line: enough to name it and
 * link to it, and nothing else.
 */
export interface ClusterTaskRef {
  id: string;
  code: string | null;
  goal: string;
  status: string;
}

/** The wire shape of {@link ClusterProgress} — see {@link clusterProgressPayload}. */
export interface ClusterProgressPayload {
  accepted: number;
  total: number;
  closed: number;
  running: ClusterTaskRef[];
  deferred: ClusterTaskRef[];
}

/**
  * Cluster progress as it travels — to `lazy show --json` and to any client of the
 * `show` / `clusters` RPCs.
 *
 * A PROJECTION, with no rule of its own: the numbers are exactly what
 * {@link clusterProgressOf} derived. It exists so the ANSWER travels and a second
 * copy of the derivation does not — a remote surface holding a task tree is one
 * status filter away from publishing a k-of-n that disagrees with `lazy show`
 * about whether a closed child still counts.
 */
export function clusterProgressPayload(progress: ClusterProgress): ClusterProgressPayload {
  const ref = (t: Task): ClusterTaskRef => ({
    id: t.id,
    code: t.code ?? null,
    goal: t.goal,
    status: t.status,
  });
  return {
    accepted: progress.accepted,
    total: progress.total,
    closed: progress.closed,
    running: progress.running.map(ref),
    deferred: progress.deferred.map(ref),
  };
}

/**
 * One scannable line: `3/7 accepted · running fix-foo · 2 deferred · 1 closed`.
 * Used verbatim by `lazy show`; the task page renders the same fields as links.
 */
export function formatClusterProgress(progress: ClusterProgress): string {
  const parts = [`${progress.accepted}/${progress.total} accepted`];
  if (progress.running.length > 0) {
    parts.push(`running ${progress.running.map(t => displayId(t)).join(', ')}`);
  }
  if (progress.deferred.length > 0) {
    parts.push(`${progress.deferred.length} deferred`);
  }
  if (progress.closed > 0) {
    parts.push(`${progress.closed} closed`);
  }
  return parts.join(' · ');
}
