/**
 * The Subtasks tab: direct children grouped by status, with a client-side
 * filter and no cap.
 *
 * Grouping is the mechanism that makes a 301-child hub readable — not
 * pagination, which the engineer rejected. Landing's one-line rollup uses
 * the same groups so the two surfaces cannot disagree about the counts.
 *
 * Status names in the design ("syncing", "queued") are informal. The groups
 * below map every real {@link TaskStatus} so a child always lands in exactly
 * one bucket:
 *   - Needs you — blocked, conflict (the reviewer came for these)
 *   - Active    — working and the in-flight states around it
 *   - Backlog   — not started, plus submitted / zombie (waiting, not live)
 *   - Done      — complete
 *   - Closed    — abandoned
 *
 * Each group lists its most recently updated child first; the column headers
 * re-sort a group in the browser, and a jump bar above the groups opens and
 * scrolls to one in a click.
 */

import type { Task, TaskStatus } from '../types';
import { duplicateTaskCodes, taskPath } from './task-urls';
import { escapeHtml } from './review-diff';
import { displayId, formatDate, statusBadge } from './templates';
import { resolveTaskForgeLink, taskForgeIconHtml } from '../task-forge-link';
import { formatLinkedMarker } from '../task/linked';
import { clusterProgressOf } from '../task/cluster-progress';
import { clusterProgressPartsHtml } from './cluster-progress-html';

/** The five groups, in the order the tab renders them. */
export const SUBTASK_GROUP_IDS = [
  'needs-you',
  'active',
  'backlog',
  'done',
  'closed',
] as const;

export type SubtaskGroupId = (typeof SUBTASK_GROUP_IDS)[number];

export interface SubtaskGroupSpec {
  id: SubtaskGroupId;
  /** Header label on the tab. */
  title: string;
  /** Phrase used in Landing's rollup ("2 need you"). */
  rollup: (n: number) => string;
  /**
   * When true the group starts collapsed. Backlog uses a count threshold
   * instead — see {@link BACKLOG_COLLAPSE_AFTER}.
   */
  collapsed: boolean;
}

export const SUBTASK_GROUPS: readonly SubtaskGroupSpec[] = [
  { id: 'needs-you', title: 'Needs you', rollup: (n) => `${n} need you`, collapsed: false },
  { id: 'active', title: 'Active', rollup: (n) => `${n} active`, collapsed: false },
  { id: 'backlog', title: 'Backlog', rollup: (n) => `${n} backlog`, collapsed: false },
  { id: 'done', title: 'Done', rollup: (n) => `${n} done`, collapsed: true },
  { id: 'closed', title: 'Closed', rollup: (n) => `${n} closed`, collapsed: true },
];

/**
 * Backlog starts collapsed once it is larger than this. The threshold is
 * "above ~20" from the design — 20 itself stays open so a modest backlog
 * is still scannable without a click.
 */
export const BACKLOG_COLLAPSE_AFTER = 20;

/**
 * Which group a status belongs to. Exhaustive on {@link TaskStatus} so a
 * new status is a compile error here rather than a silent "backlog" dump.
 */
export function subtaskGroupFor(status: TaskStatus): SubtaskGroupId {
  switch (status) {
    case 'blocked':
    case 'conflict':
      return 'needs-you';
    case 'working':
    case 'pairing':
    case 'interrupted':
    case 'merging':
      return 'active';
    case 'complete':
      return 'done';
    case 'abandoned':
      return 'closed';
    case 'backlog':
    case 'submitted':
    case 'zombie':
      return 'backlog';
  }
}

export interface GroupedSubtasks {
  id: SubtaskGroupId;
  title: string;
  collapsed: boolean;
  tasks: Task[];
}

/**
 * When a child last moved, as the Updated column shows it: its completion,
 * else its creation. A child carries no session here, so there is no later
 * interaction time to read.
 */
export function subtaskUpdatedAt(task: Task): number {
  return task.completed_at ?? task.created_at;
}

