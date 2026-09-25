/**
 * Cluster progress as HTML, for every web surface that shows it.
 *
 * The derivation itself is `clusterProgressOf` (src/task/cluster-progress.ts) and
 * is never recomputed here. This module only owns the WORDING and the links, so
 * the Subtasks rollup and the sticky review bar cannot phrase the same numbers
 * two different ways — the text surfaces (`lazy show`) already share
 * `formatClusterProgress` for the same reason.
 */

import type { Task } from '../types';
import { duplicateTaskCodes, taskPath } from './task-urls';
import { clusterProgressOf, type ClusterProgress } from '../task/cluster-progress';
import { escapeHtml } from './review-diff';
import { displayId } from './templates';

export interface ClusterProgressHtmlOptions {
  /**
   * One-line mode for the sticky bar: deferred children are a count rather
   * than a list of links, because the bar must not wrap and a cluster can defer
   * many children.
   */
  compact?: boolean;
  /**
   * Codes shared by more than one task — those children link by id instead.
   * Derived from the children being rendered, so the line is dup-safe on its
   * own rather than relying on every caller to thread a set.
   */
  duplicated?: ReadonlySet<string>;
}

function childLink(child: Task, duplicated?: ReadonlySet<string>): string {
  return `<a href="${taskPath(child, duplicated)}">${escapeHtml(displayId(child))}</a>`;
}

/**
 * The parts of the progress line, in the order every surface renders them:
 * `k/n accepted`, what is running, what was deferred, what was closed.
 */
export function clusterProgressPartsHtml(
  progress: ClusterProgress,
  options: ClusterProgressHtmlOptions = {},
): string[] {
  // Absent a caller-supplied set, derive one from the children this line names
  // — they are exactly the links it is about to emit.
  const duplicated = options.duplicated
    ?? duplicateTaskCodes([...progress.running, ...progress.deferred].map((c) => ({ id: c.id, code: c.code })));
  const parts = [`<strong>${progress.accepted}/${progress.total}</strong> accepted`];
  if (progress.running.length > 0) {
    parts.push(`running ${progress.running.map((c) => childLink(c, duplicated)).join(', ')}`);
  }
  if (progress.deferred.length > 0) {
    parts.push(
      options.compact
        ? `${progress.deferred.length} deferred`
        : `deferred ${progress.deferred.map((c) => childLink(c, duplicated)).join(', ')}`,
    );
  }
  if (progress.closed > 0) {
    parts.push(`${progress.closed} closed`);
  }
  return parts;
}

/**
 * The cluster's line for the sticky review bar, or `''` when the task is not a
 * `cluster`. Every other type's bar is unchanged: there is no "0/0" for a task
 * that has no cluster semantics.
 */
export function clusterProgressBarHtml(task: Task, children: Task[]): string {
  const progress = clusterProgressOf(task, children);
  if (!progress) return '';
  const parts = clusterProgressPartsHtml(progress, {
    compact: true,
    // The whole child set, not just the linked subset: a code shared by a
    // running child and a closed one is still ambiguous in the URL.
    duplicated: duplicateTaskCodes(children.map((c) => ({ id: c.id, code: c.code }))),
  });
  return `<span class="rv-sb-cluster" data-rv-sb="cluster" title="Subtasks this cluster has accepted, out of the ones still expected to land.">Cluster: ${parts.join(' · ')}</span>`;
}
