/**
 * The Clusters page — every `cluster` task, how far along it is, and a form to
 * start a new one.
 *
 * A `cluster` task drives its own subtasks: brief them, schedule them, review
 * what comes back, accept or send back. That makes "where is it" a question
 * about the TREE, not about the driver's own turns — which is why this page is
 * a list of clusters with their children rather than another task table.
 *
 * Progress is DERIVED by `clusterProgressOf` (src/task/cluster-progress.ts) and
 * worded by `clusterProgressPartsHtml` (./cluster-progress-html.ts). This module
 * stores no counter and recomputes none: a stored k-of-n drifts the first time
 * a child is closed, reparented away, or accepted by a human instead of by the
 * driver.
 *
 * NOT the old `/loop` review-queue page (./loop.ts), which is the browser half
 * of `lazy loop` — the human's own walk through a queue of tasks, and the thing
 * the word "loop" means now that the task type is called `cluster`.
 */

import type { Task } from '../storage';
import { deferredByTag, isDeferredBy, clusterProgressOf } from '../task/cluster-progress';
import { activeClusterCount, sortClusterEntries, type ClusterEntry } from '../task/cluster-entries';
import { clusterProgressPartsHtml } from './cluster-progress-html';
import { escapeHtml } from './review-diff';
import { displayId, layoutHtml, statusBadge } from './templates';
import { duplicateTaskCodes, taskPath } from './task-urls';
import { timestampHtml } from './timestamps';

/**
 * The read, the order and the live count are shared with the `clusters` RPC (a
 * remote client renders the same clusters) and live in
 * src/task/cluster-entries.ts. Re-exported here so this module still names every
 * piece the page is built from, and so existing importers of the page's module
 * keep working.
 */
export { activeClusterCount, sortClusterEntries, type ClusterEntry };

function taskLink(task: Task, duplicated?: ReadonlySet<string>): string {
  return `<a href="${taskPath(task, duplicated)}">${escapeHtml(displayId(task))}</a>`;
}

/**
 * Codes shared by more than one task ANYWHERE on this page — every cluster and
 * every child, in one set. Derived from the rows being rendered, the way
 * `subtasksSectionHtml` does: a shared code names no task unambiguously, so a
 * row carrying one must link by id or it lands the reader on the resolver's
 * winner rather than the task the row is about.
 *
 * The set spans the whole page rather than one card because the two tasks
 * sharing a code need not be in the same cluster.
 */
function pageDuplicateCodes(entries: readonly ClusterEntry[]): Set<string> {
  const refs = entries.flatMap((e) => [e.task, ...e.children]).map((t) => ({ id: t.id, code: t.code }));
  return duplicateTaskCodes(refs);
}

/**
 * A cluster's children as rows: what landed, what is running, what was set
 * aside.
 *
 * Deferred children are marked from the cluster's own `deferred-by-<code>` tag —
 * the same tag `tag:` search matches — so the page cannot invent a second
 * definition of "deferred".
 */
function childrenTableHtml(
  cluster: Task,
  children: readonly Task[],
  duplicated?: ReadonlySet<string>,
): string {
  if (children.length === 0) {
    return `<p class="text-muted lz-clusters-empty-children">No subtasks yet — this cluster has not created its first one.</p>`;
  }
  const tag = deferredByTag(cluster);
  const rows = [...children]
    .sort((a, b) => a.created_at - b.created_at)
    .map((child) => {
      const deferred = isDeferredBy(cluster, child);
      return `<tr>
        <td>${taskLink(child, duplicated)}</td>
        <td>${statusBadge(child.status)}</td>
        <td>${deferred ? `<span class="tag tag-neutral" title="Set aside by this cluster (tag ${escapeHtml(tag)})">deferred</span>` : ''}</td>
        <td class="wrap">${escapeHtml(child.goal)}</td>
      </tr>`;
    })
    .join('\n');
  return `<table class="table lz-clusters-children">
    <thead><tr><th>Task</th><th>Status</th><th></th><th>Goal</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

/** One cluster: its heading, its derived progress line, and its children. */
export function clusterCardHtml(entry: ClusterEntry, duplicated?: ReadonlySet<string>): string {
  const { task, children } = entry;
  // A card rendered on its own still defends itself: without a page-wide set,
  // derive one from this cluster and its children.
  const dups = duplicated ?? pageDuplicateCodes([entry]);
  const progress = clusterProgressOf(task, children);
  const line = progress
    ? `<p class="lz-cluster-progress">${clusterProgressPartsHtml(progress, { duplicated: dups }).join(' · ')}</p>`
    : '';
  return `<section class="lz-cluster-card">
    <h2 class="lz-cluster-card-head">
      ${taskLink(task, dups)} ${statusBadge(task.status)}
      <span class="lz-cluster-goal">${escapeHtml(task.goal)}</span>
    </h2>
    <p class="text-muted lz-cluster-meta">created ${timestampHtml(task.created_at)}</p>
    ${line}
    ${childrenTableHtml(task, children, dups)}
  </section>`;
}

/**
 * What a cluster task IS, in the page's own words. Shown above the list and as
 * the empty state, because the answer to "why is this page empty" and the
 * answer to "what am I looking at" are the same sentence.
 */
const CLUSTER_EXPLAINER =
  'A <strong>cluster</strong> task does not do the work itself: its agent creates subtasks and drives them — deciding which of them can run at the same time, reviewing each one as it comes back, and accepting it into the cluster\'s branch. Progress below is derived from those subtasks, never stored.';

export interface ClustersPageOptions {
  /** The New-cluster form body — `taskCreateFormHtml` with the type pinned to `cluster`. */
  createFormHtml?: string;
  /** Action-dialog chrome + script, needed by the create form's Start now path. */
  createChromeHtml?: string;
}

/** The whole page. */
export function clustersPageHtml(entries: readonly ClusterEntry[], options: ClustersPageOptions = {}): string {
  const sorted = sortClusterEntries(entries);
  const create = options.createFormHtml
    ? `<details class="lz-clusters-create">
        <summary>New cluster</summary>
        <p class="text-muted">Creates a task of type <code>cluster</code>. Give it the goal of the whole cluster; its agent creates the subtasks.</p>
        ${options.createFormHtml}
      </details>`
    : `<p class="text-muted">Creating a cluster from here needs a daemon action port; this dashboard was started without one.</p>`;

  // One set for the whole page, like search/palette: two tasks sharing a code
  // need not sit in the same cluster.
  const duplicated = pageDuplicateCodes(sorted);
  const body = sorted.length === 0
    ? `<div class="empty-state">No cluster tasks yet.</div>`
    : sorted.map((entry) => clusterCardHtml(entry, duplicated)).join('\n');

  const count = activeClusterCount(sorted.map((e) => e.task));
  const summary = sorted.length === 0
    ? ''
    // "open" rather than "running": a backlog cluster has not started a turn
    // yet, and the badge counts it, so saying "running" would make the page and
    // the badge describe the same number differently.
    : `<p class="text-muted">${sorted.length} cluster${sorted.length === 1 ? '' : 's'}, ${count} open.</p>`;

  return layoutHtml('Clusters', `
    <h1>Clusters</h1>
    <p class="lz-clusters-explainer">${CLUSTER_EXPLAINER}</p>
    ${create}
    ${summary}
    ${body}
    ${options.createChromeHtml ?? ''}
  `);
}