/** Newest-updated first; the code breaks ties so the order is stable. */
function byUpdatedDesc(a: Task, b: Task): number {
  return subtaskUpdatedAt(b) - subtaskUpdatedAt(a) || displayId(a).localeCompare(displayId(b));
}

/**
 * Split direct children into the five groups, each sorted newest-updated
 * first. Empty groups stay in the
 * result (count 0) so the tab can still name them; the renderer skips
 * drawing a group with nothing in it.
 */
export function groupSubtasks(children: Task[]): GroupedSubtasks[] {
  const buckets = new Map<SubtaskGroupId, Task[]>();
  for (const spec of SUBTASK_GROUPS) buckets.set(spec.id, []);
  for (const child of children) {
    buckets.get(subtaskGroupFor(child.status))!.push(child);
  }
  return SUBTASK_GROUPS.map((spec) => {
    const tasks = buckets.get(spec.id)!.sort(byUpdatedDesc);
    const collapsed =
      spec.id === 'backlog' ? tasks.length > BACKLOG_COLLAPSE_AFTER : spec.collapsed;
    return { id: spec.id, title: spec.title, collapsed, tasks };
  });
}

/** Fragment id for a group — Landing's rollup links here. */
export function subtaskGroupAnchor(id: SubtaskGroupId): string {
  return `subtasks-${id}`;
}

/**
 * Landing's one-line rollup. Each non-zero count links into the matching
 * group on the Subtasks tab so the two surfaces stay one click apart.
 *
 * @param taskId the task's URL segment (code or id, already URL-escaped) —
 *   see task-urls.
 */
export function hubRollupHtml(taskId: string, children: Task[], cluster?: Task): string {
  // A cluster says so even with nothing under it yet — the first thing an
  // operator does after creating one is open this page, and `lazy show` prints
  // the same 0/0 line. Both surfaces render the one derivation; neither may go
  // quiet where the other speaks.
  const clusterLine = cluster ? clusterProgressHtml(cluster, children) : '';
  if (children.length === 0) return clusterLine;
  const grouped = groupSubtasks(children);
  const parts: string[] = [];
  for (const spec of SUBTASK_GROUPS) {
    const group = grouped.find((g) => g.id === spec.id);
    const n = group?.tasks.length ?? 0;
    if (n === 0) continue;
    parts.push(
      `<a href="/tasks/${escapeHtml(taskId)}/subtasks#${subtaskGroupAnchor(spec.id)}">${escapeHtml(spec.rollup(n))}</a>`,
    );
  }
  const n = children.length;
  return (
    clusterLine +
    `<p class="lz-hub-rollup">` +
    `<a href="/tasks/${escapeHtml(taskId)}/subtasks">${n} subtask${n === 1 ? '' : 's'}</a>` +
    (parts.length ? `: ${parts.join(', ')}` : '') +
    `</p>`
  );
}

/**
 * The cluster's own progress line, above the generic subtask rollup: k of n
 * accepted, what is running, what it set aside. Empty for a task that is not a
 * `cluster` — the derivation (and that decision) lives in
 * src/task/cluster-progress.ts, so this surface and `lazy show` cannot disagree.
 */
export function clusterProgressHtml(task: Task, children: Task[]): string {
  const progress = clusterProgressOf(task, children);
  if (!progress) return '';
  return `<p class="lz-cluster-progress">Cluster: ${clusterProgressPartsHtml(progress).join(' · ')}</p>`;
}

/**
 * How many descendants each *direct* child has. `descendantCountById` must be
 * built over the WHOLE store so grandchildren (and deeper) count; a filtered
 * set would silently truncate. `Storage.countDescendants()` answers exactly
 * that, and `descendantCounts()` in src/task-target.ts is the same rule over an
 * in-memory task set.
 */
export function childSubtreeCounts(
  children: Task[],
  descendantCountById: Map<string, number>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const child of children) {
    out.set(child.id, descendantCountById.get(child.id) ?? 0);
  }
  return out;
}

