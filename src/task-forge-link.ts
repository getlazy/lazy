/**
 * A task's forge pull-request / merge-request link, from stored metadata only.
 *
 * WHY THIS EXISTS
 * GitHub and GitLab persist the URL (and number) on the task's metadata when
 * they publish or accept. Nothing in the web UI, `lazy show`, or MCP `lazy_show`
 * rendered it except a one-shot flash after accept. One resolver — no network,
 * never a forge API call on page render — so those three surfaces cannot
 * disagree about whether a task has a PR.
 *
 * Keys are what the drivers already write. The fallbacks (`remote_ref_url`,
 * `github_pr_url`) are the older spellings the GitHub driver still reads.
 */

import type { Task } from './types';
import { escapeHtml } from './server/escape';

export type TaskForgeKind = 'pr' | 'mr';
export type TaskForgeName = 'github' | 'gitlab';

export interface TaskForgeLink {
  url: string;
  kind: TaskForgeKind;
  forge: TaskForgeName;
  /** PR/MR number as a string, when the driver stored one. */
  id: string | null;
}

function stringMeta(metadata: Record<string, string> | null | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberFromUrl(url: string): string | null {
  const match = url.match(/\/(?:pull|merge_requests)\/(\d+)/);
  return match ? match[1] : null;
}

/**
 * This task's forge link, or null when none is stored.
 *
 * Reads metadata only. A missing URL is "no PR", not an error — local-driver
 * tasks never have one.
 */
export function resolveTaskForgeLink(task: Task): TaskForgeLink | null {
  const md = task.metadata;
  const ghUrl =
    stringMeta(md, 'github_remote_ref_url') ??
    stringMeta(md, 'remote_ref_url') ??
    stringMeta(md, 'github_pr_url');
  if (ghUrl) {
    const id =
      stringMeta(md, 'github_remote_ref_id') ??
      stringMeta(md, 'remote_ref_id') ??
      stringMeta(md, 'github_pr_number') ??
      numberFromUrl(ghUrl);
    return { url: ghUrl, kind: 'pr', forge: 'github', id: id ?? null };
  }

  const glUrl = stringMeta(md, 'gitlab_remote_ref_url');
  if (glUrl) {
    const id = stringMeta(md, 'gitlab_remote_ref_id') ?? numberFromUrl(glUrl);
    return { url: glUrl, kind: 'mr', forge: 'gitlab', id: id ?? null };
  }

  return null;
}

/** One-line label for the landing header and `lazy show`, e.g. `PR #412`. */
export function formatTaskForgeLink(link: TaskForgeLink): string {
  const kind = link.kind === 'mr' ? 'MR' : 'PR';
  if (link.id) return `${kind} #${link.id}`;
  return kind;
}

/** `lazy show` line: `PR: https://…` / `MR: https://…`. */
export function formatTaskForgeShowLine(link: TaskForgeLink): string {
  const kind = link.kind === 'mr' ? 'MR' : 'PR';
  return `${kind}: ${link.url}`;
}

// The dashboard's one escaper, for both positions. The two partial copies that
// used to live here escaped enough for the position each was written for and
// left `'` (attribute) or every quote (text) raw for the next call site.
const escapeAttr = escapeHtml;
const escapeText = escapeHtml;

/** Compact GitHub / GitLab mark for table columns. */
export function taskForgeIconSvg(forge: TaskForgeName): string {
  if (forge === 'gitlab') {
    return `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 21.2 16.7 7.1h-2.2L12 13.3 9.5 7.1H7.3L12 21.2zM4.6 7.1.9 18.3 12 21.2 4.6 7.1zm14.8 0-7.4 14.1 11.1-2.9-3.7-11.2z"/></svg>`;
  }
  return `<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>`;
}

/** Header field: `PR #412` linking out. */
export function taskForgeLinkHtml(link: TaskForgeLink): string {
  const label = formatTaskForgeLink(link);
  return `<a class="lz-forge-link" href="${escapeAttr(link.url)}" target="_blank" rel="noopener noreferrer">${escapeText(label)}</a>`;
}

/** Icon-only cell for task-list tables. */
export function taskForgeIconHtml(link: TaskForgeLink): string {
  const label = formatTaskForgeLink(link);
  return (
    `<a class="lz-forge-icon" href="${escapeAttr(link.url)}" target="_blank" rel="noopener noreferrer" title="${escapeAttr(label)}">` +
    `${taskForgeIconSvg(link.forge)}<span class="visually-hidden">${escapeText(label)}</span></a>`
  );
}