export interface SubtasksSectionInput {
  parentId: string;
  children: Task[];
  /** Descendants-of-this-child, keyed by child id. Missing → 0. */
  subtreeCounts?: Map<string, number>;
}

/**
 * The Subtasks tab body. No cap, no pagination — a 301-row table is the
 * point. The filter box is progressive: hidden until the island unhides it,
 * so JS-off still shows every row.
 */
export function subtasksSectionHtml(input: SubtasksSectionInput): string {
  const { parentId, children } = input;
  if (children.length === 0) return '';

  // A code shared by two children must not name either of them in a URL —
  // derived from the rows rendered here, so the section stays dup-safe on its
  // own instead of relying on every caller to thread a set.
  const duplicated = duplicateTaskCodes(children.map((c) => ({ id: c.id, code: c.code })));

  const grouped = groupSubtasks(children);
  const counts = input.subtreeCounts ?? new Map<string, number>();
  const groupsHtml = grouped
    .filter((g) => g.tasks.length > 0)
    .map((g) => subtaskGroupHtml(parentId, g, counts, duplicated))
    .join('');

  return `
      <div class="lz-subtasks" data-lz-subtasks>
        <div class="lz-subtasks-heading">
          <h2>Subtasks (${children.length})</h2>
          <label class="lz-subtasks-filter" hidden>
            <span class="visually-hidden">Filter subtasks</span>
            <input type="search" placeholder="Filter" data-lz-subtasks-filter autocomplete="off">
          </label>
        </div>
        ${subtasksJumpBarHtml(grouped)}
        ${groupsHtml}
      </div>
      ${subtasksFilterScript()}
    `;
}

/**
 * Quick navigation: one link per non-empty group, sticky above the tables, so
 * a reader deep in a long Done list can reach Needs you without scrolling
 * back. Plain fragment links work JS-off; the island also opens a folded group.
 */
function subtasksJumpBarHtml(grouped: GroupedSubtasks[]): string {
  const links = grouped
    .filter((g) => g.tasks.length > 0)
    .map(
      (g) =>
        `<a class="lz-subtasks-jump" href="#${subtaskGroupAnchor(g.id)}" data-lz-subtasks-jump>${escapeHtml(g.title)} <span class="lz-subtasks-jump-count">${g.tasks.length}</span></a>`,
    )
    .join('');
  return `<nav class="lz-subtasks-nav" aria-label="Subtask groups">${links}</nav>`;
}

/** A header that sorts its group's table; `kind` says how its cells compare. */
function sortHeader(
  label: string,
  kind: 'text' | 'num',
  opts: { className?: string; title?: string; defaultDesc?: boolean } = {},
): string {
  const cls = opts.className ? ` class="${escapeHtml(opts.className)}"` : '';
  const title = opts.title ? ` title="${escapeHtml(opts.title)}"` : '';
  const aria = opts.defaultDesc ? ' aria-sort="descending"' : '';
  return `<th${cls}${title}${aria} data-lz-sort="${escapeHtml(kind)}"><button type="button" class="lz-subtasks-sort">${escapeHtml(label)}</button></th>`;
}

function subtaskGroupHtml(
  parentId: string,
  group: GroupedSubtasks,
  subtreeCounts: Map<string, number>,
  duplicated: ReadonlySet<string>,
): string {
  const rows = group.tasks.map((child) => subtaskRowHtml(child, subtreeCounts.get(child.id) ?? 0, duplicated)).join('');
  const open = group.collapsed ? '' : ' open';
  return `
      <details class="lz-subtasks-group" id="${subtaskGroupAnchor(group.id)}" data-lz-subtasks-group${open}>
        <summary class="lz-subtasks-summary">${escapeHtml(group.title)} (${group.tasks.length})</summary>
        <table class="table lz-subtasks-table">
          <thead>
            <tr>
              ${forgeColumnHeader()}
              ${sortHeader('Code', 'text')}
              ${sortHeader('Status', 'text')}
              ${sortHeader('Goal', 'text')}
              ${sortHeader('Nested', 'num', {
                className: 'lz-subtasks-subtree',
                title: 'Tasks nested under this one — its own subtasks, theirs, and so on',
              })}
              ${sortHeader('Updated', 'num', { defaultDesc: true })}
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </details>
    `;
}

function subtaskRowHtml(child: Task, subtreeCount: number, duplicated: ReadonlySet<string>): string {
  const label = displayId(child);
  const filterText = `${label} ${child.goal} ${child.status}`.toLowerCase();
  // How many tasks are nested under this child, and the link drills into THAT
  // child's Subtasks tab rather than expanding in place.
  //
  // Zero is a dash, not a link. It used to render "+0" and still link, on the
  // reasoning that an empty tab is an honest answer and the href stays one
  // shape — but the answer is already on this row, so the click could only ever
  // cost a page load to be told nothing is there. The engineer clicked a "+0",
  // waited, and landed on an empty tab; a column nobody can read is worse than
  // one column fewer.
  const childPath = taskPath(child, duplicated);
  const subtree = subtreeCount > 0
    ? `<a class="lz-subtasks-count" href="${childPath}/subtasks" title="Open the ${subtreeCount} task${subtreeCount === 1 ? '' : 's'} nested under this one">${subtreeCount}</a>`
    : `<span class="lz-subtasks-count lz-subtasks-count-none" title="Nothing is nested under this task">—</span>`;
  const when = subtaskUpdatedAt(child);
  const linked = formatLinkedMarker(child);
  const linkedHtml = linked ? `<span class="lz-linked">${escapeHtml(linked)}</span> ` : '';
  return `
      <tr data-lz-subtasks-row data-lz-key="subtask:${escapeHtml(child.id)}" data-filter="${escapeHtml(filterText)}">
        ${forgeColumnCell(child)}
        <td data-sort="${escapeHtml(label.toLowerCase())}"><a href="${childPath}">${escapeHtml(label)}</a></td>
        <td data-sort="${escapeHtml(child.status)}">${statusBadge(child.status)}</td>
        <td class="goal" data-sort="${escapeHtml(child.goal.toLowerCase())}">${linkedHtml}${escapeHtml(child.goal)}</td>
        <td class="lz-subtasks-subtree" data-sort="${subtreeCount}">${subtree}</td>
        <td class="lz-subtasks-when" data-sort="${when}" title="${escapeHtml(formatDate(when))}">${escapeHtml(ageLabel(when))}</td>
      </tr>
    `;
}

function forgeColumnHeader(): string {
  return `<th class="lz-forge-col" title="Pull or merge request"></th>`;
}

function forgeColumnCell(task: Task): string {
  const forge = resolveTaskForgeLink(task);
  return `<td class="lz-forge-col">${forge ? taskForgeIconHtml(forge) : ''}</td>`;
}

/**
 * Progressive filter: unhides the box and hides rows whose code/goal/status
 * do not contain the query. Groups with no visible rows hide too, so a
 * filter that matches one Done child does not leave four empty headers.
 *
 * A sortable header re-orders ITS group's rows by the cells' `data-sort`;
 * clicking it again flips the direction, and the choice survives live updates
 * (task-live-status.ts calls `lzRefreshSubtasksSort` after each morph). Clicks
 * are delegated from the root so groups a live update adds work too. A jump
 * link — hidden when the filter empties its group — — or an incoming
 * #subtasks-<group> fragment, which is how Landing's rollup arrives — opens a
 * folded group before scrolling to it.
 *
 * JS-off: the box stays hidden, every row stays visible in the server's
 * newest-first order, and the jump links are plain fragment links.
 */
function subtasksFilterScript(): string {
  return `<script>
(function () {
  var root = document.querySelector('[data-lz-subtasks]');
  if (!root) return;
  var box = root.querySelector('[data-lz-subtasks-filter]');
  var wrap = box && box.closest('.lz-subtasks-filter');
  if (!box || !wrap) return;
  wrap.hidden = false;
  function apply() {
    var q = (box.value || '').trim().toLowerCase();
    var rows = root.querySelectorAll('[data-lz-subtasks-row]');
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var hay = row.getAttribute('data-filter') || '';
      row.hidden = q !== '' && hay.indexOf(q) === -1;
    }
    var groups = root.querySelectorAll('[data-lz-subtasks-group]');
    for (var g = 0; g < groups.length; g++) {
      var group = groups[g];
      var visible = group.querySelectorAll('[data-lz-subtasks-row]:not([hidden])');
      group.hidden = visible.length === 0;
      // A jump link to a group the filter emptied would scroll to nothing.
      var jump = root.querySelector('[data-lz-subtasks-jump][href="#' + group.id + '"]');
      if (jump) jump.hidden = group.hidden;
    }
  }
  box.addEventListener('input', apply);

  // The reader's chosen sort per group id, so a live update — which rewrites
  // rows back into server order — can be followed by re-applying it.
  var sorts = {};

  function sortTable(table, col, desc) {
    var heads = table.tHead.rows[0].cells;
    var th = heads[col];
    if (!th) return;
    var numeric = th.getAttribute('data-lz-sort') === 'num';
    for (var m = 0; m < heads.length; m++) heads[m].removeAttribute('aria-sort');
    th.setAttribute('aria-sort', desc ? 'descending' : 'ascending');
    var tbody = table.tBodies[0];
    var rows = Array.prototype.slice.call(tbody.rows);
    rows.sort(function (a, b) {
      var x = a.cells[col].getAttribute('data-sort') || '';
      var y = b.cells[col].getAttribute('data-sort') || '';
      var c = numeric ? Number(x) - Number(y) : x.localeCompare(y);
      return desc ? -c : c;
    });
    for (var r = 0; r < rows.length; r++) tbody.appendChild(rows[r]);
  }

  window.lzRefreshSubtasksSort = function () {
    for (var id in sorts) {
      var group = document.getElementById(id);
      var table = group && group.querySelector('table');
      if (table) sortTable(table, sorts[id].col, sorts[id].desc);
    }
    if (box.value) apply();
  };

  function reveal(hash) {
    if (!hash || hash.indexOf('#subtasks-') !== 0) return;
    var target = document.getElementById(hash.slice(1));
    if (target && target.tagName === 'DETAILS') {
      target.open = true;
      target.scrollIntoView({ block: 'start' });
    }
  }

  // Delegated from the root, not bound per node: the tab is morphed in place
  // on live updates, and a group that appears later (Done, after the first
  // child lands) arrives as a fresh clone with no listeners of its own.
  root.addEventListener('click', function (ev) {
    var th = ev.target.closest && ev.target.closest('th[data-lz-sort]');
    if (th && root.contains(th)) {
      var table = th.closest('table');
      var col = Array.prototype.indexOf.call(th.parentNode.children, th);
      var current = th.getAttribute('aria-sort');
      // First click: numbers (Nested, Updated) biggest first, text A→Z.
      var desc = current ? current === 'ascending' : th.getAttribute('data-lz-sort') === 'num';
      sortTable(table, col, desc);
      var group = th.closest('[data-lz-subtasks-group]');
      if (group) sorts[group.id] = { col: col, desc: desc };
      return;
    }
    var jump = ev.target.closest && ev.target.closest('[data-lz-subtasks-jump]');
    if (jump && root.contains(jump)) {
      ev.preventDefault();
      var hash = jump.getAttribute('href');
      // Keep the entry's state: the tab switcher and dialogs read it.
      history.replaceState(history.state, '', hash);
      reveal(hash);
    }
  });
  reveal(location.hash);
})();
</script>`;
}

/** Compact "3m ago" for the Updated column — same buckets the review status bar uses. */
function ageLabel(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
